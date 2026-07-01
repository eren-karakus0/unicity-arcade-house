import type { SphereAgent } from '../sphere-agent.js';
import { createLogger, type Logger } from '../logger.js';
import { commitHash, makeNonce } from './rng.js';
import { GAMES, type Outcome } from './games/index.js';

export interface GameDealerOptions {
  /** The house wallet — pays winners and holds the prize treasury. */
  agent: SphereAgent;
  /** Base UCT paid on a win (a game may multiply this, e.g. Lucky Number 5×). */
  baseRewardUct?: number;
  /** Mint more when the treasury drops below this (default 10). */
  minTreasuryUct?: number;
  /** Amount minted when topping up (default 50). */
  mintUct?: number;
  /** Unplayed rounds expire after this (default 2 min). */
  roundTtlMs?: number;
  /** Minimum gap between rounds from the same address (default 0.8s). */
  cooldownMs?: number;
  logger?: Logger;
}

interface Round {
  gameId: string;
  secret: string;
  nonce: string;
  commit: string;
  publicState?: Record<string, unknown>;
  createdAt: number;
}

export interface NewRound {
  game: string;
  roundId: string;
  commit: string;
  rewardUct: number;
  house: string;
  publicState?: Record<string, unknown>;
}

export interface PlayResult {
  game: string;
  roundId: string;
  outcome: Outcome;
  rewardUct: number;
  commit: string;
  secret: string;
  nonce: string;
  reveal: Record<string, unknown>;
  paid: boolean;
  payoutError?: string;
  txId?: string;
  txRef?: string;
  delivery?: string;
}

export interface LeaderRow {
  name: string;
  wins: number;
  losses: number;
  ties: number;
  played: number;
  earnedUct: number;
}

interface TxLike {
  id?: string;
  deliveryState?: string;
  tokenTransfers?: { requestIdHex?: string }[];
}

/**
 * GameDealer — an autonomous, provably-fair house for a hall of small games.
 *
 * For every game it commits sha256(secret:nonce) before the player acts, then
 * reveals so the client can verify the house couldn't change its hidden value.
 * On a win it pays the player real testnet UCT from the house wallet — a
 * genuine, on-chain, agent-initiated payout with no human in the loop.
 */
export class GameDealer {
  private readonly agent: SphereAgent;
  private readonly baseReward: number;
  private readonly minTreasury: number;
  private readonly mintAmount: number;
  private readonly ttl: number;
  private readonly cooldown: number;
  private readonly log: Logger;

  private readonly rounds = new Map<string, Round>();
  private readonly lastPlay = new Map<string, number>();
  private readonly board = new Map<string, LeaderRow>();
  private payLock: Promise<void> = Promise.resolve();

  constructor(opts: GameDealerOptions) {
    this.agent = opts.agent;
    this.baseReward = opts.baseRewardUct ?? 1;
    this.minTreasury = opts.minTreasuryUct ?? 10;
    this.mintAmount = opts.mintUct ?? 50;
    this.ttl = opts.roundTtlMs ?? 120_000;
    this.cooldown = opts.cooldownMs ?? 800;
    this.log = opts.logger ?? createLogger('dealer');
  }

  get house(): string {
    return this.agent.nametag;
  }
  get baseRewardUct(): number {
    return this.baseReward;
  }

  async start(): Promise<void> {
    await this.ensureTreasury();
    this.log.info(`arcade dealer ready — house @${this.house}, base reward ${this.baseReward} UCT/win`);
  }

  /** Deal a fresh round of `gameId`: pick + commit a secret, return the commitment. */
  newRound(gameId: string, playerAddress?: string): NewRound {
    const game = GAMES[gameId];
    if (!game) throw new Error(`Unknown game: ${gameId}`);
    this.sweep();
    if (playerAddress) {
      const last = this.lastPlay.get(playerAddress) ?? 0;
      if (Date.now() - last < this.cooldown) {
        throw new Error('Easy there — wait a moment before the next round.');
      }
    }
    const { secret, publicState } = game.deal();
    const nonce = makeNonce();
    const commit = commitHash(secret, nonce);
    const roundId = `${gameId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.rounds.set(roundId, { gameId, secret, nonce, commit, publicState, createdAt: Date.now() });
    return {
      game: gameId,
      roundId,
      commit,
      rewardUct: this.baseReward * game.rewardMult,
      house: this.house,
      ...(publicState ? { publicState } : {}),
    };
  }

  /** Reveal, judge, and (on a win) pay the player on-chain. */
  async play(input: {
    roundId: string;
    choice: unknown;
    playerAddress?: string;
    name?: string;
  }): Promise<PlayResult> {
    const round = this.rounds.get(input.roundId);
    if (!round) throw new Error('Round not found or already played — start a new one.');
    const game = GAMES[round.gameId];
    if (!game) throw new Error('Unknown game.');
    const resolved = game.resolveInput(input.choice); // throws on invalid input
    this.rounds.delete(input.roundId); // one-shot: a commitment is spent once

    const judged = game.judge(round.secret, resolved, round.publicState);
    const reward = this.baseReward * judged.rewardMult;
    const name = (input.name || input.playerAddress || 'anon').replace(/^@/, '').slice(0, 24);
    if (input.playerAddress) this.lastPlay.set(input.playerAddress, Date.now());

    let paid = false;
    let payoutError: string | undefined;
    let tx: TxLike | undefined;
    if (judged.outcome === 'win' && input.playerAddress) {
      try {
        tx = await this.payout(input.playerAddress, reward);
        paid = true;
      } catch (e) {
        payoutError = e instanceof Error ? e.message : 'payout failed';
        this.log.warn(`payout to ${input.playerAddress.slice(0, 16)}… failed: ${payoutError}`);
      }
    }
    this.record(name, judged.outcome, paid ? reward : 0);

    return {
      game: round.gameId,
      roundId: input.roundId,
      outcome: judged.outcome,
      rewardUct: reward,
      commit: round.commit,
      secret: round.secret,
      nonce: round.nonce,
      reveal: judged.reveal,
      paid,
      ...(payoutError ? { payoutError } : {}),
      ...(tx?.id ? { txId: tx.id } : {}),
      ...(tx?.tokenTransfers?.[0]?.requestIdHex ? { txRef: tx.tokenTransfers[0].requestIdHex } : {}),
      ...(tx?.deliveryState ? { delivery: tx.deliveryState } : {}),
    };
  }

  leaderboard(limit = 10): LeaderRow[] {
    return [...this.board.values()]
      .sort((a, b) => b.wins - a.wins || b.earnedUct - a.earnedUct || a.played - b.played)
      .slice(0, limit);
  }

  // ---- internals ----

  /** Serialize house sends so concurrent wins never race on coin selection. */
  private payout(address: string, amount: number): Promise<TxLike> {
    const run = this.payLock.then(async () => {
      await this.ensureTreasury();
      return (await this.agent.send(address, amount, 'arcade-win')) as unknown as TxLike;
    });
    this.payLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private record(name: string, outcome: Outcome, earned: number): void {
    const row = this.board.get(name) ?? { name, wins: 0, losses: 0, ties: 0, played: 0, earnedUct: 0 };
    row.played += 1;
    if (outcome === 'win') row.wins += 1;
    else if (outcome === 'lose') row.losses += 1;
    else row.ties += 1;
    row.earnedUct += earned;
    this.board.set(name, row);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, r] of this.rounds) {
      if (now - r.createdAt > this.ttl) this.rounds.delete(id);
    }
  }

  private async ensureTreasury(): Promise<void> {
    try {
      const balance = Number(await this.agent.balanceUct());
      if (balance < this.minTreasury) {
        this.log.info(`house treasury ${balance} UCT — minting ${this.mintAmount}`);
        await this.agent.mintUct(this.mintAmount);
      }
    } catch (e) {
      this.log.warn('treasury check failed', e instanceof Error ? e.message : e);
    }
  }
}

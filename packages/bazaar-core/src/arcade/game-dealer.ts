import type { SphereAgent } from '../sphere-agent.js';
import { createLogger, type Logger } from '../logger.js';
import { commitHash, deriveJackpotRoll, makeNonce } from './rng.js';
import { GAMES, type Outcome } from './games/index.js';
import {
  applyLoss,
  applyWin,
  dailyView,
  newPlayerState,
  todayKey,
  DAILY_GOAL,
  DAILY_REWARD,
  type DailyView,
  type PlayerState,
} from './events-logic.js';

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
  /** Progressive jackpot: starting pot (default 20 UCT). */
  jackpotSeedUct?: number;
  /** Pot growth per played round (default 1 UCT, capped). */
  jackpotGrowthUct?: number;
  /** Pot cap (default 100 UCT). */
  jackpotCapUct?: number;
  /** Hit odds — a derived roll of 0 out of this wins the pot (default 150). */
  jackpotOdds?: number;
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

export interface PlayerSnapshot {
  streak: number;
  best: number;
  daily: DailyView;
}

export interface NewRound {
  game: string;
  roundId: string;
  commit: string;
  rewardUct: number;
  house: string;
  /** The progressive-jackpot pot this round plays for. */
  jackpotUct: number;
  publicState?: Record<string, unknown>;
  you?: PlayerSnapshot;
}

/**
 * Per-round jackpot outcome. `roll` derives from the committed secret and the
 * player's input (see deriveJackpotRoll) so the browser can re-verify it; 0
 * hits and wins the whole pot.
 */
export interface JackpotResult {
  roll: number;
  threshold: number;
  hit: boolean;
  /** The pot this round played for (the amount paid on a hit). */
  potUct: number;
  /** The player's normalized input, echoed for browser-side verification. */
  input: string;
  paid?: boolean;
  txId?: string;
  delivery?: string;
  error?: string;
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
  /** Engagement layer. */
  streak: number;
  best: number;
  streakBonus: number;
  dailyBonus: number;
  daily: DailyView;
  jackpot: JackpotResult;
}

export interface LeaderRow {
  name: string;
  wins: number;
  losses: number;
  ties: number;
  played: number;
  earnedUct: number;
}

/** A public house-side event: a paid win, a jackpot, or the agent self-funding its treasury. */
export interface HouseEvent {
  kind: 'win' | 'mint' | 'jackpot';
  at: number;
  amountUct: number;
  name?: string;
  game?: string;
}

/** Live transparency stats for the autonomous house (since last restart). */
export interface HouseStats {
  /** Last known treasury balance in UCT (null until first read). */
  treasuryUct: number | null;
  paidOutUct: number;
  roundsPlayed: number;
  winsPaid: number;
  selfMintedUct: number;
  /** The current progressive-jackpot pot. */
  jackpotUct: number;
  /** Newest first, capped. */
  feed: HouseEvent[];
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
  private readonly jackpotSeed: number;
  private readonly jackpotGrowth: number;
  private readonly jackpotCap: number;
  private readonly jackpotOdds: number;
  private readonly log: Logger;

  private readonly rounds = new Map<string, Round>();
  private readonly lastPlay = new Map<string, number>();
  private readonly board = new Map<string, LeaderRow>();
  private readonly players = new Map<string, PlayerState>();
  private payLock: Promise<void> = Promise.resolve();

  // House transparency (since last restart).
  private paidOut = 0;
  private roundsPlayed = 0;
  private winsPaid = 0;
  private minted = 0;
  private feed: HouseEvent[] = [];
  private treasury: number | null = null;
  private treasuryAt = 0;
  private pot: number;

  constructor(opts: GameDealerOptions) {
    this.agent = opts.agent;
    this.baseReward = opts.baseRewardUct ?? 1;
    this.minTreasury = opts.minTreasuryUct ?? 10;
    this.mintAmount = opts.mintUct ?? 50;
    this.ttl = opts.roundTtlMs ?? 120_000;
    this.cooldown = opts.cooldownMs ?? 800;
    this.jackpotSeed = opts.jackpotSeedUct ?? 20;
    this.jackpotGrowth = opts.jackpotGrowthUct ?? 1;
    this.jackpotCap = opts.jackpotCapUct ?? 100;
    this.jackpotOdds = opts.jackpotOdds ?? 150;
    this.pot = this.jackpotSeed;
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
    const state = this.players.get(this.keyFor(playerAddress)) ?? newPlayerState();
    return {
      game: gameId,
      roundId,
      commit,
      rewardUct: this.baseReward * game.rewardMult,
      house: this.house,
      jackpotUct: this.pot,
      ...(publicState ? { publicState } : {}),
      you: { streak: state.streak, best: state.best, daily: dailyView(state, todayKey()) },
    };
  }

  /** The daily-challenge definition, for the game hall to display. */
  dailyInfo(): { goal: number; reward: number } {
    return { goal: DAILY_GOAL, reward: DAILY_REWARD };
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
    const name = (input.name || input.playerAddress || 'anon').replace(/^@/, '').slice(0, 24);
    if (input.playerAddress) this.lastPlay.set(input.playerAddress, Date.now());

    // Engagement layer: streaks + daily challenge.
    const key = this.keyFor(input.playerAddress);
    let state = this.players.get(key) ?? newPlayerState();
    let streakBonus = 0;
    let dailyBonus = 0;
    if (judged.outcome === 'win') {
      const upd = applyWin(state, todayKey());
      state = upd.state;
      streakBonus = upd.streakBonus;
      dailyBonus = upd.dailyBonus;
    } else if (judged.outcome === 'lose') {
      state = applyLoss(state);
    }
    this.players.set(key, state);

    const reward = this.baseReward * judged.rewardMult + streakBonus + dailyBonus;

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
    this.roundsPlayed += 1;
    if (paid) {
      this.paidOut += reward;
      this.winsPaid += 1;
      this.pushEvent({ kind: 'win', at: Date.now(), amountUct: reward, name, game: round.gameId });
    }

    // Progressive jackpot — every round rolls for the whole pot, win or lose.
    // The roll derives from the committed secret + the player's input, so it is
    // fixed before the reveal and verifiable in the browser.
    const jackpotInput = String(resolved);
    const jRoll = deriveJackpotRoll(round.secret, jackpotInput, this.jackpotOdds);
    let jackpot: JackpotResult = {
      roll: jRoll,
      threshold: this.jackpotOdds,
      hit: jRoll === 0,
      potUct: this.pot,
      input: jackpotInput,
    };
    if (jackpot.hit && input.playerAddress) {
      try {
        const jtx = await this.payout(input.playerAddress, jackpot.potUct, 'arcade-jackpot');
        jackpot = {
          ...jackpot,
          paid: true,
          ...(jtx.id ? { txId: jtx.id } : {}),
          ...(jtx.deliveryState ? { delivery: jtx.deliveryState } : {}),
        };
        this.paidOut += jackpot.potUct;
        this.pushEvent({ kind: 'jackpot', at: Date.now(), amountUct: jackpot.potUct, name, game: round.gameId });
        this.log.info(`JACKPOT — @${name} hit the ${jackpot.potUct} UCT pot`);
        this.pot = this.jackpotSeed;
      } catch (e) {
        jackpot = { ...jackpot, paid: false, error: e instanceof Error ? e.message : 'jackpot payout failed' };
        this.log.warn(`jackpot payout failed: ${jackpot.error}`);
      }
    } else if (jackpot.hit) {
      jackpot = { ...jackpot, paid: false, error: 'no wallet address to pay' };
    } else {
      this.pot = Math.min(this.jackpotCap, this.pot + this.jackpotGrowth);
    }

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
      streak: state.streak,
      best: state.best,
      streakBonus,
      dailyBonus,
      daily: dailyView(state, todayKey()),
      jackpot,
    };
  }

  private keyFor(address?: string): string {
    return address ?? 'anon';
  }

  leaderboard(limit = 10): LeaderRow[] {
    return [...this.board.values()]
      .sort((a, b) => b.wins - a.wins || b.earnedUct - a.earnedUct || a.played - b.played)
      .slice(0, limit);
  }

  /**
   * Live house transparency: real treasury balance (refreshed at most every
   * 15s), totals, and the recent win/self-mint feed.
   */
  async houseStats(): Promise<HouseStats> {
    const now = Date.now();
    if (now - this.treasuryAt > 15_000) {
      try {
        this.treasury = Number(await this.agent.balanceUct());
        this.treasuryAt = now;
      } catch {
        /* keep the last known balance */
      }
    }
    return {
      treasuryUct: this.treasury,
      paidOutUct: this.paidOut,
      roundsPlayed: this.roundsPlayed,
      winsPaid: this.winsPaid,
      selfMintedUct: this.minted,
      jackpotUct: this.pot,
      feed: this.feed.slice(0, 12),
    };
  }

  // ---- internals ----

  /** Serialize house sends so concurrent wins never race on coin selection. */
  private payout(address: string, amount: number, memo = 'arcade-win'): Promise<TxLike> {
    const run = this.payLock.then(async () => {
      await this.ensureTreasuryFor(amount);
      return (await this.agent.send(address, amount, memo)) as unknown as TxLike;
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

  private pushEvent(e: HouseEvent): void {
    this.feed.unshift(e);
    if (this.feed.length > 24) this.feed.length = 24;
  }

  private ensureTreasury(): Promise<void> {
    return this.ensureTreasuryFor(0);
  }

  /** Top the treasury up so it can cover `amount` (e.g. a big jackpot pot). */
  private async ensureTreasuryFor(amount: number): Promise<void> {
    try {
      const balance = Number(await this.agent.balanceUct());
      this.treasury = balance;
      this.treasuryAt = Date.now();
      const floor = Math.max(this.minTreasury, amount + 2);
      if (balance < floor) {
        const mint = Math.max(this.mintAmount, Math.ceil(amount + 10 - balance));
        this.log.info(`house treasury ${balance} UCT — minting ${mint}`);
        await this.agent.mintUct(mint);
        this.minted += mint;
        this.pushEvent({ kind: 'mint', at: Date.now(), amountUct: mint });
      }
    } catch (e) {
      this.log.warn('treasury check failed', e instanceof Error ? e.message : e);
    }
  }
}

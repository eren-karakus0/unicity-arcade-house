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
  welcomeGrant,
  DAILY_GOAL,
  DAILY_REWARD,
  type DailyView,
  type PlayerState,
} from './events-logic.js';
import {
  catalogView,
  newlyUnlocked,
  statsOf,
  type AchievementView,
} from './achievements.js';
import { Tournament, type TournamentView } from './tournament.js';

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
  /** Tournament window length (default 1h). */
  tournamentLengthMs?: number;
  /** UCT prize paid on-chain to each window's champion (default 25). */
  tournamentPrizeUct?: number;
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
  /** Chip balance (bets are staked from it; cash-out pays it 1:1 in UCT). */
  chips: number;
  /** Chips granted by today's top-up in this call (0 when already topped up). */
  chipsGranted: number;
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
  /** Chips credited this round (win: bet × multiplier + bonuses; tie: the bet back). */
  rewardUct: number;
  /** The chips staked on this round. */
  bet: number;
  /** The player's chip balance after the round. */
  chips: number;
  commit: string;
  secret: string;
  nonce: string;
  reveal: Record<string, unknown>;
  /** Engagement layer. */
  streak: number;
  best: number;
  streakBonus: number;
  dailyBonus: number;
  daily: DailyView;
  jackpot: JackpotResult;
  /** Achievements newly unlocked by this round (for a one-time reveal). */
  achievements: AchievementView[];
  /** UCT credited from those achievements' one-time rewards. */
  achievementBonus: number;
}

/** Background on-chain payout state, pollable per round. */
export interface Settlement {
  status: 'pending' | 'landed' | 'failed';
  amountUct: number;
  txId?: string;
  delivery?: string;
  error?: string;
  at: number;
}

export interface LeaderRow {
  name: string;
  wins: number;
  losses: number;
  ties: number;
  played: number;
  earnedUct: number;
}

/** A public house-side event: a deposit, an on-chain cash-out, a jackpot, a tournament prize, or a treasury self-mint. */
export interface HouseEvent {
  kind: 'win' | 'mint' | 'jackpot' | 'cashout' | 'deposit' | 'tournament';
  at: number;
  amountUct: number;
  name?: string;
  game?: string;
}

/**
 * The minimal shape of an incoming transfer we credit as a deposit — matches
 * the wallet's RECEIVED history entries (the reliable observation point for
 * wallet-api deliveries).
 */
export interface DepositRecord {
  /** Stable dedup key (the history entry's dedupKey) — crediting is idempotent per id. */
  id: string;
  /** Amount in the coin's base units, as a positive integer string. */
  amountBase: string;
  senderPubkey?: string;
  senderNametag?: string;
  memo?: string;
}

/** Live transparency stats for the autonomous house (since last restart). */
export interface HouseStats {
  /** Last known treasury balance in UCT (null until first read). */
  treasuryUct: number | null;
  paidOutUct: number;
  roundsPlayed: number;
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
  private minted = 0;
  private feed: HouseEvent[] = [];
  private treasury: number | null = null;
  private treasuryAt = 0;
  private pot: number;
  private readonly settlements = new Map<string, Settlement>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly tourney: Tournament;

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
    this.tourney = new Tournament({
      ...(opts.tournamentLengthMs !== undefined ? { lengthMs: opts.tournamentLengthMs } : {}),
      ...(opts.tournamentPrizeUct !== undefined ? { prizeUct: opts.tournamentPrizeUct } : {}),
    });
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
    this.settleTournament(Date.now());
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
    // One-time welcome stake so a fresh wallet can try the games; after this,
    // the balance moves only via deposits, bets, and withdrawals.
    const key = this.keyFor(playerAddress);
    const day = todayKey();
    const welcomed = welcomeGrant(this.players.get(key) ?? newPlayerState());
    this.players.set(key, welcomed.state);
    const state = welcomed.state;
    const granted = welcomed.granted;
    return {
      game: gameId,
      roundId,
      commit,
      rewardUct: this.baseReward * game.rewardMult,
      house: this.house,
      jackpotUct: this.pot,
      ...(publicState ? { publicState } : {}),
      you: {
        streak: state.streak,
        best: state.best,
        daily: dailyView(state, day),
        chips: state.chips,
        chipsGranted: granted,
      },
    };
  }

  /** The daily-challenge definition, for the game hall to display. */
  dailyInfo(): { goal: number; reward: number } {
    return { goal: DAILY_GOAL, reward: DAILY_REWARD };
  }

  /** Reveal, judge, and settle the bet in chips (jackpots settle on-chain). */
  async play(input: {
    roundId: string;
    choice: unknown;
    bet?: unknown;
    playerAddress?: string;
    name?: string;
  }): Promise<PlayResult> {
    const round = this.rounds.get(input.roundId);
    if (!round) throw new Error('Round not found or already played — start a new one.');
    const game = GAMES[round.gameId];
    if (!game) throw new Error('Unknown game.');
    const resolved = game.resolveInput(input.choice); // throws on invalid input

    // The bet is staked from the player's balance — validate before the round
    // is spent. Any size goes, as long as the balance covers it.
    const bet = Math.floor(Number(input.bet ?? 1));
    if (!Number.isSafeInteger(bet) || bet < 1) throw new Error('Bet must be a whole number of UCT (1+).');
    const key = this.keyFor(input.playerAddress);
    let state = welcomeGrant(this.players.get(key) ?? newPlayerState()).state;
    if (state.chips < bet) {
      throw new Error(`Not enough UCT — you have ${state.chips}. Deposit from your wallet to keep playing.`);
    }
    this.rounds.delete(input.roundId); // one-shot: a commitment is spent once

    const judged = game.judge(round.secret, resolved, round.publicState);
    const name = (input.name || input.playerAddress || 'anon').replace(/^@/, '').slice(0, 24);
    if (input.playerAddress) this.lastPlay.set(input.playerAddress, Date.now());

    // Settle the bet by outcome (total-return multipliers) + engagement bonuses.
    state = { ...state, chips: state.chips - bet };
    let streakBonus = 0;
    let dailyBonus = 0;
    let reward = 0; // chips credited this round
    if (judged.outcome === 'win') {
      const upd = applyWin(state, todayKey());
      state = upd.state;
      streakBonus = upd.streakBonus;
      dailyBonus = upd.dailyBonus;
      reward = bet * judged.rewardMult + streakBonus + dailyBonus;
      state = { ...state, chips: state.chips + reward };
    } else if (judged.outcome === 'tie') {
      reward = bet; // push — the bet comes back
      state = { ...state, chips: state.chips + bet };
    } else {
      state = applyLoss(state); // the bet sinks to the house
    }

    this.record(name, judged.outcome);
    if (judged.outcome === 'win') this.creditEarned(name, reward);
    this.roundsPlayed += 1;

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
      this.log.info(`JACKPOT — @${name} hit the ${jackpot.potUct} UCT pot`);
      this.enqueueSettlement(
        `${input.roundId}:jackpot`,
        input.playerAddress,
        jackpot.potUct,
        'arcade-jackpot',
        name,
        round.gameId,
      );
      this.pot = this.jackpotSeed; // optimistic — restored if the payout fails
    } else if (jackpot.hit) {
      jackpot = { ...jackpot, paid: false, error: 'no wallet address to pay' };
    } else {
      this.pot = Math.min(this.jackpotCap, this.pot + this.jackpotGrowth);
    }

    // Lifetime tallies feed achievements (and the tournament board).
    state = {
      ...state,
      plays: state.plays + 1,
      games: state.games.includes(round.gameId) ? state.games : [...state.games, round.gameId],
      wins: judged.outcome === 'win' ? state.wins + 1 : state.wins,
      totalWon: judged.outcome === 'win' ? state.totalWon + reward : state.totalWon,
      biggestWin: judged.outcome === 'win' && reward > state.biggestWin ? reward : state.biggestWin,
      jackpots: jackpot.hit ? state.jackpots + 1 : state.jackpots,
    };
    // Award any freshly-earned achievements once; their rewards credit balance.
    const { fresh, unlocked } = newlyUnlocked(statsOf(state), state.unlocked);
    const achievementBonus = fresh.reduce((sum, a) => sum + a.reward, 0);
    state = { ...state, unlocked, chips: state.chips + achievementBonus };
    this.players.set(key, state);

    // Tournament: net winnings (payout minus stake) race the current window.
    this.settleTournament(Date.now());
    if (judged.outcome === 'win') {
      this.tourney.record(key, name, input.playerAddress, reward - bet);
    }
    const achievements: AchievementView[] = fresh.map((a) => ({
      id: a.id,
      title: a.title,
      detail: a.detail,
      icon: a.icon,
      reward: a.reward,
      unlocked: true,
    }));

    return {
      game: round.gameId,
      roundId: input.roundId,
      outcome: judged.outcome,
      rewardUct: reward,
      bet,
      chips: state.chips,
      commit: round.commit,
      secret: round.secret,
      nonce: round.nonce,
      reveal: judged.reveal,
      streak: state.streak,
      best: state.best,
      streakBonus,
      dailyBonus,
      daily: dailyView(state, todayKey()),
      jackpot,
      achievements,
      achievementBonus,
    };
  }

  /** The full achievement catalog annotated with what this player has unlocked. */
  achievementsOf(address?: string): AchievementView[] {
    const state = address ? this.players.get(this.keyFor(address)) : undefined;
    return catalogView(state?.unlocked ?? []);
  }

  /** The live tournament: countdown, current standings, and past champions. */
  tournamentView(): TournamentView {
    const now = Date.now();
    this.settleTournament(now);
    return this.tourney.view(now);
  }

  /** Close any elapsed tournament windows and pay each champion on-chain. */
  private settleTournament(now: number): void {
    for (const c of this.tourney.maybeRoll(now)) {
      this.log.info(`TOURNAMENT — @${c.name} took the ${c.prize} UCT prize (score ${c.score})`);
      this.enqueueSettlement(`tourney-${c.at}`, c.address, c.prize, 'arcade-tournament', c.name, 'tournament');
    }
  }

  /** The player's in-house UCT balance. */
  balanceOf(address: string): { balanceUct: number } {
    const state = this.players.get(this.keyFor(address));
    return { balanceUct: state?.chips ?? 0 };
  }

  /** Where and what to send for a wallet deposit (used to build the send-intent). */
  depositInfo(): { to: string; coinId: string; decimals: number; symbol: string } {
    const { coinId, decimals } = this.agent.uctCoin;
    return { to: `@${this.house.replace(/^@/, '')}`, coinId, decimals, symbol: 'UCT' };
  }

  private readonly seenDeposits = new Set<string>();

  /**
   * Credit an incoming transfer to the sender's in-house balance.
   * Matched by the sender's chain pubkey (the dashboard's canonical player
   * key), falling back to the sender's nametag. Idempotent per transfer id.
   */
  creditDeposit(t: DepositRecord): { credited: number; key: string } | null {
    if (!t?.id || this.seenDeposits.has(t.id)) return null;
    this.seenDeposits.add(t.id);
    if (this.seenDeposits.size > 2000) {
      const first = this.seenDeposits.values().next().value as string | undefined;
      if (first !== undefined) this.seenDeposits.delete(first);
    }
    let total = 0n;
    try {
      total = BigInt(t.amountBase || '0');
    } catch {
      return null;
    }
    if (total <= 0n) return null;
    const amount = Math.floor(Number(this.agent.toHuman(total)));
    if (amount < 1) return null;

    // Match the depositor to a player key: pubkey first, then nametag forms.
    const candidates = [
      t.senderPubkey,
      t.senderNametag ? `@${t.senderNametag.replace(/^@/, '')}` : undefined,
      t.senderNametag?.replace(/^@/, ''),
    ].filter((c): c is string => !!c);
    const key = candidates.find((c) => this.players.has(c)) ?? candidates[0];
    if (!key) return null; // no sender identity at all — nothing to credit

    const state = this.players.get(key) ?? newPlayerState();
    this.players.set(key, { ...state, chips: state.chips + amount });
    const name = (t.senderNametag ?? t.senderPubkey ?? key).replace(/^@/, '').slice(0, 24);
    this.pushEvent({ kind: 'deposit', at: Date.now(), amountUct: amount, name });
    this.log.info(`deposit credited: +${amount} UCT from @${name}`);
    return { credited: amount, key };
  }

  /** Withdraw the player's balance 1:1 as real UCT, settled on-chain by the house. */
  cashOut(address: string, name?: string): { settlementId: string; amountUct: number } {
    const key = this.keyFor(address);
    const state = this.players.get(key) ?? newPlayerState();
    const amount = state.chips;
    if (amount < 1) throw new Error('Withdraw needs at least 1 UCT.');
    this.players.set(key, { ...state, chips: 0 });
    const cleanName = (name || address).replace(/^@/, '').slice(0, 24);
    const settlementId = `cashout-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.enqueueSettlement(settlementId, address, amount, 'arcade-cashout', cleanName, 'cashout', () => {
      // failed send → the chips come back
      const cur = this.players.get(key) ?? newPlayerState();
      this.players.set(key, { ...cur, chips: cur.chips + amount });
    });
    return { settlementId, amountUct: amount };
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

  private record(name: string, outcome: Outcome): void {
    const row = this.board.get(name) ?? { name, wins: 0, losses: 0, ties: 0, played: 0, earnedUct: 0 };
    row.played += 1;
    if (outcome === 'win') row.wins += 1;
    else if (outcome === 'lose') row.losses += 1;
    else row.ties += 1;
    this.board.set(name, row);
  }

  private creditEarned(name: string, amount: number): void {
    const row = this.board.get(name);
    if (row) {
      row.earnedUct += amount;
      this.board.set(name, row);
    }
  }

  /**
   * Queue an on-chain payout and expose its progress via settlementFor().
   * Totals, feed events and leaderboard earnings only move once the transfer
   * really lands — no cosmetic numbers.
   */
  private enqueueSettlement(
    key: string,
    address: string,
    amount: number,
    memo: string,
    name: string,
    game: string,
    onFail?: () => void,
  ): void {
    this.settlements.set(key, { status: 'pending', amountUct: amount, at: Date.now() });
    const run = (async () => {
      try {
        const tx = await this.payout(address, amount, memo);
        this.settlements.set(key, {
          status: 'landed',
          amountUct: amount,
          at: Date.now(),
          ...(tx.id ? { txId: tx.id } : {}),
          ...(tx.deliveryState ? { delivery: tx.deliveryState } : {}),
        });
        this.paidOut += amount;
        const kind: HouseEvent['kind'] =
          memo === 'arcade-jackpot'
            ? 'jackpot'
            : memo === 'arcade-cashout'
              ? 'cashout'
              : memo === 'arcade-tournament'
                ? 'tournament'
                : 'win';
        this.pushEvent({ kind, at: Date.now(), amountUct: amount, name, game });
      } catch (e) {
        const error = e instanceof Error ? e.message : 'payout failed';
        this.settlements.set(key, { status: 'failed', amountUct: amount, error, at: Date.now() });
        this.log.warn(`settlement ${key} failed: ${error}`);
        // A failed jackpot payout puts the pot back.
        if (memo === 'arcade-jackpot') this.pot = Math.min(this.jackpotCap, this.pot + amount);
        onFail?.();
      }
      this.pruneSettlements();
    })();
    this.inFlight.add(run);
    void run.finally(() => this.inFlight.delete(run));
  }

  /** A round's background payout state (win payout + jackpot payout, if any). */
  settlementFor(roundId: string): { win?: Settlement; jackpot?: Settlement } {
    const win = this.settlements.get(roundId);
    const jackpot = this.settlements.get(`${roundId}:jackpot`);
    return { ...(win ? { win } : {}), ...(jackpot ? { jackpot } : {}) };
  }

  /** Wait for every queued payout to finish (used by tests). */
  async flushPayouts(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  private pruneSettlements(): void {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [k, s] of this.settlements) {
      if (s.at < cutoff) this.settlements.delete(k);
    }
    while (this.settlements.size > 400) {
      const oldest = this.settlements.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.settlements.delete(oldest);
    }
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

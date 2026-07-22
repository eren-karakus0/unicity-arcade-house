import type { SphereAgent } from '../sphere-agent.js';
import { createLogger, type Logger } from '../logger.js';
import { commitHash, deriveJackpotRoll, makeNonce } from './rng.js';
import { GAMES, type Judged, type Outcome } from './games/index.js';
import { bjJudge, bjStart, bjStep, bjView, type BjAction, type BjHand } from './games/blackjack.js';
import {
  applyLoss,
  applyProgress,
  applyWin,
  dailyView,
  newPlayerState,
  progressView,
  todayKey,
  welcomeGrant,
  DAILY_GOAL,
  DAILY_REWARD,
  type DailyView,
  type PlayerState,
  type ProgressView,
} from './events-logic.js';
import {
  catalogView,
  newlyUnlocked,
  statsOf,
  type AchievementView,
} from './achievements.js';
import { Tournament, type TournamentView, type TournamentSnapshot } from './tournament.js';
import { referralCode, normalizeCode, REFERRAL_BONUS_UCT, REFERRAL_WELCOME_UCT } from './referral.js';

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

/**
 * A MULTI-STEP table round (blackjack): the bet is staked at the deal and the
 * hand advances via /step until done, when it settles through the exact same
 * pipeline as every one-shot game. Persisted (small + bounded by TTL) so a
 * restart can't eat a staked hand; expiry refunds the stake.
 */
export interface TableRound {
  gameId: 'blackjack';
  secret: string;
  nonce: string;
  commit: string;
  createdAt: number;
  key: string;
  playerAddress?: string;
  name?: string;
  /** Total staked so far (doubles bump it). */
  bet: number;
  /** Player actions taken, in order (feeds the jackpot input). */
  actions: BjAction[];
  hand: BjHand;
}

/** What the table returns mid-hand (or alongside the final PlayResult). */
export interface TableView {
  game: string;
  roundId: string;
  commit: string;
  bet: number;
  jackpotUct: number;
  hand: ReturnType<typeof bjView>;
  you?: PlayerSnapshot;
  /** Present once the hand is over — the standard settled result. */
  result?: PlayResult;
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
  /** Set once, when this round applied a valid referral for a new player. */
  referral?: { welcomeBonus: number };
  /** Retention spine: XP gained this round + the player's live progress. */
  xpGained: number;
  progress: ProgressView;
  /** Whole chips credited from rakeback accrual this round (losses only). */
  rakeCredited: number;
  /** Set when this round crossed a tier boundary (one-time chips bonus). */
  levelUp?: { tier: string; bonus: number };
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

/** A player's consolidated profile (stats + achievements + invite). */
export interface PlayerProfile {
  balanceUct: number;
  streak: number;
  best: number;
  wins: number;
  plays: number;
  totalWon: number;
  biggestWin: number;
  jackpots: number;
  gamesPlayed: number;
  totalGames: number;
  daily: DailyView;
  achievements: AchievementView[];
  referral: { code: string | null; referrals: number; referred: boolean };
  /** XP, tier, next-tier threshold and live rakeback rate. */
  progress: ProgressView;
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
  /** Tournament prizes crowned but awaiting on-chain confirmation (retried on boot). */
  pendingPrizes: { name: string; amountUct: number; tries: number; lastError?: string }[];
}

/**
 * A tournament prize that has been crowned but not yet confirmed paid on-chain.
 * Persisted so a champion is still paid across a restart — the free-tier host
 * can sleep at the 15-min window boundary, exactly when a window closes, and a
 * plain fire-and-forget send would be lost. retryPendingPrizes() re-attempts it
 * on boot. Delivery is at-least-once: a prize that landed but was not yet
 * persisted as removed could pay twice — an acceptable testnet trade against
 * never paying at all.
 */
export interface PendingPrize {
  /** Stable id = `tourney-<windowCloseMs>`; dedups the crown and every retry. */
  id: string;
  address: string;
  amount: number;
  name: string;
  at: number;
  tries: number;
  lastError?: string;
}

/**
 * Durable house state — everything that must survive a restart: player balances
 * and stats, the leaderboard, referral graph, the seen-deposit set (so deposits
 * are not re-credited), the jackpot pot, house tallies, the tournament, and any
 * tournament prizes still owed on-chain. Transient state (open rounds,
 * cooldowns, in-flight payouts) is left out; on-chain settlement is the source
 * of truth for those.
 */
export interface DealerSnapshot {
  players: [string, PlayerState][];
  board: [string, LeaderRow][];
  referralCodes: [string, string][];
  seenDeposits: string[];
  pot: number;
  paidOut: number;
  roundsPlayed: number;
  minted: number;
  feed: HouseEvent[];
  tournament: TournamentSnapshot;
  /** Tournament prizes owed but not yet confirmed on-chain (retried on boot). */
  pendingPrizes: PendingPrize[];
  /** Open multi-step table hands (staked - must survive a restart). */
  tables?: [string, TableRound][];
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
/**
 * Hard ceiling on a single round's bet (UCT). Bets are otherwise free-form,
 * but without this cap one huge bet on a high-multiplier game (limbo/crash pay
 * up to ×1000) pushes chip balances past Number.MAX_SAFE_INTEGER, where every
 * +/- silently loses integer precision and the house mints unbounded UCT to
 * cover the corrupted balance. Keeps all chip accounting exact in JS integers.
 */
const MAX_BET = 100_000;

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
  /** Open multi-step table hands (blackjack), keyed by roundId. */
  private readonly tables = new Map<string, TableRound>();
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
  /** referral code → player key, so a referee's code resolves to the referrer. */
  private readonly referralCodes = new Map<string, string>();
  /** Tournament prizes owed on-chain, keyed by prize id — durable + retried on boot. */
  private readonly pendingPrizes = new Map<string, PendingPrize>();
  /** Prize ids with a send in flight, so a retry never double-enqueues. */
  private readonly payingPrizes = new Set<string>();

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
    if (playerAddress) this.referralCodes.set(referralCode(key), key); // resolvable once seen
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
    /** Referral code captured from the invite link, applied on the first play. */
    ref?: unknown;
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
    if (bet > MAX_BET) throw new Error(`Table limit is ${MAX_BET.toLocaleString()} UCT per round.`);
    const key = this.keyFor(input.playerAddress);
    const state = welcomeGrant(this.players.get(key) ?? newPlayerState()).state;
    if (state.chips < bet) {
      throw new Error(`Not enough UCT — you have ${state.chips}. Deposit from your wallet to keep playing.`);
    }
    this.rounds.delete(input.roundId); // one-shot: a commitment is spent once

    const judged = game.judge(round.secret, resolved, round.publicState);
    return this.settleJudged({
      roundId: input.roundId,
      gameId: round.gameId,
      secret: round.secret,
      nonce: round.nonce,
      commit: round.commit,
      judged,
      bet,
      jackpotInput: String(resolved),
      playerAddress: input.playerAddress,
      name: input.name,
      ref: input.ref,
    });
  }

  /**
   * The single settle path every round ends in — one-shot plays and finished
   * table hands alike: stake the bet, apply the outcome + engagement bonuses,
   * roll the jackpot, feed achievements/tournament/XP, and shape the result.
   */
  private settleJudged(args: {
    roundId: string;
    gameId: string;
    secret: string;
    nonce: string;
    commit: string;
    judged: Judged;
    bet: number;
    jackpotInput: string;
    playerAddress?: string | undefined;
    name?: string | undefined;
    ref?: unknown;
  }): PlayResult {
    const { judged, bet } = args;
    const key = this.keyFor(args.playerAddress);
    let state = welcomeGrant(this.players.get(key) ?? newPlayerState()).state;
    const name = (args.name || args.playerAddress || 'anon').replace(/^@/, '').slice(0, 24);
    if (args.playerAddress) this.lastPlay.set(args.playerAddress, Date.now());

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
      reward = Math.floor(bet * judged.rewardMult) + streakBonus + dailyBonus;
      state = { ...state, chips: state.chips + reward };
    } else if (judged.outcome === 'tie') {
      reward = bet; // push — the bet comes back
      state = { ...state, chips: state.chips + bet };
    } else {
      state = applyLoss(state); // the bet sinks to the house
    }

    this.record(name, judged.outcome);
    if (judged.outcome === 'win') this.creditEarned(name, reward);
    // Notable chip wins join the public house feed (the live ticker) —
    // bounded, threshold keeps the strip interesting without spamming it.
    if (judged.outcome === 'win' && reward >= 10) {
      this.pushEvent({ kind: 'win', at: Date.now(), amountUct: reward, name, game: args.gameId });
    }
    this.roundsPlayed += 1;

    // Progressive jackpot — every round rolls for the whole pot, win or lose.
    // The roll derives from the committed secret + the player's input, so it is
    // fixed before the reveal and verifiable in the browser.
    const jackpotInput = args.jackpotInput;
    const jRoll = deriveJackpotRoll(args.secret, jackpotInput, this.jackpotOdds);
    let jackpot: JackpotResult = {
      roll: jRoll,
      threshold: this.jackpotOdds,
      hit: jRoll === 0,
      potUct: this.pot,
      input: jackpotInput,
    };
    if (jackpot.hit && args.playerAddress) {
      this.log.info(`JACKPOT — @${name} hit the ${jackpot.potUct} UCT pot`);
      this.enqueueSettlement(
        `${args.roundId}:jackpot`,
        args.playerAddress,
        jackpot.potUct,
        'arcade-jackpot',
        name,
        args.gameId,
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
      games: state.games.includes(args.gameId) ? state.games : [...state.games, args.gameId],
      wins: judged.outcome === 'win' ? state.wins + 1 : state.wins,
      totalWon: judged.outcome === 'win' ? state.totalWon + reward : state.totalWon,
      biggestWin: judged.outcome === 'win' && reward > state.biggestWin ? reward : state.biggestWin,
      jackpots: jackpot.hit ? state.jackpots + 1 : state.jackpots,
    };
    // Award any freshly-earned achievements once; their rewards credit balance.
    const { fresh, unlocked } = newlyUnlocked(statsOf(state), state.unlocked);
    const achievementBonus = fresh.reduce((sum, a) => sum + a.reward, 0);
    state = { ...state, unlocked, chips: state.chips + achievementBonus };
    // Retention spine: XP (log-scaled), tier rakeback on losses, level-up bonus.
    const prog = applyProgress(state, bet, judged.outcome);
    state = prog.state;
    this.players.set(key, state);

    // Tournament: net winnings (payout minus stake) race the current window.
    this.settleTournament(Date.now());
    if (judged.outcome === 'win') {
      this.tourney.record(key, name, args.playerAddress, reward - bet);
    }

    // Referral: on this player's first play, credit both sides once. Guarded by
    // referredBy so it never repeats; no self-referral; referrer must exist.
    let referral: PlayResult['referral'];
    const refCode = normalizeCode(args.ref);
    if (refCode && state.referredBy === undefined) {
      const referrerKey = this.referralCodes.get(refCode);
      if (referrerKey && referrerKey !== key && this.players.has(referrerKey)) {
        state = { ...state, referredBy: referrerKey, chips: state.chips + REFERRAL_WELCOME_UCT };
        this.players.set(key, state);
        const refState = this.players.get(referrerKey)!;
        this.players.set(referrerKey, {
          ...refState,
          chips: refState.chips + REFERRAL_BONUS_UCT,
          referrals: refState.referrals + 1,
        });
        referral = { welcomeBonus: REFERRAL_WELCOME_UCT };
        this.log.info(`referral: @${name} joined via ${refCode} — +${REFERRAL_BONUS_UCT} UCT to the referrer`);
      }
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
      game: args.gameId,
      roundId: args.roundId,
      outcome: judged.outcome,
      rewardUct: reward,
      bet,
      chips: state.chips,
      commit: args.commit,
      secret: args.secret,
      nonce: args.nonce,
      reveal: judged.reveal,
      streak: state.streak,
      best: state.best,
      streakBonus,
      dailyBonus,
      daily: dailyView(state, todayKey()),
      jackpot,
      achievements,
      achievementBonus,
      ...(referral ? { referral } : {}),
      xpGained: prog.xpGained,
      progress: progressView(state),
      rakeCredited: prog.rakeCredited,
      ...(prog.levelUp ? { levelUp: prog.levelUp } : {}),
    };
  }

  // ---- multi-step tables (blackjack) ----

  /**
   * Open a blackjack hand: stake the bet, commit the deck seed, deal. The
   * whole shoe derives from the committed secret, so it was fixed before the
   * first card showed. A natural on either side settles immediately.
   */
  newTable(gameId: string, playerAddress: string | undefined, betRaw: unknown, name?: string): TableView {
    if (gameId !== 'blackjack') throw new Error(`Unknown table game: ${gameId}`);
    this.sweep();
    this.settleTournament(Date.now());
    if (playerAddress) {
      const last = this.lastPlay.get(playerAddress) ?? 0;
      if (Date.now() - last < this.cooldown) {
        throw new Error('Easy there — wait a moment before the next hand.');
      }
    }
    const bet = Math.floor(Number(betRaw ?? 1));
    if (!Number.isSafeInteger(bet) || bet < 1) throw new Error('Bet must be a whole number of UCT (1+).');
    if (bet > MAX_BET) throw new Error(`Table limit is ${MAX_BET.toLocaleString()} UCT per round.`);
    const key = this.keyFor(playerAddress);
    if (playerAddress) this.referralCodes.set(referralCode(key), key);
    const welcomed = welcomeGrant(this.players.get(key) ?? newPlayerState());
    let state = welcomed.state;
    if (state.chips < bet) {
      throw new Error(`Not enough UCT — you have ${state.chips}. Deposit from your wallet to keep playing.`);
    }
    // Stake now; the settle path re-credits it before running (single pipeline).
    state = { ...state, chips: state.chips - bet };
    this.players.set(key, state);

    const secret = makeNonce();
    const nonce = makeNonce();
    const commit = commitHash(secret, nonce);
    const roundId = `blackjack-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const table: TableRound = {
      gameId: 'blackjack',
      secret,
      nonce,
      commit,
      createdAt: Date.now(),
      key,
      ...(playerAddress ? { playerAddress } : {}),
      ...(name ? { name } : {}),
      bet,
      actions: [],
      hand: bjStart(secret),
    };
    this.tables.set(roundId, table);
    if (playerAddress) this.lastPlay.set(playerAddress, Date.now());
    if (table.hand.done) return this.settleTable(roundId, table); // a natural
    return this.tableView(roundId, table);
  }

  /** Advance an open hand by one action; settles through the standard path when done. */
  stepTable(roundId: string, actionRaw: unknown, playerAddress?: string): TableView {
    const table = this.tables.get(roundId);
    if (!table) throw new Error('Hand not found or already settled — deal a new one.');
    if (table.key !== this.keyFor(playerAddress)) throw new Error('This is not your hand.');
    const action = String(actionRaw) as BjAction;
    if (action !== 'hit' && action !== 'stand' && action !== 'double') {
      throw new Error('Action must be hit, stand or double.');
    }
    if (action === 'double') {
      // Doubling is only legal on the opening two cards. Validate that BEFORE
      // taking the second bet — otherwise an illegal double (bjStep throws
      // below) would debit the extra stake and double table.bet with no
      // rollback, so the hand settles on a stake the player never agreed to.
      if (table.hand.done || table.hand.player.length !== 2) {
        throw new Error('Double is only allowed on your first two cards.');
      }
      const state = this.players.get(table.key) ?? newPlayerState();
      if (state.chips < table.bet) {
        throw new Error(`Doubling needs another ${table.bet} UCT — you have ${state.chips}.`);
      }
      this.players.set(table.key, { ...state, chips: state.chips - table.bet });
      table.bet *= 2;
    }
    table.actions.push(action);
    table.hand = bjStep(table.secret, table.hand, action);
    if (table.hand.done) return this.settleTable(roundId, table);
    return this.tableView(roundId, table);
  }

  /** The open hand's current public view (dealer hole card hidden). */
  private tableView(roundId: string, table: TableRound): TableView {
    const state = this.players.get(table.key);
    return {
      game: table.gameId,
      roundId,
      commit: table.commit,
      bet: table.bet,
      jackpotUct: this.pot,
      hand: bjView(table.hand),
      ...(state
        ? {
            you: {
              streak: state.streak,
              best: state.best,
              daily: dailyView(state, todayKey()),
              chips: state.chips,
              chipsGranted: 0,
            },
          }
        : {}),
    };
  }

  /** Finish a hand: re-credit the stake, then run the ONE settle pipeline. */
  private settleTable(roundId: string, table: TableRound): TableView {
    this.tables.delete(roundId);
    const state = this.players.get(table.key) ?? newPlayerState();
    this.players.set(table.key, { ...state, chips: state.chips + table.bet });
    const judged = bjJudge(table.hand);
    const result = this.settleJudged({
      roundId,
      gameId: table.gameId,
      secret: table.secret,
      nonce: table.nonce,
      commit: table.commit,
      judged,
      bet: table.bet,
      jackpotInput: `bj:${table.actions.join(',') || 'natural'}`,
      playerAddress: table.playerAddress,
      name: table.name,
    });
    return {
      game: table.gameId,
      roundId,
      commit: table.commit,
      bet: table.bet,
      jackpotUct: this.pot,
      hand: bjView(table.hand),
      result,
    };
  }

  /** This player's own invite code + how many friends they've brought in. */
  referralInfo(address?: string): { code: string | null; referrals: number; referred: boolean } {
    if (!address) return { code: null, referrals: 0, referred: false };
    const key = this.keyFor(address);
    const state = this.players.get(key);
    // Make the code resolvable even before the first round is dealt.
    this.referralCodes.set(referralCode(key), key);
    return {
      code: referralCode(key),
      referrals: state?.referrals ?? 0,
      referred: state?.referredBy !== undefined,
    };
  }

  /** The full achievement catalog annotated with what this player has unlocked. */
  achievementsOf(address?: string): AchievementView[] {
    const state = address ? this.players.get(this.keyFor(address)) : undefined;
    return catalogView(state?.unlocked ?? []);
  }

  /** Everything a player's profile page shows: stats, achievements, invite. */
  profileOf(address?: string): PlayerProfile {
    const state = address ? this.players.get(this.keyFor(address)) : undefined;
    const day = todayKey();
    return {
      balanceUct: state?.chips ?? 0,
      streak: state?.streak ?? 0,
      best: state?.best ?? 0,
      wins: state?.wins ?? 0,
      plays: state?.plays ?? 0,
      totalWon: state?.totalWon ?? 0,
      biggestWin: state?.biggestWin ?? 0,
      jackpots: state?.jackpots ?? 0,
      gamesPlayed: state?.games.length ?? 0,
      totalGames: Object.keys(GAMES).length,
      daily: state ? dailyView(state, day) : { goal: DAILY_GOAL, wins: 0, claimed: false },
      achievements: this.achievementsOf(address),
      referral: this.referralInfo(address),
      progress: progressView(state ?? newPlayerState()),
    };
  }

  /** The live tournament: countdown, current standings, and past champions. */
  tournamentView(): TournamentView {
    const now = Date.now();
    this.settleTournament(now);
    return this.tourney.view(now);
  }

  /**
   * Close any elapsed tournament windows. Each champion's prize is recorded in
   * the durable pending-prize ledger *before* the on-chain send, so a restart
   * (or a free-tier sleep at the window boundary) can't lose it —
   * retryPendingPrizes() re-attempts anything still owed on boot.
   */
  private settleTournament(now: number): void {
    for (const c of this.tourney.maybeRoll(now)) {
      // Rank in the id: a podium shares one closing timestamp — three prizes.
      const id = `tourney-${c.at}-r${c.rank}`;
      if (!this.pendingPrizes.has(id)) {
        this.pendingPrizes.set(id, { id, address: c.address, amount: c.prize, name: c.name, at: c.at, tries: 0 });
      }
      this.log.info(`TOURNAMENT — @${c.name} placed #${c.rank}: ${c.prize} UCT (score ${c.score})`);
      this.payPrize(this.pendingPrizes.get(id)!);
    }
  }

  /** Send one owed prize on-chain; drop it on landing, keep + note it on failure. */
  private payPrize(p: PendingPrize): void {
    if (this.payingPrizes.has(p.id)) return; // a send for this prize is already in flight
    this.payingPrizes.add(p.id);
    this.enqueueSettlement(
      p.id,
      p.address,
      p.amount,
      'arcade-tournament',
      p.name,
      'tournament',
      (error) => {
        // Keep it pending for the next retry; record why it failed (surfaced in houseStats).
        const cur = this.pendingPrizes.get(p.id);
        if (cur) this.pendingPrizes.set(p.id, { ...cur, tries: cur.tries + 1, ...(error ? { lastError: error } : {}) });
        this.payingPrizes.delete(p.id);
      },
      () => {
        // Delivered — retire it from the durable ledger.
        this.pendingPrizes.delete(p.id);
        this.payingPrizes.delete(p.id);
      },
    );
  }

  /**
   * Re-attempt tournament prizes that were crowned but never confirmed on-chain
   * (the process slept before the send landed). Call once on boot, after
   * restore() and after the agent is started. Delivery is at-least-once.
   */
  retryPendingPrizes(): void {
    for (const p of this.pendingPrizes.values()) this.payPrize(p);
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
   * A specific player's board row by display name — a direct lookup, NOT
   * limited by leaderboard()'s top-N slice. The astrid bot-league panel uses
   * this so a low-ranked persona never silently drops off once human players
   * crowd it past the leaderboard cut.
   */
  boardOf(name: string): LeaderRow | undefined {
    return this.board.get(name);
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
      pendingPrizes: [...this.pendingPrizes.values()].map((p) => ({
        name: p.name,
        amountUct: p.amount,
        tries: p.tries,
        ...(p.lastError ? { lastError: p.lastError } : {}),
      })),
    };
  }

  /**
   * A serializable snapshot of the durable house state. Open rounds, cooldowns
   * and in-flight settlements are intentionally omitted - they are short-lived
   * and on-chain payouts are their source of truth.
   */
  snapshot(): DealerSnapshot {
    return {
      players: [...this.players],
      board: [...this.board],
      referralCodes: [...this.referralCodes],
      seenDeposits: [...this.seenDeposits],
      pot: this.pot,
      paidOut: this.paidOut,
      roundsPlayed: this.roundsPlayed,
      minted: this.minted,
      feed: [...this.feed],
      tournament: this.tourney.snapshot(),
      pendingPrizes: [...this.pendingPrizes.values()],
      tables: [...this.tables],
    };
  }

  /**
   * Rehydrate from a prior snapshot(). Call once, before serving traffic and
   * before the first deposit sweep, so restored balances plus the seen-deposit
   * set prevent any double-credit of already-processed deposits.
   */
  restore(snap: DealerSnapshot | null | undefined): void {
    if (!snap) return;
    if (Array.isArray(snap.players)) {
      this.players.clear();
      for (const [k, v] of snap.players) this.players.set(k, v);
    }
    if (Array.isArray(snap.board)) {
      this.board.clear();
      for (const [k, v] of snap.board) this.board.set(k, v);
    }
    if (Array.isArray(snap.referralCodes)) {
      this.referralCodes.clear();
      for (const [k, v] of snap.referralCodes) this.referralCodes.set(k, v);
    }
    if (Array.isArray(snap.seenDeposits)) {
      this.seenDeposits.clear();
      for (const id of snap.seenDeposits) this.seenDeposits.add(id);
    }
    if (typeof snap.pot === 'number') this.pot = snap.pot;
    if (typeof snap.paidOut === 'number') this.paidOut = snap.paidOut;
    if (typeof snap.roundsPlayed === 'number') this.roundsPlayed = snap.roundsPlayed;
    if (typeof snap.minted === 'number') this.minted = snap.minted;
    if (Array.isArray(snap.feed)) this.feed = [...snap.feed];
    if (Array.isArray(snap.pendingPrizes)) {
      this.pendingPrizes.clear();
      for (const p of snap.pendingPrizes) this.pendingPrizes.set(p.id, p);
    }
    if (Array.isArray(snap.tables)) {
      this.tables.clear();
      for (const [id, t] of snap.tables) this.tables.set(id, t);
    }
    this.tourney.restore(snap.tournament);
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
    onFail?: (error?: string) => void,
    onLand?: () => void,
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
        onLand?.();
      } catch (e) {
        const error = e instanceof Error ? e.message : 'payout failed';
        this.settlements.set(key, { status: 'failed', amountUct: amount, error, at: Date.now() });
        this.log.warn(`settlement ${key} failed: ${error}`);
        // A failed jackpot payout puts the pot back. The hit optimistically reset
        // the pot to the seed (pot = jackpotSeed), so restore the amount that was
        // taken (won pot minus seed) rather than the full amount — which would
        // over-restore by one seed on top of any growth since the hit.
        if (memo === 'arcade-jackpot') {
          this.pot = Math.min(this.jackpotCap, this.pot + amount - this.jackpotSeed);
        }
        onFail?.(error);
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
    // An abandoned table hand refunds its stake — walking away isn't a loss.
    for (const [id, t] of this.tables) {
      if (now - t.createdAt > this.ttl) {
        this.tables.delete(id);
        const state = this.players.get(t.key) ?? newPlayerState();
        this.players.set(t.key, { ...state, chips: state.chips + t.bet });
        this.log.info(`table ${id} expired — ${t.bet} UCT stake refunded`);
      }
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

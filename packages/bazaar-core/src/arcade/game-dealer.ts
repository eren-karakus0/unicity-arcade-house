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
  /** How long one payout may hold the payment lock (default 2 min). */
  payoutTimeoutMs?: number;
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
  /** Prizes (tournament crowns + jackpots) owed but awaiting on-chain confirmation (retried on boot). */
  pendingPrizes: { name: string; amountUct: number; tries: number; lastError?: string }[];
  /**
   * Transfer intents still open on-chain, as of the last resume tick. Each one
   * holds the tokens it would spend, so a count that does not fall is why the
   * house can hold a balance it cannot pay with.
   */
  openTransfers: number | null;
}

/**
 * Coin selection refused the spend for want of unreserved tokens. Matched on the
 * SDK's error code, with the message as a fallback so an older/newer wallet that
 * only carries the text is still recognised.
 */
/** Retry backoff for an owed prize: doubles per failed try, capped. */
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 30 * 60_000;
/** Least time between float top-ups, so a backlog cannot mint once per prize. */
const MINT_COOLDOWN_MS = 5 * 60_000;
/**
 * How far before a prize was recorded a SENT entry may be timestamped and still
 * count as its payment — clock skew between the wallet's history and ours, not
 * a licence to match an older payment.
 */
const SENT_MATCH_SLACK_MS = 60_000;

/** The wallet history fields reconciliation reads (see HistoryEntry in the SDK). */
interface HistoryLike {
  id?: string;
  type?: string;
  amount?: string;
  memo?: string;
  timestamp?: number;
  recipientPubkey?: string;
  recipientNametag?: string;
}
/**
 * How long one payout may hold the payment lock. Payouts run in sequence so
 * they never contend for the same tokens, which also means a single call that
 * never settles takes every future payout down with it — the house simply stops
 * paying, silently, until someone restarts it. Generous enough that a slow but
 * healthy settlement is never cut short.
 */
const PAYOUT_TIMEOUT_MS = 120_000;

/**
 * The chain refused the recipient outright: they have no published identity to
 * receive with. Unlike a transient failure this cannot come good by retrying —
 * the house's own bot personas are labels with no wallet behind them at all.
 */
function isUnreachableRecipient(error: string | undefined): boolean {
  return error !== undefined && /no published chain pubkey/i.test(error);
}

/**
 * A payout was abandoned at its deadline. The send itself is still running and
 * may yet land, so this is a possibly-committed outcome, not a clean failure.
 */
class PayoutDeadlineError extends Error {
  constructor(ms: number) {
    super(`payout did not settle within ${ms}ms`);
    this.name = 'PayoutDeadlineError';
  }
}

/** Reject if `p` has not settled within `ms`; the underlying work is left running. */
async function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new PayoutDeadlineError(ms)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The send outcomes the SDK says must never be re-sent (its
 * `isPossiblyCommittedSendOutcome` set, SDK 0.17).
 */
const POSSIBLY_COMMITTED_SEND_CODES: ReadonlySet<string> = new Set([
  'SEND_SYNC_PENDING',
  'CERTIFICATION_UNCONFIRMED',
  'CHECKPOINT_PERSIST_FAILED',
  'SPLIT_CHECKPOINT_LOST',
  'CHECKPOINT_TRUSTBASE_MISMATCH',
  'SEND_PARTIALLY_COMPLETED',
]);

/**
 * The spend may already be on-chain, so the SDK kept the intent open AND kept
 * its source token reserved. Re-sending such a payment would pick a second
 * token and pay twice, and every attempt that ends this way pins one more
 * token: retrying is how a wallet ratchets itself down to nothing spendable.
 * These converge on their own; the only lever is resumeNow().
 *
 * Read `code` structurally rather than through the SDK's own helper: that one
 * tests `instanceof SphereError`, and errors thrown from the SDK's impl bundles
 * are a different copy of the class. The wording fallback covers mint failures,
 * which report this outcome in the message only.
 */
function isPossiblyCommitted(e: unknown): boolean {
  if (e instanceof PayoutDeadlineError) return true;
  const err = e as { code?: unknown; message?: unknown } | null;
  if (typeof err?.code === 'string' && POSSIBLY_COMMITTED_SEND_CODES.has(err.code)) return true;
  return typeof err?.message === 'string' && /certification unconfirmed/i.test(err.message);
}

/** Why an on-chain settlement did not land, as its failure handlers need it. */
interface SettlementFailure {
  message: string;
  /** The payment may still land — it must be reconciled, never re-sent or refunded. */
  possiblyCommitted: boolean;
}

function settlementEventKind(memo: string | undefined): HouseEvent['kind'] {
  if (memo === 'arcade-jackpot') return 'jackpot';
  if (memo === 'arcade-cashout') return 'cashout';
  if (memo === 'arcade-tournament' || memo === undefined) return 'tournament';
  return 'win';
}

function isInsufficientBalance(e: unknown): boolean {
  const err = e as { code?: unknown; message?: unknown } | null;
  return (
    err?.code === 'SEND_INSUFFICIENT_BALANCE' ||
    (typeof err?.message === 'string' && err.message.includes('Insufficient balance'))
  );
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
  /** Stable id: `tourney-<closeMs>-r<rank>` or `<roundId>:jackpot`; dedups every retry. */
  id: string;
  address: string;
  amount: number;
  name: string;
  at: number;
  tries: number;
  lastError?: string;
  /** When the last send was attempted — drives the retry backoff. */
  lastTryAt?: number;
  /**
   * A spend for this prize is open on-chain but unconfirmed. It must never be
   * re-sent (that would pay twice); it converges on its own.
   */
  awaitingConvergence?: boolean;
  /**
   * Settlement memo — defaults to the tournament payout; jackpots use
   * 'arcade-jackpot', withdraws whose send may be on-chain 'arcade-cashout'.
   */
  memo?: string;
  /** Game id for the feed event (tournament prizes have none). */
  game?: string;
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
  /** Prizes (tournament crowns + jackpots) owed but not yet confirmed on-chain (retried on boot). */
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
  private readonly payoutTimeout: number;
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
  /** When the house last minted a float top-up (see MINT_COOLDOWN_MS). */
  private lastMintAt = 0;
  /** Open transfer intents seen at the last resume tick (null until first tick). */
  private openTransfers: number | null = null;

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
    this.payoutTimeout = opts.payoutTimeoutMs ?? PAYOUT_TIMEOUT_MS;
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
      // Record the owed jackpot in the durable pending ledger BEFORE the send +
      // pot reset — exactly like a tournament crown — so a restart mid-payout
      // re-attempts it on boot instead of silently dropping the win.
      const jid = `${args.roundId}:jackpot`;
      this.pendingPrizes.set(jid, {
        id: jid,
        address: args.playerAddress,
        amount: jackpot.potUct,
        name,
        at: Date.now(),
        tries: 0,
        memo: 'arcade-jackpot',
        game: args.gameId,
      });
      this.pot = this.jackpotSeed; // the pot is now durably owed to the hitter, not restored
      this.payPrize(this.pendingPrizes.get(jid)!);
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

  /** Credit an amount to a player's in-house balance (their chips). */
  private creditHouseBalance(address: string, amount: number, name: string): void {
    const key = this.keyFor(address);
    const state = this.players.get(key) ?? newPlayerState();
    this.players.set(key, { ...state, chips: state.chips + amount });
    this.creditEarned(name, amount);
  }

  /** Send one owed prize on-chain; drop it on landing, keep + note it on failure. */
  private payPrize(p: PendingPrize): void {
    if (this.payingPrizes.has(p.id)) return; // a send for this prize is already in flight
    this.payingPrizes.add(p.id);
    this.pendingPrizes.set(p.id, { ...p, lastTryAt: Date.now() });
    this.enqueueSettlement(
      p.id,
      p.address,
      p.amount,
      p.memo ?? 'arcade-tournament',
      p.name,
      p.game ?? 'tournament',
      (failure) => {
        if (isUnreachableRecipient(failure.message)) {
          // The winner has no on-chain identity, so this prize can never land -
          // retrying it forever only fills the ledger with sends that cannot
          // succeed and starves the ones that can. Settle it as house credit
          // instead: real for the winner, who plays on with it.
          this.creditHouseBalance(p.address, p.amount, p.name);
          this.log.info(`prize ${p.id}: @${p.name} cannot receive on-chain — credited ${p.amount} UCT in-house`);
          this.pendingPrizes.delete(p.id);
          this.payingPrizes.delete(p.id);
          return;
        }
        // Keep it pending for the next retry; record why it failed (surfaced in houseStats).
        const cur = this.pendingPrizes.get(p.id);
        if (cur) {
          const keptOpen = failure.possiblyCommitted;
          if (keptOpen && !cur.awaitingConvergence) {
            this.log.warn(`prize ${p.id}: spend kept open, awaiting convergence — will NOT be re-sent`);
          }
          this.pendingPrizes.set(p.id, {
            ...cur,
            tries: cur.tries + 1,
            lastError: failure.message,
            // Once a spend is open it owns this prize: the retry sweep must
            // leave it alone until the intent converges, or we double-pay.
            ...(keptOpen ? { awaitingConvergence: true } : {}),
          });
        }
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
   * Re-attempt prizes that were awarded but never confirmed on-chain (the
   * process slept before the send landed, or the send failed). Call after
   * restore() once the agent is started, and then on a timer: a boot-only sweep
   * strands everything it cannot pay that instant until the next restart, which
   * is how a backlog builds up in the first place. Delivery is at-least-once.
   *
   * A sweep takes only a slice of the queue, so a large backlog drains steadily
   * instead of replaying every owed prize — against one wallet, in sequence — on
   * every tick. Timed sweeps also wait out an escalating per-prize backoff;
   * the boot sweep does not, because a restart is itself new information.
   */
  retryPendingPrizes(opts: { limit?: number; respectBackoff?: boolean } = {}): void {
    const { limit = 10, respectBackoff = false } = opts;
    const now = Date.now();
    const due = [...this.pendingPrizes.values()].filter((p) => {
      if (this.payingPrizes.has(p.id)) return false;
      // An open spend already owns this prize — see isKeptOpen().
      if (p.awaitingConvergence) return false;
      if (!respectBackoff || p.lastTryAt === undefined) return true;
      const backoff = Math.min(RETRY_BASE_MS * 2 ** Math.min(p.tries, 8), RETRY_MAX_MS);
      return now - p.lastTryAt >= backoff;
    });
    for (const p of due.slice(0, limit)) this.payPrize(p);
  }

  /**
   * Nudge open spends toward convergence. Prizes whose send was kept open are
   * waiting on exactly this — it is the only recovery path for them, and it
   * releases the tokens they hold, which is what lets other payouts proceed.
   */
  async resumeOpenTransfers(): Promise<void> {
    try {
      await this.agent.resumeOpenTransfers();
      // Report how many intents are still open afterwards. Prizes waiting on
      // convergence are invisible otherwise — the wallet just quietly refuses
      // to spend — and a count that never falls is the signal that resume is
      // not making progress, which is worth noticing without reading logs for
      // a refusal that happens to mention it.
      const open = await this.agent.pendingTransfers();
      this.openTransfers = open.length;
      this.log.info(`resume tick — ${open.length} transfer(s) still open`);
    } catch (e) {
      this.log.warn('resume of open transfers failed', e instanceof Error ? e.message : e);
    }
  }

  /**
   * Decide the fate of prizes whose spend was kept open, by asking the wallet
   * what it actually sent.
   *
   * A kept-open spend may already be on-chain, so we never re-send one blindly
   * — but once its intent converges the prize is either delivered or it is not,
   * and the ledger cannot tell which. The wallet's own history can: a matching
   * SENT entry is proof the winner was paid, so the prize retires. With no such
   * entry and nothing left in flight, no spend can be outstanding, so the prize
   * is safe to hand back to the retry sweep. While any intent is still open we
   * leave everything alone — we cannot tell which prize it belongs to.
   */
  async reconcileOpenPrizes(): Promise<{ settled: number; released: number }> {
    const waiting = [...this.pendingPrizes.values()].filter((p) => p.awaitingConvergence);
    if (waiting.length === 0) return { settled: 0, released: 0 };

    let entries: HistoryLike[];
    try {
      entries = (await this.agent.getHistory(500)) as HistoryLike[];
    } catch (e) {
      this.log.warn('prize reconciliation: history unavailable', e instanceof Error ? e.message : e);
      return { settled: 0, released: 0 };
    }

    // One SENT entry can only settle one prize, or two identical prizes to the
    // same winner would both retire on a single payment.
    const claimed = new Set<string>();
    let settled = 0;
    let released = 0;

    for (const p of waiting) {
      const match = entries.find((e) => {
        if (e.type !== 'SENT' || e.id === undefined || claimed.has(e.id)) return false;
        if ((e.timestamp ?? 0) + SENT_MATCH_SLACK_MS < p.at) return false;
        if (e.memo !== (p.memo ?? 'arcade-tournament')) return false;
        if (e.amount !== this.agent.toSmallest(p.amount)) return false;
        return this.addressMatches(p.address, e);
      });
      if (match?.id !== undefined) {
        claimed.add(match.id);
        this.pendingPrizes.delete(p.id);
        this.paidOut += p.amount;
        this.pushEvent({
          kind: settlementEventKind(p.memo),
          at: Date.now(),
          amountUct: p.amount,
          name: p.name,
          ...(p.game ? { game: p.game } : {}),
        });
        this.log.info(`prize ${p.id}: found on-chain as sent — retiring (${p.amount} UCT to @${p.name})`);
        settled += 1;
        continue;
      }
      if (this.openTransfers === 0) {
        this.pendingPrizes.set(p.id, { ...p, awaitingConvergence: false });
        this.log.info(`prize ${p.id}: never sent and nothing in flight — returning it to the retry queue`);
        released += 1;
      }
    }
    return { settled, released };
  }

  /** Does this history entry's recipient identify the prize's winner? */
  private addressMatches(address: string, e: HistoryLike): boolean {
    const want = address.replace(/^@/, '').toLowerCase();
    const pubkey = e.recipientPubkey?.toLowerCase();
    const tag = e.recipientNametag?.replace(/^@/, '').toLowerCase();
    return want === pubkey || want === tag;
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
    const requestedAt = Date.now();
    const settlementId = `cashout-${requestedAt}-${Math.random().toString(36).slice(2, 8)}`;
    this.enqueueSettlement(settlementId, address, amount, 'arcade-cashout', cleanName, 'cashout', (failure) => {
      if (failure.possiblyCommitted) {
        // Refunding now would pay twice if the send still lands, so the withdraw
        // is owed through the prize ledger, where reconciliation either finds it
        // sent or re-queues it once nothing is in flight.
        this.oweUnresolvedCashout({ id: settlementId, address, amount, name: cleanName, at: requestedAt }, failure);
        return;
      }
      const cur = this.players.get(key) ?? newPlayerState();
      this.players.set(key, { ...cur, chips: cur.chips + amount });
    });
    return { settlementId, amountUct: amount };
  }

  private oweUnresolvedCashout(
    cashout: Pick<PendingPrize, 'id' | 'address' | 'amount' | 'name' | 'at'>,
    failure: SettlementFailure,
  ): void {
    this.pendingPrizes.set(cashout.id, {
      ...cashout,
      tries: 1,
      lastError: failure.message,
      lastTryAt: Date.now(),
      awaitingConvergence: true,
      memo: 'arcade-cashout',
      game: 'cashout',
    });
    this.log.warn(`cashout ${cashout.id}: send may be on-chain — owed until reconciled, chips withheld`);
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
      openTransfers: this.openTransfers,
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
    const run = this.payLock.then(() => withDeadline(this.attemptPayout(address, amount, memo), this.payoutTimeout));
    this.payLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * One payout attempt: make sure the treasury can cover it, then send. Runs
   * under the payment lock, and under a deadline — an abandoned attempt may
   * still land, which keeps delivery at-least-once (as the pending ledger
   * already documents) but never wedges every later payout behind it.
   */
  private async attemptPayout(address: string, amount: number, memo: string): Promise<TxLike> {
    {
      await this.ensureTreasuryFor(amount);
      try {
        return (await this.agent.send(address, amount, memo)) as unknown as TxLike;
      } catch (e) {
        if (!isInsufficientBalance(e)) throw e;
        // A confirmed balance is not a spendable one: coin selection only draws
        // on tokens no other intent holds, so the treasury check above can read
        // healthy while nothing is actually free to spend — and then the house
        // never tops up, because by its own measure it is rich. Mint to restore
        // a free float (fresh tokens are unreserved by construction).
        //
        // The mint is a top-up for LATER payouts, not a rescue of this one: a
        // just-minted token is not spendable the instant the mint resolves, so
        // retrying inline would fail anyway and mint again on the next prize,
        // and the next — minting without bound while nothing gets paid. This
        // payout fails honestly and the retry sweep picks it up once the float
        // has landed. The cooldown keeps a burst of owed prizes to one top-up.
        const now = Date.now();
        if (now - this.lastMintAt >= MINT_COOLDOWN_MS) {
          this.lastMintAt = now;
          const top = Math.max(this.mintAmount, Math.ceil(amount + 10));
          this.log.warn(`payout of ${amount} UCT found no spendable tokens — minting ${top} to restore the float`);
          // Check the result: a mint reports failure in its payload rather than
          // throwing, so ignoring it would credit a top-up that never happened
          // and leave the house quietly unable to pay anything.
          const res = await this.agent.mintUct(top);
          if (res?.success === false) {
            this.log.error(`float top-up of ${top} UCT failed: ${res.error ?? 'unknown error'}`);
          } else {
            this.minted += top;
            this.pushEvent({ kind: 'mint', at: now, amountUct: top });
          }
        }
        throw e;
      }
    }
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
    onFail?: (failure: SettlementFailure) => void,
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
        this.pushEvent({ kind: settlementEventKind(memo), at: Date.now(), amountUct: amount, name, game });
        onLand?.();
      } catch (e) {
        const failure: SettlementFailure = {
          message: e instanceof Error ? e.message : 'payout failed',
          possiblyCommitted: isPossiblyCommitted(e),
        };
        this.settlements.set(key, { status: 'failed', amountUct: amount, error: failure.message, at: Date.now() });
        this.log.warn(`settlement ${key} failed: ${failure.message}`);
        // Jackpots (like tournament prizes) are owed via the durable pending
        // ledger — a failed send keeps the prize pending for retry (onFail),
        // and the pot stays reset to the seed. Nothing to restore here.
        onFail?.(failure);
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

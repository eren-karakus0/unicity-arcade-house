/**
 * Engagement layer — win streaks and a daily challenge. Kept pure so the reward
 * logic is unit-tested independently of the on-chain dealer.
 */
export interface PlayerState {
  streak: number;
  best: number;
  dailyDay: string; // UTC YYYY-MM-DD the daily counters belong to
  dailyWins: number;
  dailyClaimed: boolean;
  /**
   * In-house UCT balance. Funded by real wallet deposits (plus a one-time
   * welcome stake); bets stake it; withdraw settles it on-chain 1:1.
   */
  chips: number;
  /** One-time welcome stake already granted. */
  welcomed: boolean;
  /** Lifetime tallies (this server session) — feed achievements + tournament. */
  wins: number;
  plays: number;
  /** Distinct game ids the player has played (for the "explorer" achievement). */
  games: string[];
  /** Progressive-jackpot hits. */
  jackpots: number;
  /** Largest single-round payout (UCT). */
  biggestWin: number;
  /** Total UCT won across all rounds (wins only). */
  totalWon: number;
  /** Completed the daily challenge at least once. */
  everDaily: boolean;
  /** Achievement ids already unlocked (persisted to detect newly-earned). */
  unlocked: string[];
  /** Key of the player who referred this one (set once, on first play). */
  referredBy: string | undefined;
  /** How many new players this player has referred. */
  referrals: number;
  /** Lifetime XP (log-scaled from wagers — see xpForBet). */
  xp?: number;
  /** Highest tier index already granted (level-up bonuses never repeat). */
  tierIdx?: number;
  /** Rakeback accrual in milli-chips (credited as whole chips when >= 1000). */
  rakeMilli?: number;
}

export const DAILY_GOAL = 5;
export const DAILY_REWARD = 10;
export const WELCOME_UCT = 5;

export function newPlayerState(): PlayerState {
  return {
    streak: 0,
    best: 0,
    dailyDay: '',
    dailyWins: 0,
    dailyClaimed: false,
    chips: 0,
    welcomed: false,
    wins: 0,
    plays: 0,
    games: [],
    jackpots: 0,
    biggestWin: 0,
    totalWon: 0,
    everDaily: false,
    unlocked: [],
    referredBy: undefined,
    referrals: 0,
  };
}

/**
 * A one-time welcome stake so a brand-new wallet can feel the games before
 * depositing. Never repeats — after this, the balance moves only via deposits,
 * bets, and withdrawals.
 */
export function welcomeGrant(prev: PlayerState, amount: number = WELCOME_UCT): {
  state: PlayerState;
  granted: number;
} {
  if (prev.welcomed) return { state: prev, granted: 0 };
  return { state: { ...prev, chips: prev.chips + amount, welcomed: true }, granted: amount };
}

export function todayKey(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** One-time bonus awarded when a streak reaches this exact length. */
export function streakBonus(streak: number): number {
  if (streak === 3) return 2;
  if (streak === 5) return 3;
  if (streak === 10) return 5;
  if (streak > 10 && streak % 5 === 0) return 5;
  return 0;
}

export interface WinUpdate {
  state: PlayerState;
  streakBonus: number;
  dailyBonus: number;
  dailyJustClaimed: boolean;
}

/** Apply a win: bump the streak + daily progress and compute one-time bonuses. */
export function applyWin(prev: PlayerState, day: string): WinUpdate {
  const s: PlayerState = { ...prev };
  if (s.dailyDay !== day) {
    s.dailyDay = day;
    s.dailyWins = 0;
    s.dailyClaimed = false;
  }
  s.streak += 1;
  if (s.streak > s.best) s.best = s.streak;
  const sb = streakBonus(s.streak);
  s.dailyWins += 1;
  let db = 0;
  let justClaimed = false;
  if (!s.dailyClaimed && s.dailyWins >= DAILY_GOAL) {
    s.dailyClaimed = true;
    s.everDaily = true;
    db = DAILY_REWARD;
    justClaimed = true;
  }
  return { state: s, streakBonus: sb, dailyBonus: db, dailyJustClaimed: justClaimed };
}

/** A loss breaks the streak; daily progress is kept. */
export function applyLoss(prev: PlayerState): PlayerState {
  return { ...prev, streak: 0 };
}

export interface DailyView {
  goal: number;
  wins: number;
  claimed: boolean;
}

/** The player's daily progress, normalized to `day` (a stale window reads 0). */
export function dailyView(state: PlayerState, day: string): DailyView {
  if (state.dailyDay !== day) return { goal: DAILY_GOAL, wins: 0, claimed: false };
  return { goal: DAILY_GOAL, wins: state.dailyWins, claimed: state.dailyClaimed };
}

// ---------------------------------------------------------------------------
// XP, tiers & rakeback — the retention spine. XP is LOG-scaled from the wager
// (bets stay uncapped by design, but a whale can't buy the ladder in one hand),
// tiers unlock a rakeback rate (a slice of every LOST bet comes back as chips,
// accrued in milli-chips so small bets still count) plus a one-time level-up
// bonus. Pure + bounded: three small numbers per player.
// ---------------------------------------------------------------------------

export interface TierDef {
  name: string;
  minXp: number;
  /** Rakeback in per-mille of a lost bet (20 = 2%). */
  rakebackMilli: number;
  /** One-time chips bonus when the tier is first reached. */
  bonus: number;
}

export const TIERS: readonly TierDef[] = [
  { name: 'Bronze', minXp: 0, rakebackMilli: 20, bonus: 0 },
  { name: 'Silver', minXp: 1_000, rakebackMilli: 40, bonus: 25 },
  { name: 'Gold', minXp: 5_000, rakebackMilli: 60, bonus: 100 },
  { name: 'Platinum', minXp: 20_000, rakebackMilli: 80, bonus: 250 },
  { name: 'Diamond', minXp: 75_000, rakebackMilli: 100, bonus: 500 },
] as const;

/** XP for one round: 10·log₂(1+bet), rounded — bet 1 → 10, 10 → 35, 1000 → 100. */
export function xpForBet(bet: number): number {
  return Math.round(10 * Math.log2(1 + Math.max(0, bet)));
}

export function tierIndexFor(xp: number): number {
  let idx = 0;
  for (let i = 0; i < TIERS.length; i++) if (xp >= TIERS[i]!.minXp) idx = i;
  return idx;
}

export interface ProgressUpdate {
  state: PlayerState;
  xpGained: number;
  /** Whole chips credited from rakeback accrual this round. */
  rakeCredited: number;
  /** Set when this round crossed one or more tier boundaries. */
  levelUp: { tier: string; bonus: number } | null;
}

/**
 * Apply one round's XP + rakeback + (possible) level-up to the player.
 * Rakeback accrues on LOSSES at the player's CURRENT tier rate; level-up
 * bonuses are granted once per tier, even across multi-tier jumps.
 */
export function applyProgress(prev: PlayerState, bet: number, outcome: 'win' | 'lose' | 'tie'): ProgressUpdate {
  const xpGained = xpForBet(bet);
  const xp = (prev.xp ?? 0) + xpGained;
  const grantedIdx = prev.tierIdx ?? 0;
  let rakeMilli = prev.rakeMilli ?? 0;
  let rakeCredited = 0;
  if (outcome === 'lose') {
    rakeMilli += bet * TIERS[Math.min(grantedIdx, TIERS.length - 1)]!.rakebackMilli;
    rakeCredited = Math.floor(rakeMilli / 1000);
    rakeMilli -= rakeCredited * 1000;
  }
  const reachedIdx = tierIndexFor(xp);
  let tierIdx = grantedIdx;
  let levelUp: ProgressUpdate['levelUp'] = null;
  let bonus = 0;
  if (reachedIdx > grantedIdx) {
    for (let i = grantedIdx + 1; i <= reachedIdx; i++) bonus += TIERS[i]!.bonus;
    tierIdx = reachedIdx;
    levelUp = { tier: TIERS[reachedIdx]!.name, bonus };
  }
  return {
    state: { ...prev, xp, rakeMilli, tierIdx, chips: prev.chips + rakeCredited + bonus },
    xpGained,
    rakeCredited,
    levelUp,
  };
}

export interface ProgressView {
  xp: number;
  tier: string;
  tierIdx: number;
  /** XP needed for the next tier, or null at the top. */
  nextTierXp: number | null;
  /** Current rakeback, percent (e.g. 4 = 4% of lost bets back). */
  rakebackPct: number;
}

export function progressView(state: PlayerState): ProgressView {
  const xp = state.xp ?? 0;
  const idx = state.tierIdx ?? tierIndexFor(xp);
  const next = TIERS[idx + 1];
  return {
    xp,
    tier: TIERS[Math.min(idx, TIERS.length - 1)]!.name,
    tierIdx: idx,
    nextTierXp: next ? next.minXp : null,
    rakebackPct: TIERS[Math.min(idx, TIERS.length - 1)]!.rakebackMilli / 10,
  };
}

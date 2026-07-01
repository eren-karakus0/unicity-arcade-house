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
}

export const DAILY_GOAL = 5;
export const DAILY_REWARD = 10;

export function newPlayerState(): PlayerState {
  return { streak: 0, best: 0, dailyDay: '', dailyWins: 0, dailyClaimed: false };
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

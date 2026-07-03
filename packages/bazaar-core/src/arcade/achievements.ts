/**
 * Achievements — milestone badges derived purely from a player's tallies, so
 * the catalog is unit-tested independently of the dealer. Each achievement is
 * a predicate over a small progress snapshot; the dealer stores which ids a
 * player has unlocked so newly-earned ones can be surfaced once.
 */
import type { PlayerState } from './events-logic.js';

export interface Achievement {
  id: string;
  title: string;
  /** One-line, player-facing description of how it's earned. */
  detail: string;
  /** Short icon hint for the UI (a glyph name, not an emoji dependency). */
  icon: 'spark' | 'flame' | 'crown' | 'coin' | 'dice' | 'target' | 'star' | 'trophy';
  /** UCT reward granted once, when first unlocked (0 = badge only). */
  reward: number;
  test: (p: ProgressStats) => boolean;
}

/** The subset of player tallies achievements read — decoupled from PlayerState. */
export interface ProgressStats {
  wins: number;
  plays: number;
  best: number;
  distinctGames: number;
  jackpots: number;
  biggestWin: number;
  totalWon: number;
  everDaily: boolean;
}

/** Total number of distinct games in the arcade (for the "explorer" badge). */
export const TOTAL_GAMES = 7;

/**
 * The catalog. Ordered easiest → hardest; ids are stable (persisted per
 * player), so never renumber — only append.
 */
export const ACHIEVEMENTS: readonly Achievement[] = [
  {
    id: 'first_win',
    title: 'First Blood',
    detail: 'Win your first round.',
    icon: 'spark',
    reward: 1,
    test: (p) => p.wins >= 1,
  },
  {
    id: 'hot_hand',
    title: 'Hot Hand',
    detail: 'Reach a 3-win streak.',
    icon: 'flame',
    reward: 2,
    test: (p) => p.best >= 3,
  },
  {
    id: 'on_fire',
    title: 'On Fire',
    detail: 'Reach a 5-win streak.',
    icon: 'flame',
    reward: 3,
    test: (p) => p.best >= 5,
  },
  {
    id: 'unstoppable',
    title: 'Unstoppable',
    detail: 'Reach a 10-win streak.',
    icon: 'flame',
    reward: 5,
    test: (p) => p.best >= 10,
  },
  {
    id: 'explorer',
    title: 'House Explorer',
    detail: `Play all ${TOTAL_GAMES} games.`,
    icon: 'dice',
    reward: 5,
    test: (p) => p.distinctGames >= TOTAL_GAMES,
  },
  {
    id: 'high_roller',
    title: 'High Roller',
    detail: 'Win 50+ UCT in a single round.',
    icon: 'coin',
    reward: 5,
    test: (p) => p.biggestWin >= 50,
  },
  {
    id: 'daily_done',
    title: 'Regular',
    detail: 'Complete a daily challenge.',
    icon: 'target',
    reward: 3,
    test: (p) => p.everDaily,
  },
  {
    id: 'centurion',
    title: 'Centurion',
    detail: 'Win 100 UCT in total.',
    icon: 'star',
    reward: 10,
    test: (p) => p.totalWon >= 100,
  },
  {
    id: 'veteran',
    title: 'Veteran',
    detail: 'Play 50 rounds.',
    icon: 'trophy',
    reward: 5,
    test: (p) => p.plays >= 50,
  },
  {
    id: 'jackpot',
    title: 'Jackpot!',
    detail: 'Hit the progressive jackpot.',
    icon: 'crown',
    reward: 0, // the pot itself is the reward
    test: (p) => p.jackpots >= 1,
  },
] as const;

const BY_ID = new Map(ACHIEVEMENTS.map((a) => [a.id, a]));

/** Read the achievement-relevant tallies out of a full player state. */
export function statsOf(p: PlayerState): ProgressStats {
  return {
    wins: p.wins,
    plays: p.plays,
    best: p.best,
    distinctGames: p.games.length,
    jackpots: p.jackpots,
    biggestWin: p.biggestWin,
    totalWon: p.totalWon,
    everDaily: p.everDaily,
  };
}

/** Every achievement id the stats currently satisfy. */
export function earnedIds(stats: ProgressStats): string[] {
  return ACHIEVEMENTS.filter((a) => a.test(stats)).map((a) => a.id);
}

/**
 * Diff earned-now against already-unlocked: returns the freshly-earned
 * achievements (for a one-time reveal/reward) and the merged unlocked set.
 */
export function newlyUnlocked(
  stats: ProgressStats,
  unlocked: readonly string[],
): { fresh: Achievement[]; unlocked: string[] } {
  const have = new Set(unlocked);
  const fresh: Achievement[] = [];
  for (const a of ACHIEVEMENTS) {
    if (a.test(stats) && !have.has(a.id)) {
      fresh.push(a);
      have.add(a.id);
    }
  }
  return { fresh, unlocked: [...have] };
}

export function achievementById(id: string): Achievement | undefined {
  return BY_ID.get(id);
}

/** Public catalog shape for the API (no predicate functions). */
export interface AchievementView {
  id: string;
  title: string;
  detail: string;
  icon: Achievement['icon'];
  reward: number;
  unlocked: boolean;
}

/** The full catalog annotated with which ids the given set has unlocked. */
export function catalogView(unlocked: readonly string[]): AchievementView[] {
  const have = new Set(unlocked);
  return ACHIEVEMENTS.map((a) => ({
    id: a.id,
    title: a.title,
    detail: a.detail,
    icon: a.icon,
    reward: a.reward,
    unlocked: have.has(a.id),
  }));
}

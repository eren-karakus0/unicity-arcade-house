import { describe, expect, it } from 'vitest';
import {
  ACHIEVEMENTS,
  TOTAL_GAMES,
  catalogView,
  earnedIds,
  newlyUnlocked,
  statsOf,
  type ProgressStats,
} from './achievements.js';
import { newPlayerState } from './events-logic.js';

const base: ProgressStats = {
  wins: 0,
  plays: 0,
  best: 0,
  distinctGames: 0,
  jackpots: 0,
  biggestWin: 0,
  totalWon: 0,
  everDaily: false,
  referrals: 0,
};

describe('achievements catalog', () => {
  it('has unique, stable ids', () => {
    const ids = ACHIEVEMENTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('unlocks nothing for a fresh player', () => {
    expect(earnedIds(base)).toEqual([]);
  });

  it('unlocks first_win after one win', () => {
    expect(earnedIds({ ...base, wins: 1 })).toContain('first_win');
  });

  it('unlocks streak badges by best streak', () => {
    expect(earnedIds({ ...base, best: 3 })).toContain('hot_hand');
    expect(earnedIds({ ...base, best: 5 })).toEqual(expect.arrayContaining(['hot_hand', 'on_fire']));
    expect(earnedIds({ ...base, best: 10 })).toEqual(
      expect.arrayContaining(['hot_hand', 'on_fire', 'unstoppable']),
    );
  });

  it('unlocks explorer only after all games are played', () => {
    expect(earnedIds({ ...base, distinctGames: TOTAL_GAMES - 1 })).not.toContain('explorer');
    expect(earnedIds({ ...base, distinctGames: TOTAL_GAMES })).toContain('explorer');
  });

  it('unlocks high_roller, centurion, veteran, jackpot at their thresholds', () => {
    expect(earnedIds({ ...base, biggestWin: 50 })).toContain('high_roller');
    expect(earnedIds({ ...base, totalWon: 100 })).toContain('centurion');
    expect(earnedIds({ ...base, plays: 50 })).toContain('veteran');
    expect(earnedIds({ ...base, jackpots: 1 })).toContain('jackpot');
    expect(earnedIds({ ...base, everDaily: true })).toContain('daily_done');
    expect(earnedIds({ ...base, referrals: 1 })).toContain('recruiter');
  });
});

describe('newlyUnlocked', () => {
  it('returns only the freshly-earned achievements and merges the set', () => {
    const first = newlyUnlocked({ ...base, wins: 1 }, []);
    expect(first.fresh.map((a) => a.id)).toEqual(['first_win']);
    expect(first.unlocked).toEqual(['first_win']);

    // Already have first_win; now also reach a 3-streak.
    const second = newlyUnlocked({ ...base, wins: 3, best: 3 }, first.unlocked);
    expect(second.fresh.map((a) => a.id)).toEqual(['hot_hand']);
    expect(second.unlocked).toEqual(expect.arrayContaining(['first_win', 'hot_hand']));
  });

  it('never re-awards an already-unlocked achievement', () => {
    const again = newlyUnlocked({ ...base, wins: 5 }, ['first_win']);
    expect(again.fresh.map((a) => a.id)).not.toContain('first_win');
  });
});

describe('statsOf + catalogView', () => {
  it('reads tallies straight off player state', () => {
    const p = { ...newPlayerState(), wins: 2, plays: 4, best: 3, games: ['coin', 'dice'], totalWon: 12 };
    const s = statsOf(p);
    expect(s).toMatchObject({ wins: 2, plays: 4, best: 3, distinctGames: 2, totalWon: 12 });
  });

  it('annotates the full catalog with unlocked flags', () => {
    const view = catalogView(['first_win']);
    expect(view).toHaveLength(ACHIEVEMENTS.length);
    expect(view.find((a) => a.id === 'first_win')?.unlocked).toBe(true);
    expect(view.find((a) => a.id === 'centurion')?.unlocked).toBe(false);
  });
});

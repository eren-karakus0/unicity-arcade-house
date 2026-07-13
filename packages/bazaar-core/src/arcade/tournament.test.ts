import { describe, expect, it } from 'vitest';
import { Tournament } from './tournament.js';

const T0 = 1_000_000; // fixed epoch base for deterministic windows

describe('Tournament', () => {
  it('scores net winnings and ranks the standings', () => {
    const t = new Tournament({ lengthMs: 1000, prizeUct: 25, now: T0 });
    t.record('a', 'alice', '0xA', 5);
    t.record('b', 'bob', '0xB', 8);
    t.record('a', 'alice', '0xA', 4); // alice -> 9
    const s = t.view(T0).standings;
    expect(s.map((x) => x.name)).toEqual(['alice', 'bob']);
    expect(s[0]).toEqual({ name: 'alice', score: 9 });
  });

  it('ignores non-positive scores', () => {
    const t = new Tournament({ lengthMs: 1000, now: T0 });
    t.record('a', 'alice', '0xA', 0);
    t.record('b', 'bob', '0xB', -3);
    expect(t.view(T0).standings).toEqual([]);
  });

  it('crowns the podium and returns the payable finishers when the window closes', () => {
    const t = new Tournament({ lengthMs: 1000, prizeUct: 25, now: T0 });
    t.record('a', 'alice', '0xA', 5);
    t.record('b', 'bob', '0xB', 9);
    expect(t.maybeRoll(T0 + 500)).toEqual([]); // still open
    const closed = t.maybeRoll(T0 + 1000); // boundary reached
    // Two scorers -> two podium places: 60% and 25% of the pool (min 1 each).
    expect(closed).toHaveLength(2);
    expect(closed.find((c) => c.rank === 1)).toMatchObject({ name: 'bob', address: '0xB', score: 9, prize: 15 });
    expect(closed.find((c) => c.rank === 2)).toMatchObject({ name: 'alice', address: '0xA', score: 5, prize: 6 });
    // scores reset for the new window; the winner leads the champions list.
    expect(t.view(T0 + 1000).standings).toEqual([]);
    expect(t.view(T0 + 1000).champions[0]).toMatchObject({ name: 'bob', score: 9, rank: 1 });
  });

  it('splits the pool 60/25/15 across a full podium and ignores fourth place', () => {
    const t = new Tournament({ lengthMs: 1000, prizeUct: 100, now: T0 });
    t.record('a', 'a', '0xA', 40);
    t.record('b', 'b', '0xB', 30);
    t.record('c', 'c', '0xC', 20);
    t.record('d', 'd', '0xD', 10);
    const closed = t.maybeRoll(T0 + 1000);
    expect(closed.map((c) => [c.rank, c.name, c.prize])).toEqual(
      expect.arrayContaining([
        [1, 'a', 60],
        [2, 'b', 25],
        [3, 'c', 15],
      ]),
    );
    expect(closed).toHaveLength(3);
    // champions[0..2] read winner-first.
    expect(t.view(T0 + 1000).champions.slice(0, 3).map((c) => c.rank)).toEqual([1, 2, 3]);
  });

  it('advances the window so a second roll in the same period pays nothing', () => {
    const t = new Tournament({ lengthMs: 1000, prizeUct: 25, now: T0 });
    t.record('a', 'alice', '0xA', 3);
    expect(t.maybeRoll(T0 + 1000)).toHaveLength(1);
    expect(t.maybeRoll(T0 + 1000)).toEqual([]); // idempotent within the window
    // the new window ends one length later
    expect(t.view(T0 + 1000).endsAt).toBe(T0 + 2000);
  });

  it('closes multiple elapsed windows but only crowns ones with a leader', () => {
    const t = new Tournament({ lengthMs: 1000, prizeUct: 10, now: T0 });
    t.record('a', 'alice', '0xA', 4); // only the first window has activity
    const closed = t.maybeRoll(T0 + 3500); // 3 windows elapsed
    expect(closed).toHaveLength(1); // only the first had a scorer
    expect(closed[0]).toMatchObject({ name: 'alice' });
    expect(t.view(T0 + 3500).endsAt).toBe(T0 + 4000);
  });

  it('does not pay an anonymous leader but still crowns them', () => {
    const t = new Tournament({ lengthMs: 1000, prizeUct: 10, now: T0 });
    t.record('anon', 'anon', undefined, 6);
    const closed = t.maybeRoll(T0 + 1000);
    expect(closed).toEqual([]); // no address to pay
    expect(t.view(T0 + 1000).champions[0]).toMatchObject({ name: 'anon', score: 6 });
  });

  it('caps the champions history at 12', () => {
    const t = new Tournament({ lengthMs: 1000, prizeUct: 10, now: T0 });
    for (let i = 0; i < 16; i++) {
      t.record(`p${i}`, `p${i}`, `0x${i}`, 1);
      t.maybeRoll(T0 + (i + 1) * 1000);
    }
    expect(t.view(T0 + 16000).champions).toHaveLength(12);
  });
});

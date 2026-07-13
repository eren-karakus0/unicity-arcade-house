/**
 * A rolling tournament: a fixed-length window where players race on net UCT
 * won. When a window elapses the top scorer is crowned and paid a fixed prize
 * on-chain by the house — an autonomous, recurring competition with no operator
 * in the loop. Kept free of the dealer so the window/scoring logic is
 * unit-tested on its own; the dealer drives the clock and settles prizes.
 *
 * State is in-memory (per server session). On restart the current window
 * resets — honest for a testnet demo, and the champions list is session-scoped.
 */
export interface TournamentStanding {
  name: string;
  score: number;
}

export interface TournamentChampion {
  name: string;
  score: number;
  /** When the window closed (ms). */
  at: number;
  prize: number;
  /** Podium position (1..3). Absent on entries from before the ladder. */
  rank?: number;
}

/** A window that just closed with a payable podium finisher (has an address). */
export interface ClosedWindow {
  name: string;
  address: string;
  score: number;
  prize: number;
  at: number;
  /** Podium position (1..3). */
  rank: number;
}

/** The prize ladder: the pool splits 60/25/15 across the podium. */
export const PODIUM_SPLIT = [0.6, 0.25, 0.15] as const;

export interface TournamentView {
  /** When the current window ends (ms since epoch). */
  endsAt: number;
  lengthMs: number;
  prize: number;
  standings: TournamentStanding[];
  champions: TournamentChampion[];
}

/** Durable slice of the tournament: the live window (start + scores) + champions. */
export interface TournamentSnapshot {
  start: number;
  scores: [string, { name: string; address?: string; score: number }][];
  champions: TournamentChampion[];
}

interface Score {
  name: string;
  address: string | undefined;
  score: number;
}

export class Tournament {
  private start: number;
  private readonly len: number;
  private readonly prize: number;
  private readonly scores = new Map<string, Score>();
  private champions: TournamentChampion[] = [];

  constructor(opts: { lengthMs?: number; prizeUct?: number; now?: number } = {}) {
    this.len = Math.max(1, opts.lengthMs ?? 60 * 60_000); // default 1h
    this.prize = Math.max(0, opts.prizeUct ?? 25);
    this.start = opts.now ?? Date.now();
  }

  get prizeUct(): number {
    return this.prize;
  }

  /**
   * Advance past any elapsed windows. Each closed window crowns its PODIUM —
   * the top three scorers split the prize pool 60/25/15 (each cut at least 1,
   * only real scorers place). Every finisher is recorded in the champions
   * list; the ones with a chain address are returned for the caller to pay.
   * Idempotent: after rolling, `start` is past `now`, so a second call in the
   * same window returns nothing.
   */
  maybeRoll(now: number): ClosedWindow[] {
    const closed: ClosedWindow[] = [];
    while (now >= this.start + this.len) {
      const at = this.start + this.len;
      const podium = [...this.scores.values()]
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, PODIUM_SPLIT.length);
      // Record ranks 3→1 so champions[0] is always the window's winner.
      for (let i = podium.length - 1; i >= 0; i--) {
        const s = podium[i]!;
        const cut = Math.max(1, Math.round(this.prize * PODIUM_SPLIT[i]!));
        this.champions.unshift({ name: s.name, score: s.score, at, prize: cut, rank: i + 1 });
        if (s.address) {
          closed.push({ name: s.name, address: s.address, score: s.score, prize: cut, at, rank: i + 1 });
        }
      }
      if (this.champions.length > 12) this.champions.length = 12;
      this.scores.clear();
      this.start = at;
    }
    return closed;
  }

  /** Credit net winnings toward the current window's score (ignores <= 0). */
  record(key: string, name: string, address: string | undefined, netWon: number): void {
    if (netWon <= 0) return;
    const cur = this.scores.get(key) ?? { name, address, score: 0 };
    cur.name = name;
    if (address) cur.address = address;
    cur.score += netWon;
    this.scores.set(key, cur);
  }

  standings(limit = 8): TournamentStanding[] {
    return [...this.scores.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => ({ name: s.name, score: s.score }));
  }

  view(_now: number): TournamentView {
    return {
      endsAt: this.start + this.len,
      lengthMs: this.len,
      prize: this.prize,
      standings: this.standings(),
      champions: [...this.champions],
    };
  }

  /** Serialize the live window (start + scores) and past champions for persistence. */
  snapshot(): TournamentSnapshot {
    return {
      start: this.start,
      scores: [...this.scores].map(
        ([k, s]): [string, { name: string; address?: string; score: number }] => [
          k,
          { name: s.name, ...(s.address ? { address: s.address } : {}), score: s.score },
        ],
      ),
      champions: [...this.champions],
    };
  }

  /** Restore a prior window + champions. The configured length/prize are kept. */
  restore(s: TournamentSnapshot | null | undefined): void {
    if (!s) return;
    if (typeof s.start === 'number') this.start = s.start;
    this.scores.clear();
    for (const [k, v] of s.scores ?? []) {
      this.scores.set(k, { name: v.name, address: v.address, score: v.score });
    }
    this.champions = Array.isArray(s.champions) ? [...s.champions] : [];
  }
}

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
}

/** A window that just closed with a payable leader (has a chain address). */
export interface ClosedWindow {
  name: string;
  address: string;
  score: number;
  prize: number;
  at: number;
}

export interface TournamentView {
  /** When the current window ends (ms since epoch). */
  endsAt: number;
  lengthMs: number;
  prize: number;
  standings: TournamentStanding[];
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
   * Advance past any elapsed windows. Each closed window crowns its top scorer
   * (recorded in the champions list) and, if that leader has a chain address,
   * returns them for the caller to pay. Idempotent: after rolling, `start` is
   * past `now`, so a second call in the same window returns nothing.
   */
  maybeRoll(now: number): ClosedWindow[] {
    const closed: ClosedWindow[] = [];
    while (now >= this.start + this.len) {
      const at = this.start + this.len;
      const leader = this.leader();
      if (leader && leader.score > 0) {
        this.champions.unshift({ name: leader.name, score: leader.score, at, prize: this.prize });
        if (this.champions.length > 10) this.champions.length = 10;
        if (leader.address) {
          closed.push({ name: leader.name, address: leader.address, score: leader.score, prize: this.prize, at });
        }
      }
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

  private leader(): Score | undefined {
    let best: Score | undefined;
    for (const s of this.scores.values()) {
      if (!best || s.score > best.score) best = s;
    }
    return best;
  }

  standings(limit = 8): TournamentStanding[] {
    return [...this.scores.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => ({ name: s.name, score: s.score }));
  }

  view(now: number): TournamentView {
    return {
      endsAt: this.start + this.len,
      lengthMs: this.len,
      prize: this.prize,
      standings: this.standings(),
      champions: [...this.champions],
    };
  }
}

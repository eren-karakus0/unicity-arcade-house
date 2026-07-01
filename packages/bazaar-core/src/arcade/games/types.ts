export type Outcome = 'win' | 'lose' | 'tie';

export interface Deal {
  /** Hidden value, as a string, that is committed then revealed. */
  secret: string;
  /** Optional public info shown to the player when the round starts. */
  publicState?: Record<string, unknown>;
}

export interface Judged {
  outcome: Outcome;
  /** Win reward = dealer base reward × this multiplier. */
  rewardMult: number;
  /** Game-specific data to display on reveal. */
  reveal: Record<string, unknown>;
}

/**
 * A provably-fair house game. The dealer commits `deal().secret`, the player
 * supplies input (a choice, or a client seed), and `judge` decides the outcome.
 */
export interface Game {
  readonly id: string;
  readonly title: string;
  readonly blurb: string;
  /** Win reward multiplier, for display (actual comes from judge). */
  readonly rewardMult: number;
  /** 'choice' = player picks; 'seed' = player contributes entropy (dice). */
  readonly inputKind: 'choice' | 'seed';
  deal(): Deal;
  /** Validate/normalize the player's raw input. Throws on invalid input. */
  resolveInput(raw: unknown): unknown;
  judge(secret: string, input: unknown, publicState?: Record<string, unknown>): Judged;
}

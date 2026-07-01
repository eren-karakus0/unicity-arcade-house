import { randomBytes } from 'node:crypto';

// Commit/nonce helpers now live in ./rng (shared by every arcade game); re-export
// them here so existing imports of `commitHash` / `makeNonce` keep working.
export { commitHash, makeNonce } from './rng.js';

/**
 * Rock–paper–scissors primitives, kept pure and dependency-free so they are
 * trivially testable and identical on both sides of the provably-fair
 * commit/reveal (the browser re-hashes `${move}:${nonce}` to check the dealer
 * never changed its move after seeing yours).
 */
export type Move = 'rock' | 'paper' | 'scissors';
export const MOVES: readonly Move[] = ['rock', 'paper', 'scissors'];

/** Outcome from the player's perspective. */
export type Outcome = 'win' | 'lose' | 'tie';

const BEATS: Record<Move, Move> = { rock: 'scissors', paper: 'rock', scissors: 'paper' };

export function isMove(x: unknown): x is Move {
  return x === 'rock' || x === 'paper' || x === 'scissors';
}

/** Judge a round from the player's perspective. */
export function judge(player: Move, dealer: Move): Outcome {
  if (player === dealer) return 'tie';
  return BEATS[player] === dealer ? 'win' : 'lose';
}

/** Uniform random move (rejection sampling to avoid modulo bias). */
export function randomMove(): Move {
  let byte = 252;
  while (byte >= 252) {
    // 252 = 84 * 3 — the largest multiple of 3 that fits in a byte.
    byte = randomBytes(1)[0] ?? 0;
  }
  return MOVES[byte % 3] as Move;
}


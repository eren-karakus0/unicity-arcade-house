import { createHash, randomBytes, randomInt } from 'node:crypto';

/**
 * Shared, dependency-free randomness + commitment helpers for the arcade.
 * Every game commits sha256(`${secret}:${nonce}`) before the player acts; the
 * browser re-hashes the reveal to prove the house could not change its hidden
 * value afterwards.
 */
export function makeNonce(): string {
  return randomBytes(16).toString('hex');
}

export function commitHash(secret: string, nonce: string): string {
  return createHash('sha256').update(`${secret}:${nonce}`).digest('hex');
}

/** A fresh server seed (used by the two-seed provably-fair dice duel). */
export function serverSeed(): string {
  return randomBytes(16).toString('hex');
}

export function rollDie(): number {
  return randomInt(1, 7); // 1..6, unbiased
}

export function coinFlip(): 'heads' | 'tails' {
  return randomInt(0, 2) === 0 ? 'heads' : 'tails';
}

export function cardRank(): number {
  return randomInt(1, 14); // 1..13
}

/**
 * Derive both dice from the house's committed server seed and the player's
 * client seed. Neither side can steer the result: the house commits its seed
 * before seeing the client seed, and the client seed is unknown to the house at
 * commit time. Kept identical on the browser so the player can recompute it.
 */
export function deriveDicePair(server: string, client: string): { house: number; player: number } {
  const h = createHash('sha256').update(`${server}:${client}`).digest('hex');
  const house = (parseInt(h.slice(0, 8), 16) % 6) + 1;
  const player = (parseInt(h.slice(8, 16), 16) % 6) + 1;
  return { house, player };
}

/**
 * Derive the wheel's landing segment from the committed server seed and the
 * player's client seed — same two-seed scheme as the dice duel, and identical
 * on the browser so the player can recompute the landing.
 */
export function deriveWheelIndex(server: string, client: string, segmentCount: number): number {
  const h = createHash('sha256').update(`${server}:${client}`).digest('hex');
  return parseInt(h.slice(0, 8), 16) % segmentCount;
}

/**
 * Derive the Plinko ball's left/right decisions (one bit per peg row) from the
 * committed server seed + the player's client seed. The landing bucket is the
 * number of rights — reproducible in the browser bit for bit.
 */
export function derivePlinkoPath(server: string, client: string, rows: number): number[] {
  const h = createHash('sha256').update(`${server}:${client}`).digest('hex');
  return Array.from({ length: rows }, (_, i) => parseInt(h[i]!, 16) & 1);
}

/**
 * The progressive-jackpot roll for a round: derived from the committed secret
 * and the player's own input, so neither side can steer it. A roll of 0 hits.
 */
export function deriveJackpotRoll(secret: string, input: string, odds: number): number {
  const h = createHash('sha256').update(`${secret}:jackpot:${input}`).digest('hex');
  return parseInt(h.slice(0, 6), 16) % odds;
}

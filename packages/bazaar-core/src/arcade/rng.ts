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

/**
 * Derive a Limbo/Crash multiplier (×100, integer) from the committed server
 * seed + the player's client seed — the classic 96%-RTP curve: with
 * r uniform in (0, 1], the result is max(1.00, 0.96 / r), floored to 2
 * decimals and capped at ×10 000. P(result ≥ t) = 0.96 / t, so a winning
 * target t pays ×t for an even 0.96 expected return at every target.
 * Two-seed on purpose: a continuous outcome is grind-prone with a
 * server-only secret; the unknown client seed removes that lever.
 */
export function deriveCrashPointX100(server: string, client: string): number {
  const h = createHash('sha256').update(`${server}:${client}`).digest('hex');
  const r = (parseInt(h.slice(0, 8), 16) + 1) / 0x100000000; // (0, 1]
  const x100 = Math.floor((0.96 / r) * 100);
  return Math.max(100, Math.min(1_000_000, x100));
}

/**
 * Derive the mine layout for a Mines board from the committed secret alone
 * (the player's input is WHICH cells to pick — the layout must be fixed and
 * sealed before that choice, and the commitment proves it was). A seeded
 * Fisher–Yates shuffle over the cell indices, randomness drawn from a
 * sha256 chain, first `count` cells become mines. Returns them sorted.
 */
export function deriveMines(secret: string, count: number, cells: number): number[] {
  const idx = Array.from({ length: cells }, (_, i) => i);
  // Digest chain: h0 = sha256(secret:mines), h(n+1) = sha256(h(n)); consume
  // 8 hex chars (32 bits) per draw, refilling from the chain as needed.
  let block = createHash('sha256').update(`${secret}:mines`).digest('hex');
  let offset = 0;
  const draw = (): number => {
    if (offset + 8 > block.length) {
      block = createHash('sha256').update(block).digest('hex');
      offset = 0;
    }
    const v = parseInt(block.slice(offset, offset + 8), 16);
    offset += 8;
    return v;
  };
  for (let i = cells - 1; i > 0; i--) {
    const j = draw() % (i + 1);
    [idx[i], idx[j]] = [idx[j]!, idx[i]!];
  }
  return idx.slice(0, count).sort((a, b) => a - b);
}

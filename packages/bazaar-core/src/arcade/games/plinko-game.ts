import { derivePlinkoPath, serverSeed } from '../rng.js';
import type { Game } from './types.js';

/**
 * Plinko — the ball falls through PLINKO_ROWS rows of pegs, going left (0) or
 * right (1) at each. Every decision bit derives from sha256 of the committed
 * server seed + the player's client seed, so the whole path is two-seed
 * provably fair and the browser can re-derive it bit for bit.
 *
 * The bucket is the number of rights (binomial — the centre is common, the
 * edges are rare and pay big).
 */
export const PLINKO_ROWS = 12;
export const PLINKO_MULTIPLIERS: readonly number[] = [10, 4, 2, 1, 1, 1, 0, 1, 1, 1, 2, 4, 10];

export const plinkoGame: Game = {
  id: 'plinko',
  title: 'Plinko',
  blurb: 'Drop the ball — edge buckets pay ×10. Two-seed fair.',
  rewardMult: 10, // display: the top multiplier (actual comes from judge)
  inputKind: 'seed',
  deal() {
    return {
      secret: serverSeed(),
      publicState: { rows: PLINKO_ROWS, multipliers: [...PLINKO_MULTIPLIERS] },
    };
  },
  resolveInput(raw) {
    const s = typeof raw === 'string' ? raw.trim() : '';
    if (!/^[0-9a-zA-Z]{4,64}$/.test(s)) throw new Error('Missing or invalid client seed.');
    return s;
  },
  judge(secret, input) {
    const path = derivePlinkoPath(secret, input as string, PLINKO_ROWS);
    const bucketIndex = path.reduce((a, b) => a + b, 0);
    const multiplier = PLINKO_MULTIPLIERS[bucketIndex]!;
    return {
      outcome: multiplier > 0 ? 'win' : 'lose',
      rewardMult: multiplier,
      reveal: {
        path,
        bucketIndex,
        multiplier,
        multipliers: [...PLINKO_MULTIPLIERS],
        clientSeed: input,
      },
    };
  },
};

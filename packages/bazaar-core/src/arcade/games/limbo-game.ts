import { deriveCrashPointX100, serverSeed } from '../rng.js';
import type { Game } from './types.js';

/**
 * Limbo — pick a target multiplier; the committed result must reach it.
 * Two-seed provably fair: the result derives from the house's sealed seed +
 * the player's client seed, so the house can't grind a low number and the
 * player can't steer a high one. A winning target ×t pays ×t (96% RTP flat
 * across every target — the maths is in deriveCrashPointX100).
 */

export const LIMBO_MIN_TARGET_X100 = 101; // ×1.01
export const LIMBO_MAX_TARGET_X100 = 100_000; // ×1000.00

/** Parse + validate a `{ target, seed }` input into `${targetX100}:${seed}`. */
export function resolveTargetSeed(raw: unknown): string {
  const o = (raw ?? {}) as Record<string, unknown>;
  const target = Number(o.target);
  const seed = typeof o.seed === 'string' ? o.seed.trim() : '';
  const x100 = Math.round(target * 100);
  if (!Number.isFinite(target) || x100 < LIMBO_MIN_TARGET_X100 || x100 > LIMBO_MAX_TARGET_X100) {
    throw new Error('Pick a target multiplier between ×1.01 and ×1000.');
  }
  if (!/^[0-9a-zA-Z]{4,64}$/.test(seed)) throw new Error('Missing or invalid client seed.');
  return `${x100}:${seed}`;
}

export function judgeTargetSeed(secret: string, resolved: string): {
  win: boolean;
  targetX100: number;
  resultX100: number;
  clientSeed: string;
} {
  const sep = resolved.indexOf(':');
  const targetX100 = Number(resolved.slice(0, sep));
  const clientSeed = resolved.slice(sep + 1);
  const resultX100 = deriveCrashPointX100(secret, clientSeed);
  return { win: resultX100 >= targetX100, targetX100, resultX100, clientSeed };
}

export const limboGame: Game = {
  id: 'limbo',
  title: 'Limbo',
  blurb: 'Name your multiplier — the sealed result must reach it. Higher target, higher payout, same fair odds.',
  rewardMult: 2,
  inputKind: 'choice',
  deal() {
    return { secret: serverSeed() };
  },
  resolveInput(raw) {
    return resolveTargetSeed(raw);
  },
  judge(secret, input) {
    const { win, targetX100, resultX100, clientSeed } = judgeTargetSeed(secret, input as string);
    return {
      outcome: win ? 'win' : 'lose',
      rewardMult: win ? targetX100 / 100 : 2,
      reveal: { clientSeed, targetX100, resultX100 },
    };
  },
};

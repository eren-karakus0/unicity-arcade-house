import { rollDie } from '../rng.js';
import type { Game } from './types.js';

/** Lucky Number — guess the house's sealed number 1–6. Nail it, win 5×. */
export const numberGame: Game = {
  id: 'number',
  title: 'Lucky Number',
  blurb: 'Guess the sealed number from 1–6. Nail it and win 5×.',
  rewardMult: 5,
  inputKind: 'choice',
  deal() {
    return { secret: String(rollDie()) };
  },
  resolveInput(raw) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 6) throw new Error('Guess a number from 1 to 6.');
    return n;
  },
  judge(secret, input) {
    const n = Number(secret);
    const win = input === n;
    return { outcome: win ? 'win' : 'lose', rewardMult: 5, reveal: { secret: n, guess: input } };
  },
};

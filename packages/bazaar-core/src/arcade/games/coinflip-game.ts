import { coinFlip } from '../rng.js';
import type { Game } from './types.js';

export const coinGame: Game = {
  id: 'coin',
  title: 'Coin Flip',
  blurb: 'Call it. The coin is sealed before you choose.',
  rewardMult: 1,
  inputKind: 'choice',
  deal() {
    return { secret: coinFlip() };
  },
  resolveInput(raw) {
    if (raw !== 'heads' && raw !== 'tails') throw new Error('Call heads or tails.');
    return raw;
  },
  judge(secret, input) {
    const outcome = input === secret ? 'win' : 'lose';
    return { outcome, rewardMult: 1, reveal: { result: secret, call: input } };
  },
};

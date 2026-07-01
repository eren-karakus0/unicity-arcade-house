import { cardRank } from '../rng.js';
import type { Game } from './types.js';

/**
 * High · Low — a current card is shown; predict whether the house's sealed next
 * card is higher or lower. Equal ranks push (tie).
 */
export const highlowGame: Game = {
  id: 'highlow',
  title: 'High · Low',
  blurb: 'A card is shown. Is the sealed next card higher or lower?',
  rewardMult: 1,
  inputKind: 'choice',
  deal() {
    const current = cardRank();
    return { secret: String(cardRank()), publicState: { current } };
  },
  resolveInput(raw) {
    if (raw !== 'higher' && raw !== 'lower') throw new Error('Pick higher or lower.');
    return raw;
  },
  judge(secret, input, publicState) {
    const next = Number(secret);
    const current = Number(publicState?.current ?? 0);
    if (next === current) return { outcome: 'tie', rewardMult: 1, reveal: { current, next } };
    const isHigher = next > current;
    const win = (input === 'higher' && isHigher) || (input === 'lower' && !isHigher);
    return { outcome: win ? 'win' : 'lose', rewardMult: 1, reveal: { current, next } };
  },
};

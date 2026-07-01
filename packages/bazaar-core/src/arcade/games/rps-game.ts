import { isMove, judge as judgeRps, randomMove, type Move } from '../rps.js';
import type { Game } from './types.js';

export const rpsGame: Game = {
  id: 'rps',
  title: 'Rock · Paper · Scissors',
  blurb: 'The classic. Beat the house’s sealed move.',
  rewardMult: 1,
  inputKind: 'choice',
  deal() {
    return { secret: randomMove() };
  },
  resolveInput(raw) {
    if (!isMove(raw)) throw new Error('Pick rock, paper, or scissors.');
    return raw;
  },
  judge(secret, input) {
    const outcome = judgeRps(input as Move, secret as Move);
    return { outcome, rewardMult: 1, reveal: { dealerMove: secret, playerMove: input } };
  },
};

import { deriveDicePair, serverSeed } from '../rng.js';
import type { Game } from './types.js';

/**
 * Dice Duel — a two-seed provably-fair game. The house commits a server seed;
 * the player contributes a client seed; both dice derive from sha256 of the
 * two. Neither side can steer the roll.
 */
export const diceGame: Game = {
  id: 'dice',
  title: 'Dice Duel',
  blurb: 'You and the house each roll — higher wins. Both dice come from your seed + the house’s sealed seed.',
  rewardMult: 1,
  inputKind: 'seed',
  deal() {
    return { secret: serverSeed() };
  },
  resolveInput(raw) {
    const s = typeof raw === 'string' ? raw.trim() : '';
    if (!/^[0-9a-zA-Z]{4,64}$/.test(s)) throw new Error('Missing or invalid client seed.');
    return s;
  },
  judge(secret, input) {
    const { house, player } = deriveDicePair(secret, input as string);
    const outcome = player > house ? 'win' : player < house ? 'lose' : 'tie';
    return { outcome, rewardMult: 1, reveal: { playerRoll: player, dealerRoll: house, clientSeed: input } };
  },
};

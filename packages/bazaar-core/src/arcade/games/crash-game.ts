import { serverSeed } from '../rng.js';
import { judgeTargetSeed, resolveTargetSeed } from './limbo-game.js';
import type { Game } from './types.js';

/**
 * Crash — set your auto cash-out, watch the multiplier climb, survive the
 * bust. Single-player, one-shot and provably fair: the crash point is sealed
 * (committed) before you choose, derived from the house seed + your client
 * seed, and the whole flight is verifiable afterwards. Same 96%-RTP curve as
 * Limbo — the difference is the ride. Live multi-player rounds are an
 * always-on-host upgrade, deliberately not promised on the free tier.
 */
export const crashGame: Game = {
  id: 'crash',
  title: 'Crash',
  blurb: 'Set your cash-out, ride the curve, beat the bust. The crash point is sealed before you fly.',
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
      reveal: { clientSeed, targetX100, crashX100: resultX100 },
    };
  },
};

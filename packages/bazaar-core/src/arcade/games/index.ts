import type { Game } from './types.js';
import { rpsGame } from './rps-game.js';
import { diceGame } from './dice-game.js';
import { coinGame } from './coinflip-game.js';
import { highlowGame } from './highlow-game.js';
import { numberGame } from './numberguess-game.js';
import { wheelGame, WHEEL_SEGMENTS } from './wheel-game.js';
import { plinkoGame, PLINKO_MULTIPLIERS, PLINKO_ROWS } from './plinko-game.js';

export * from './types.js';
export {
  rpsGame,
  diceGame,
  coinGame,
  highlowGame,
  numberGame,
  wheelGame,
  plinkoGame,
  WHEEL_SEGMENTS,
  PLINKO_MULTIPLIERS,
  PLINKO_ROWS,
};

export const GAME_LIST: readonly Game[] = [
  rpsGame,
  wheelGame,
  plinkoGame,
  diceGame,
  coinGame,
  highlowGame,
  numberGame,
];

// Null-prototype map so a lookup like GAMES['__proto__'] resolves to undefined
// (and hits the "Unknown game" guard) instead of inheriting Object.prototype.
export const GAMES: Record<string, Game> = GAME_LIST.reduce<Record<string, Game>>(
  (acc, g) => {
    acc[g.id] = g;
    return acc;
  },
  Object.create(null),
);

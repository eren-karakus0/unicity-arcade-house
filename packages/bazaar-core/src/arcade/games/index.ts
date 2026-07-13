import type { Game } from './types.js';
import { rpsGame } from './rps-game.js';
import { diceGame } from './dice-game.js';
import { coinGame } from './coinflip-game.js';
import { highlowGame } from './highlow-game.js';
import { numberGame } from './numberguess-game.js';
import { wheelGame, WHEEL_SEGMENTS } from './wheel-game.js';
import { plinkoGame, PLINKO_MULTIPLIERS, PLINKO_ROWS } from './plinko-game.js';
import { limboGame, LIMBO_MIN_TARGET_X100, LIMBO_MAX_TARGET_X100 } from './limbo-game.js';
import { crashGame } from './crash-game.js';
import { minesGame, MINES_CELLS, MINES_COUNT, MINES_MAX_PICKS, MINES_MULTIPLIERS } from './mines-game.js';

export * from './types.js';
export {
  rpsGame,
  diceGame,
  coinGame,
  highlowGame,
  numberGame,
  wheelGame,
  plinkoGame,
  limboGame,
  crashGame,
  minesGame,
  WHEEL_SEGMENTS,
  PLINKO_MULTIPLIERS,
  PLINKO_ROWS,
  LIMBO_MIN_TARGET_X100,
  LIMBO_MAX_TARGET_X100,
  MINES_CELLS,
  MINES_COUNT,
  MINES_MAX_PICKS,
  MINES_MULTIPLIERS,
};

export const GAME_LIST: readonly Game[] = [
  crashGame,
  limboGame,
  minesGame,
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

import type { Game } from './types.js';
import { rpsGame } from './rps-game.js';
import { diceGame } from './dice-game.js';
import { coinGame } from './coinflip-game.js';
import { highlowGame } from './highlow-game.js';
import { numberGame } from './numberguess-game.js';

export * from './types.js';
export { rpsGame, diceGame, coinGame, highlowGame, numberGame };

export const GAME_LIST: readonly Game[] = [rpsGame, diceGame, coinGame, highlowGame, numberGame];

export const GAMES: Record<string, Game> = Object.fromEntries(GAME_LIST.map((g) => [g.id, g]));

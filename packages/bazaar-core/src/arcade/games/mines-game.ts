import { deriveMines, serverSeed } from '../rng.js';
import type { Game } from './types.js';

/**
 * Mines (one-shot) — 5 mines hide on a 5×5 board, sealed by the commitment
 * BEFORE you pick. Choose 1–8 cells in one go; all safe pays the bracket
 * multiplier, any mine loses the bet. The layout derives from the committed
 * secret alone (deriveMines), so the reveal lets anyone reproduce the whole
 * board. Multipliers are the fair odds × 0.96 (same house edge as Limbo):
 * P(K safe) = C(20,K)/C(25,K), payout = 0.96 / P.
 */

export const MINES_CELLS = 25;
export const MINES_COUNT = 5;

/** Payout (total-return multiplier, 2dp) per number of picked cells. */
export const MINES_MULTIPLIERS: Record<number, number> = {
  1: 1.2, // P=0.8
  2: 1.52, // P=0.6333…
  3: 1.94, // P=0.4956…
  4: 2.51, // P=0.3830…
  5: 3.3, // P=0.2913…
  6: 4.41, // P=0.2175…
  7: 6.02, // P=0.1594…
  8: 8.39, // P=0.1144…
};
export const MINES_MAX_PICKS = 8;

export const minesGame: Game = {
  id: 'mines',
  title: 'Mines',
  blurb: '5 mines sealed on a 5×5 board. Pick up to 8 cells — clear them all and the bracket pays up to ×8.39.',
  rewardMult: 8,
  inputKind: 'choice',
  deal() {
    return {
      secret: serverSeed(),
      publicState: { cells: MINES_CELLS, mines: MINES_COUNT, multipliers: MINES_MULTIPLIERS },
    };
  },
  resolveInput(raw) {
    const arr = Array.isArray(raw) ? raw : null;
    if (!arr || arr.length < 1 || arr.length > MINES_MAX_PICKS) {
      throw new Error(`Pick between 1 and ${MINES_MAX_PICKS} cells.`);
    }
    const picks = arr.map((v) => Math.floor(Number(v)));
    if (picks.some((p) => !Number.isFinite(p) || p < 0 || p >= MINES_CELLS)) {
      throw new Error('Picks must be board cells (0–24).');
    }
    if (new Set(picks).size !== picks.length) throw new Error('Each cell can be picked once.');
    return [...picks].sort((a, b) => a - b);
  },
  judge(secret, input) {
    const picks = input as number[];
    const mines = deriveMines(secret, MINES_COUNT, MINES_CELLS);
    const mineSet = new Set(mines);
    const hit = picks.filter((p) => mineSet.has(p));
    const win = hit.length === 0;
    return {
      outcome: win ? 'win' : 'lose',
      rewardMult: win ? (MINES_MULTIPLIERS[picks.length] ?? 1) : 2,
      reveal: { mines, picks, hit },
    };
  },
};

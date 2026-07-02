import { describe, expect, it } from 'vitest';
import { commitHash, deriveDicePair, deriveJackpotRoll, derivePlinkoPath, deriveWheelIndex } from './rng.js';
import {
  GAMES,
  PLINKO_MULTIPLIERS,
  PLINKO_ROWS,
  WHEEL_SEGMENTS,
  coinGame,
  diceGame,
  highlowGame,
  numberGame,
  plinkoGame,
  rpsGame,
  wheelGame,
} from './games/index.js';
import { GameDealer } from './game-dealer.js';
import type { SphereAgent } from '../sphere-agent.js';

describe('arcade game registry', () => {
  it('registers all seven games by id', () => {
    expect(Object.keys(GAMES).sort()).toEqual(['coin', 'dice', 'highlow', 'number', 'plinko', 'rps', 'wheel']);
  });
});

describe('coin flip', () => {
  it('wins iff the call matches the sealed result', () => {
    expect(coinGame.judge('heads', 'heads').outcome).toBe('win');
    expect(coinGame.judge('heads', 'tails').outcome).toBe('lose');
  });
  it('rejects invalid calls', () => {
    expect(() => coinGame.resolveInput('edge')).toThrow();
  });
});

describe('lucky number', () => {
  it('pays 5× only on an exact guess', () => {
    const win = numberGame.judge('4', 4);
    expect(win.outcome).toBe('win');
    expect(win.rewardMult).toBe(5);
    expect(numberGame.judge('4', 5).outcome).toBe('lose');
  });
  it('rejects out-of-range guesses', () => {
    expect(() => numberGame.resolveInput(0)).toThrow();
    expect(() => numberGame.resolveInput(7)).toThrow();
  });
});

describe('high · low', () => {
  it('judges relative to the shown card and pushes on equal', () => {
    expect(highlowGame.judge('9', 'higher', { current: 5 }).outcome).toBe('win');
    expect(highlowGame.judge('3', 'higher', { current: 5 }).outcome).toBe('lose');
    expect(highlowGame.judge('3', 'lower', { current: 5 }).outcome).toBe('win');
    expect(highlowGame.judge('5', 'higher', { current: 5 }).outcome).toBe('tie');
  });
});

describe('dice duel (two-seed provably fair)', () => {
  it('derives identical dice from the same seeds', () => {
    const a = deriveDicePair('serverAAA', 'clientBBB');
    const b = deriveDicePair('serverAAA', 'clientBBB');
    expect(a).toEqual(b);
    expect(a.house).toBeGreaterThanOrEqual(1);
    expect(a.house).toBeLessThanOrEqual(6);
    expect(a.player).toBeGreaterThanOrEqual(1);
    expect(a.player).toBeLessThanOrEqual(6);
  });
  it('judge matches the derived rolls', () => {
    const seed = 'deadbeefcafe';
    const client = 'player123';
    const { house, player } = deriveDicePair(seed, client);
    const r = diceGame.judge(seed, client);
    expect(r.reveal).toEqual({ playerRoll: player, dealerRoll: house, clientSeed: client });
    expect(r.outcome).toBe(player > house ? 'win' : player < house ? 'lose' : 'tie');
  });
  it('rejects a missing client seed', () => {
    expect(() => diceGame.resolveInput('')).toThrow();
  });
});

describe('lucky wheel (two-seed provably fair)', () => {
  it('lands deterministically from the same seeds, inside the wheel', () => {
    const a = deriveWheelIndex('serverAAA', 'clientBBB', WHEEL_SEGMENTS.length);
    const b = deriveWheelIndex('serverAAA', 'clientBBB', WHEEL_SEGMENTS.length);
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(WHEEL_SEGMENTS.length);
  });
  it('pays the landed segment multiplier and publishes the layout', () => {
    const { publicState } = wheelGame.deal();
    expect(publicState?.segments).toEqual([...WHEEL_SEGMENTS]);
    const index = deriveWheelIndex('deadbeef', 'player123', WHEEL_SEGMENTS.length);
    const r = wheelGame.judge('deadbeef', 'player123');
    expect(r.reveal.segmentIndex).toBe(index);
    expect(r.rewardMult).toBe(WHEEL_SEGMENTS[index]);
    expect(r.outcome).toBe(WHEEL_SEGMENTS[index]! > 0 ? 'win' : 'lose');
  });
  it('has losing segments and a ×5 jackpot', () => {
    expect(WHEEL_SEGMENTS).toContain(0);
    expect(Math.max(...WHEEL_SEGMENTS)).toBe(5);
  });
  it('rejects a missing client seed', () => {
    expect(() => wheelGame.resolveInput('')).toThrow();
  });
});

describe('plinko (two-seed provably fair)', () => {
  it('derives the same path from the same seeds, one bit per row', () => {
    const a = derivePlinkoPath('srv', 'cli', PLINKO_ROWS);
    const b = derivePlinkoPath('srv', 'cli', PLINKO_ROWS);
    expect(a).toEqual(b);
    expect(a).toHaveLength(PLINKO_ROWS);
    expect(a.every((bit) => bit === 0 || bit === 1)).toBe(true);
  });
  it('bucket = number of rights, pays the bucket multiplier', () => {
    const path = derivePlinkoPath('deadbeef', 'player123', PLINKO_ROWS);
    const bucket = path.reduce((x, y) => x + y, 0);
    const r = plinkoGame.judge('deadbeef', 'player123');
    expect(r.reveal.path).toEqual(path);
    expect(r.reveal.bucketIndex).toBe(bucket);
    expect(r.rewardMult).toBe(PLINKO_MULTIPLIERS[bucket]);
    expect(r.outcome).toBe(PLINKO_MULTIPLIERS[bucket]! > 0 ? 'win' : 'lose');
  });
  it('publishes the board layout up front and has symmetric ×10 edges', () => {
    const { publicState } = plinkoGame.deal();
    expect(publicState?.rows).toBe(PLINKO_ROWS);
    expect(publicState?.multipliers).toEqual([...PLINKO_MULTIPLIERS]);
    expect(PLINKO_MULTIPLIERS[0]).toBe(10);
    expect(PLINKO_MULTIPLIERS[PLINKO_MULTIPLIERS.length - 1]).toBe(10);
    expect(PLINKO_MULTIPLIERS).toHaveLength(PLINKO_ROWS + 1);
  });
});

describe('progressive jackpot', () => {
  const stubAgent = (sent: { address: string; amount: number; memo?: string }[]) =>
    ({
      nametag: 'house-test',
      balanceUct: async () => 1000,
      mintUct: async () => undefined,
      send: async (address: string, amount: number, memo?: string) => {
        sent.push({ address, amount, memo });
        return { id: `tx-${sent.length}`, deliveryState: 'landed' };
      },
    }) as unknown as SphereAgent;

  it('roll is deterministic and inside the odds', () => {
    const a = deriveJackpotRoll('sec', 'rock', 150);
    expect(deriveJackpotRoll('sec', 'rock', 150)).toBe(a);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(150);
  });

  it('pays the whole pot on a hit and resets it (odds=1 forces a hit)', async () => {
    const sent: { address: string; amount: number; memo?: string }[] = [];
    const dealer = new GameDealer({
      agent: stubAgent(sent),
      cooldownMs: 0,
      jackpotSeedUct: 20,
      jackpotOdds: 1, // every roll is 0 → always hits
    });
    const nr = dealer.newRound('coin', '@p1');
    expect(nr.jackpotUct).toBe(20);
    const res = await dealer.play({ roundId: nr.roundId, choice: 'heads', playerAddress: '@p1', name: 'p1' });
    expect(res.jackpot.hit).toBe(true);
    expect(res.jackpot.paid).toBe(true);
    expect(res.jackpot.potUct).toBe(20);
    expect(sent.some((s) => s.memo === 'arcade-jackpot' && s.amount === 20)).toBe(true);
    const stats = await dealer.houseStats();
    expect(stats.jackpotUct).toBe(20); // reset to seed
    expect(stats.feed.some((e) => e.kind === 'jackpot')).toBe(true);
  });

  it('grows the pot (capped) when the roll misses', async () => {
    const sent: { address: string; amount: number; memo?: string }[] = [];
    const dealer = new GameDealer({
      agent: stubAgent(sent),
      cooldownMs: 0,
      jackpotSeedUct: 20,
      jackpotGrowthUct: 1,
      jackpotOdds: 1_000_000_000, // a hit is (practically) impossible
    });
    const nr = dealer.newRound('coin', '@p1');
    const res = await dealer.play({ roundId: nr.roundId, choice: 'heads', playerAddress: '@p1', name: 'p1' });
    expect(res.jackpot.hit).toBe(false);
    expect((await dealer.houseStats()).jackpotUct).toBe(21);
    expect(sent.every((s) => s.memo !== 'arcade-jackpot')).toBe(true);
  });
});

describe('rps game wrapper', () => {
  it('reveals the dealer + player move and its commit verifies', () => {
    const { secret } = rpsGame.deal();
    const nonce = 'n0nce';
    const commit = commitHash(secret, nonce);
    expect(commitHash(secret, nonce)).toBe(commit);
    const r = rpsGame.judge(secret, 'rock');
    expect(r.reveal.dealerMove).toBe(secret);
    expect(['win', 'lose', 'tie']).toContain(r.outcome);
  });
});

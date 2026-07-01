import { describe, expect, it } from 'vitest';
import { commitHash, deriveDicePair } from './rng.js';
import { GAMES, coinGame, diceGame, highlowGame, numberGame, rpsGame } from './games/index.js';

describe('arcade game registry', () => {
  it('registers all five games by id', () => {
    expect(Object.keys(GAMES).sort()).toEqual(['coin', 'dice', 'highlow', 'number', 'rps']);
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

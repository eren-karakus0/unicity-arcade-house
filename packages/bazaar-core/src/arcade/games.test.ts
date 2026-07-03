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
    const m = WHEEL_SEGMENTS[index]!;
    expect(r.outcome).toBe(m > 1 ? 'win' : m === 1 ? 'tie' : 'lose');
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
    const m = PLINKO_MULTIPLIERS[bucket]!;
    expect(r.outcome).toBe(m > 1 ? 'win' : m === 1 ? 'tie' : 'lose');
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
    expect(res.jackpot.potUct).toBe(20);
    await dealer.flushPayouts(); // the payout settles in the background
    const settlement = dealer.settlementFor(nr.roundId);
    expect(settlement.jackpot?.status).toBe('landed');
    expect(settlement.jackpot?.txId).toBeTruthy();
    expect(sent.some((s) => s.memo === 'arcade-jackpot' && s.amount === 20)).toBe(true);
    const stats = await dealer.houseStats();
    expect(stats.jackpotUct).toBe(20); // reset to seed
    expect(stats.feed.some((e) => e.kind === 'jackpot')).toBe(true);
  });

  it('restores the pot (not more) when a jackpot payout fails', async () => {
    const failing = {
      nametag: 'house-test',
      balanceUct: async () => 1000,
      mintUct: async () => undefined,
      send: async () => {
        throw new Error('testnet down');
      },
    } as unknown as SphereAgent;
    const dealer = new GameDealer({
      agent: failing,
      cooldownMs: 0,
      jackpotSeedUct: 20,
      jackpotOdds: 1, // every roll hits
    });
    const nr = dealer.newRound('coin', '@pj');
    const res = await dealer.play({ roundId: nr.roundId, choice: 'heads', playerAddress: '@pj', name: 'pj' });
    expect(res.jackpot.hit).toBe(true);
    await dealer.flushPayouts();
    expect(dealer.settlementFor(nr.roundId).jackpot?.status).toBe('failed');
    // The hit optimistically reset the pot to the seed; a failed payout must put
    // it back to the pre-hit value (20), not seed + amount (40).
    const stats = await dealer.houseStats();
    expect(stats.jackpotUct).toBe(20);
  });

  it('rejects bets above the balance (no fixed cap)', async () => {
    const dealer = new GameDealer({ agent: stubAgent([]), cooldownMs: 0 });
    const nr = dealer.newRound('coin', '@p2');
    await expect(
      dealer.play({ roundId: nr.roundId, choice: 'heads', bet: 26, playerAddress: '@p2' }),
    ).rejects.toThrow(/not enough uct/i);
  });
});

describe('UCT balance — welcome stake, bets, deposits, withdraw', () => {
  const stubAgent = (sent: { address: string; amount: number; memo?: string }[]) =>
    ({
      nametag: 'house-test',
      uctCoin: { coinId: 'aabb', decimals: 2 },
      toHuman: (smallest: bigint | string) => (Number(BigInt(smallest)) / 100).toString(),
      balanceUct: async () => 1000,
      mintUct: async () => undefined,
      send: async (address: string, amount: number, memo?: string) => {
        sent.push({ address, amount, memo });
        return { id: `tx-${sent.length}`, deliveryState: 'landed' };
      },
    }) as unknown as SphereAgent;

  it('grants the 5 UCT welcome once, stakes bets, credits x2 wins, sinks losses', async () => {
    const sent: { address: string; amount: number; memo?: string }[] = [];
    const dealer = new GameDealer({ agent: stubAgent(sent), cooldownMs: 0, jackpotOdds: 1_000_000_000 });
    let round = dealer.newRound('coin', '@p1');
    expect(round.you?.chips).toBe(5); // one-time welcome
    expect(round.you?.chipsGranted).toBe(5);
    let win: Awaited<ReturnType<GameDealer['play']>> | undefined;
    let lose: typeof win;
    for (let i = 0; i < 80 && !(win && lose); i++) {
      let r: NonNullable<typeof win>;
      try {
        r = await dealer.play({ roundId: round.roundId, choice: 'heads', bet: 1, playerAddress: '@p1', name: 'p1' });
      } catch {
        break; // busted — the welcome never repeats
      }
      if (r.outcome === 'win' && !win) win = r;
      if (r.outcome === 'lose' && !lose) lose = r;
      expect(r.chips).toBeGreaterThanOrEqual(0);
      round = dealer.newRound('coin', '@p1');
    }
    if (win) {
      expect(win.rewardUct).toBeGreaterThanOrEqual(2); // bet x2 (+ any bonus)
    }
    if (lose) expect(lose.rewardUct).toBe(0);
    expect(sent.every((s) => s.memo !== 'arcade-win')).toBe(true); // wins credit the balance, not on-chain
    expect(round.you?.chipsGranted).toBe(0); // welcome only once
  });

  it('credits an incoming wallet transfer to the sender, idempotently', () => {
    const dealer = new GameDealer({ agent: stubAgent([]), cooldownMs: 0 });
    const pubkey = '02abc';
    dealer.newRound('coin', pubkey); // welcome 5
    const transfer = {
      id: 'RECEIVED_v2_tr-1',
      senderPubkey: pubkey,
      senderNametag: 'p9',
      amountBase: '1000', // 10.00 with 2 decimals
    };
    const credited = dealer.creditDeposit(transfer);
    expect(credited?.credited).toBe(10);
    expect(dealer.balanceOf(pubkey).balanceUct).toBe(15);
    expect(dealer.creditDeposit(transfer)).toBeNull(); // same transfer id → no double credit
    expect(dealer.balanceOf(pubkey).balanceUct).toBe(15);
  });

  it('depositInfo exposes the house address + coin metadata', () => {
    const dealer = new GameDealer({ agent: stubAgent([]), cooldownMs: 0 });
    expect(dealer.depositInfo()).toEqual({ to: '@house-test', coinId: 'aabb', decimals: 2, symbol: 'UCT' });
  });

  it('withdraw settles the whole balance on-chain and zeroes it (no re-grant)', async () => {
    const sent: { address: string; amount: number; memo?: string }[] = [];
    const dealer = new GameDealer({ agent: stubAgent(sent), cooldownMs: 0 });
    dealer.newRound('coin', '@p3'); // welcome 5
    const co = dealer.cashOut('@p3', 'p3');
    expect(co.amountUct).toBe(5);
    await dealer.flushPayouts();
    expect(dealer.settlementFor(co.settlementId).win?.status).toBe('landed');
    expect(sent.some((s) => s.memo === 'arcade-cashout' && s.amount === 5)).toBe(true);
    expect(dealer.newRound('coin', '@p3').you?.chips).toBe(0); // welcome never repeats
  });

  it('a failed withdraw puts the balance back', async () => {
    const failing = {
      nametag: 'house-test',
      uctCoin: { coinId: 'aabb', decimals: 2 },
      toHuman: (smallest: bigint | string) => (Number(BigInt(smallest)) / 100).toString(),
      balanceUct: async () => 1000,
      mintUct: async () => undefined,
      send: async () => {
        throw new Error('testnet down');
      },
    } as unknown as SphereAgent;
    const dealer = new GameDealer({ agent: failing, cooldownMs: 0 });
    dealer.newRound('coin', '@p4'); // welcome 5
    const co = dealer.cashOut('@p4', 'p4');
    await dealer.flushPayouts();
    expect(dealer.settlementFor(co.settlementId).win?.status).toBe('failed');
    expect(dealer.newRound('coin', '@p4').you?.chips).toBe(5); // restored
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

describe('achievements — dealer wiring', () => {
  const stubAgent = () =>
    ({
      nametag: 'house-test',
      uctCoin: { coinId: 'aabb', decimals: 2 },
      toHuman: (smallest: bigint | string) => (Number(BigInt(smallest)) / 100).toString(),
      balanceUct: async () => 1000,
      mintUct: async () => undefined,
      send: async () => ({ id: 'tx', deliveryState: 'landed' }),
    }) as unknown as SphereAgent;

  it('unlocks "jackpot" once on a forced hit and credits nothing extra (pot is the reward)', async () => {
    const dealer = new GameDealer({ agent: stubAgent(), cooldownMs: 0, jackpotOdds: 1 });
    const nr = dealer.newRound('coin', '@a1');
    const res = await dealer.play({ roundId: nr.roundId, choice: 'heads', bet: 1, playerAddress: '@a1', name: 'a1' });
    expect(res.jackpot.hit).toBe(true);
    expect(res.achievements.some((a) => a.id === 'jackpot')).toBe(true);
    // The jackpot badge carries no UCT reward (the pot itself is the prize).
    const jackpotBadge = res.achievements.find((a) => a.id === 'jackpot');
    expect(jackpotBadge?.reward).toBe(0);

    // Playing again does not re-award it.
    const nr2 = dealer.newRound('coin', '@a1');
    const res2 = await dealer.play({ roundId: nr2.roundId, choice: 'heads', bet: 1, playerAddress: '@a1', name: 'a1' });
    expect(res2.achievements.some((a) => a.id === 'jackpot')).toBe(false);
  });

  it('unlocks "first_win" on the first win and reports it in the catalog', async () => {
    const dealer = new GameDealer({ agent: stubAgent(), cooldownMs: 0, jackpotOdds: 1_000_000_000 });
    // Fund a deep balance so a long cold streak can't bust before the first win
    // (coin is 50/50; 100 straight losses is ~1 in 2^100).
    dealer.creditDeposit({ id: 'seed-a2', amountBase: '20000', senderPubkey: '@a2' });
    let firstWinSeen = false;
    for (let i = 0; i < 100 && !firstWinSeen; i++) {
      const nr = dealer.newRound('coin', '@a2');
      let r: Awaited<ReturnType<GameDealer['play']>>;
      try {
        r = await dealer.play({ roundId: nr.roundId, choice: 'heads', bet: 1, playerAddress: '@a2', name: 'a2' });
      } catch {
        break; // busted
      }
      if (r.outcome === 'win') {
        expect(r.achievements.some((a) => a.id === 'first_win')).toBe(true);
        expect(r.achievementBonus).toBeGreaterThanOrEqual(1); // first_win grants 1 UCT
        firstWinSeen = true;
      }
    }
    expect(firstWinSeen).toBe(true);
    const catalog = dealer.achievementsOf('@a2');
    expect(catalog.find((a) => a.id === 'first_win')?.unlocked).toBe(true);
    expect(catalog.length).toBeGreaterThan(1);
  });

  it('tracks distinct games played toward the explorer badge', async () => {
    const dealer = new GameDealer({ agent: stubAgent(), cooldownMs: 0, jackpotOdds: 1_000_000_000 });
    for (const g of ['coin', 'rps', 'dice']) {
      const nr = dealer.newRound(g, '@a3');
      const choice = g === 'dice' ? 'seed1234' : g === 'rps' ? 'rock' : 'heads';
      try {
        await dealer.play({ roundId: nr.roundId, choice, bet: 1, playerAddress: '@a3', name: 'a3' });
      } catch {
        /* a loss can bust the welcome stake; the play still counted */
      }
    }
    // explorer needs all 7; with 3 distinct games it stays locked but is tracked.
    const catalog = dealer.achievementsOf('@a3');
    expect(catalog.find((a) => a.id === 'explorer')?.unlocked).toBe(false);
  });
});

describe('tournament — dealer wiring', () => {
  const stubAgent = (sent: { address: string; amount: number; memo?: string }[]) =>
    ({
      nametag: 'house-test',
      uctCoin: { coinId: 'aabb', decimals: 2 },
      toHuman: (smallest: bigint | string) => (Number(BigInt(smallest)) / 100).toString(),
      balanceUct: async () => 1000,
      mintUct: async () => undefined,
      send: async (address: string, amount: number, memo?: string) => {
        sent.push({ address, amount, memo });
        return { id: `tx-${sent.length}`, deliveryState: 'landed' };
      },
    }) as unknown as SphereAgent;

  it('scores wins and exposes a live tournament view', async () => {
    const dealer = new GameDealer({ agent: stubAgent([]), cooldownMs: 0, jackpotOdds: 1_000_000_000 });
    dealer.creditDeposit({ id: 'seed-t1', amountBase: '20000', senderPubkey: '@t1' });
    let scored = false;
    for (let i = 0; i < 60 && !scored; i++) {
      const nr = dealer.newRound('coin', '@t1');
      const r = await dealer.play({ roundId: nr.roundId, choice: 'heads', bet: 1, playerAddress: '@t1', name: 't1' });
      if (r.outcome === 'win') scored = true;
    }
    expect(scored).toBe(true);
    const view = dealer.tournamentView();
    expect(view.prize).toBeGreaterThan(0);
    expect(view.endsAt).toBeGreaterThan(Date.now());
    expect(view.standings.find((s) => s.name === 't1')?.score).toBeGreaterThanOrEqual(1);
  });

  it('crowns and pays the champion on-chain when the window closes', async () => {
    const sent: { address: string; amount: number; memo?: string }[] = [];
    // A 50ms window forces a close within the test.
    const dealer = new GameDealer({
      agent: stubAgent(sent),
      cooldownMs: 0,
      jackpotOdds: 1_000_000_000,
      tournamentLengthMs: 50,
      tournamentPrizeUct: 25,
    });
    dealer.creditDeposit({ id: 'seed-t2', amountBase: '20000', senderPubkey: '@t2' });
    // Rack up at least one win so there's a scorer for the window.
    for (let i = 0; i < 60; i++) {
      const nr = dealer.newRound('coin', '@t2');
      const r = await dealer.play({ roundId: nr.roundId, choice: 'heads', bet: 1, playerAddress: '@t2', name: 't2' });
      if (r.outcome === 'win') break;
    }
    await new Promise((r) => setTimeout(r, 70)); // let the window elapse
    // Any dealer touch rolls the window and enqueues the prize payout.
    dealer.newRound('coin', '@t2');
    await dealer.flushPayouts();
    expect(sent.some((s) => s.memo === 'arcade-tournament' && s.amount === 25)).toBe(true);
    const view = dealer.tournamentView();
    expect(view.champions[0]).toMatchObject({ name: 't2', prize: 25 });
    const stats = await dealer.houseStats();
    expect(stats.feed.some((e) => e.kind === 'tournament')).toBe(true);
  });
});

describe('referral — dealer wiring', () => {
  const stubAgent = () =>
    ({
      nametag: 'house-test',
      uctCoin: { coinId: 'aabb', decimals: 2 },
      toHuman: (smallest: bigint | string) => (Number(BigInt(smallest)) / 100).toString(),
      balanceUct: async () => 1000,
      mintUct: async () => undefined,
      send: async () => ({ id: 'tx', deliveryState: 'landed' }),
    }) as unknown as SphereAgent;

  const firstPlay = async (dealer: GameDealer, addr: string, name: string, ref?: string) => {
    const nr = dealer.newRound('coin', addr);
    return dealer.play({ roundId: nr.roundId, choice: 'heads', bet: 1, playerAddress: addr, name, ...(ref ? { ref } : {}) });
  };

  it('gives a stable, resolvable code and credits both sides once', async () => {
    const dealer = new GameDealer({ agent: stubAgent(), cooldownMs: 0, jackpotOdds: 1_000_000_000 });
    // Referrer must be seen first so their code resolves.
    dealer.newRound('coin', '@ref1');
    const code = dealer.referralInfo('@ref1').code!;
    expect(code).toMatch(/^[0-9A-Z]{6}$/);

    const before = dealer.balanceOf('@ref1').balanceUct; // welcome 5
    const res = await firstPlay(dealer, '@newbie', 'newbie', code);
    expect(res.referral?.welcomeBonus).toBe(2);
    // referee: welcome 5 + referral welcome 2, minus/plus the round result
    expect(dealer.balanceOf('@newbie').balanceUct).toBeGreaterThanOrEqual(6);
    // referrer: +5 referral bonus, referrals incremented
    expect(dealer.balanceOf('@ref1').balanceUct).toBe(before + 5);
    expect(dealer.referralInfo('@ref1').referrals).toBe(1);

    // A second play with the same code does not re-apply.
    const again = await firstPlay(dealer, '@newbie', 'newbie', code);
    expect(again.referral).toBeUndefined();
    expect(dealer.referralInfo('@ref1').referrals).toBe(1);
  });

  it('ignores self-referral and unknown codes', async () => {
    const dealer = new GameDealer({ agent: stubAgent(), cooldownMs: 0, jackpotOdds: 1_000_000_000 });
    dealer.newRound('coin', '@solo');
    const own = dealer.referralInfo('@solo').code!;
    const res = await firstPlay(dealer, '@solo', 'solo', own); // self-referral
    expect(res.referral).toBeUndefined();

    const res2 = await firstPlay(dealer, '@other', 'other', 'ZZZZZZ'); // unknown code
    expect(res2.referral).toBeUndefined();
    expect(dealer.referralInfo('@other').referred).toBe(false);
  });
});

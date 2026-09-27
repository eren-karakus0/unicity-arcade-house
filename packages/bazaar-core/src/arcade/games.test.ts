import { describe, expect, it } from 'vitest';
import { commitHash, deriveDicePair, deriveJackpotRoll, derivePlinkoPath, deriveWheelIndex } from './rng.js';
import {
  GAMES,
  MINES_CELLS,
  MINES_COUNT,
  MINES_MULTIPLIERS,
  PLINKO_MULTIPLIERS,
  PLINKO_ROWS,
  WHEEL_SEGMENTS,
  coinGame,
  crashGame,
  diceGame,
  highlowGame,
  limboGame,
  minesGame,
  numberGame,
  plinkoGame,
  rpsGame,
  wheelGame,
} from './games/index.js';
import { deriveCrashPointX100, deriveMines } from './rng.js';
import { GameDealer } from './game-dealer.js';
import { applyProgress, newPlayerState, progressView, xpForBet, TIERS } from './events-logic.js';
import type { SphereAgent } from '../sphere-agent.js';

describe('arcade game registry', () => {
  it('registers all ten games by id', () => {
    expect(Object.keys(GAMES).sort()).toEqual([
      'coin',
      'crash',
      'dice',
      'highlow',
      'limbo',
      'mines',
      'number',
      'plinko',
      'rps',
      'wheel',
    ]);
  });
});

describe('XP, tiers & rakeback (retention spine)', () => {
  it('scales XP logarithmically — whales cannot buy the ladder in one hand', () => {
    expect(xpForBet(1)).toBe(10);
    expect(xpForBet(10)).toBe(35);
    expect(xpForBet(1000)).toBe(100);
    expect(xpForBet(1_000_000)).toBe(199);
    expect(xpForBet(0)).toBe(0);
  });

  it('accrues rakeback on losses in milli-chips, crediting whole chips', () => {
    // Bronze = 2%: a 30-chip loss accrues 600 milli — no credit yet…
    const s = newPlayerState();
    let u = applyProgress(s, 30, 'lose');
    expect(u.rakeCredited).toBe(0);
    expect(u.state.rakeMilli).toBe(600);
    // …a second 30-chip loss crosses 1000 milli → 1 chip back.
    u = applyProgress(u.state, 30, 'lose');
    expect(u.rakeCredited).toBe(1);
    expect(u.state.rakeMilli).toBe(200);
    expect(u.state.chips).toBe(1);
    // Wins and ties never accrue.
    expect(applyProgress(u.state, 100, 'win').rakeCredited).toBe(0);
    expect(applyProgress(u.state, 100, 'tie').rakeCredited).toBe(0);
  });

  it('grants each tier bonus exactly once, even across a multi-tier jump', () => {
    const s = { ...newPlayerState(), xp: 999 };
    // One round jumping straight past Silver (1000) into Gold (5000).
    const u = applyProgress({ ...s, xp: 4995 }, 2, 'win'); // +16 xp → 5011
    expect(u.levelUp).toEqual({ tier: 'Gold', bonus: TIERS[1]!.bonus + TIERS[2]!.bonus });
    expect(u.state.tierIdx).toBe(2);
    // The next round grants nothing new.
    expect(applyProgress(u.state, 2, 'win').levelUp).toBeNull();
  });

  it('progressView reports tier, next threshold and rakeback rate', () => {
    const v = progressView({ ...newPlayerState(), xp: 1200, tierIdx: 1 });
    expect(v).toMatchObject({ tier: 'Silver', nextTierXp: 5000, rakebackPct: 4 });
    const top = progressView({ ...newPlayerState(), xp: 80_000, tierIdx: 4 });
    expect(top).toMatchObject({ tier: 'Diamond', nextTierXp: null, rakebackPct: 10 });
  });
});

describe('limbo + crash (target-vs-sealed-multiplier)', () => {
  it('derives the multiplier deterministically from both seeds', () => {
    const a = deriveCrashPointX100('server-seed', 'client-seed');
    expect(deriveCrashPointX100('server-seed', 'client-seed')).toBe(a);
    expect(deriveCrashPointX100('server-seed', 'other-client')).not.toBe(a);
    expect(a).toBeGreaterThanOrEqual(100);
    expect(a).toBeLessThanOrEqual(1_000_000);
  });

  it('wins iff the derived result reaches the target, paying x target', () => {
    const secret = 'sealed';
    const resultX100 = deriveCrashPointX100(secret, 'seed1234');
    const below = (resultX100 - 1) / 100;
    const above = (resultX100 + 1) / 100;
    const win = limboGame.judge(secret, limboGame.resolveInput({ target: below, seed: 'seed1234' }));
    expect(win.outcome).toBe('win');
    expect(win.rewardMult).toBeCloseTo(below, 2);
    const lose = limboGame.judge(secret, limboGame.resolveInput({ target: above, seed: 'seed1234' }));
    expect(lose.outcome).toBe('lose');
    // Crash shares the exact same fair core, different reveal naming.
    const crash = crashGame.judge(secret, crashGame.resolveInput({ target: below, seed: 'seed1234' }));
    expect(crash.outcome).toBe('win');
    expect(crash.reveal.crashX100).toBe(resultX100);
  });

  it('rejects out-of-range targets and bad seeds', () => {
    expect(() => limboGame.resolveInput({ target: 1.0, seed: 'seed1234' })).toThrow(/target/i);
    expect(() => limboGame.resolveInput({ target: 5000, seed: 'seed1234' })).toThrow(/target/i);
    expect(() => limboGame.resolveInput({ target: 2, seed: '!!' })).toThrow(/seed/i);
  });

  it('keeps a flat ~96% RTP across targets (law of the curve, sampled)', () => {
    // P(result >= t) = 0.96/t exactly, so win-rate x payout ≈ 0.96 for any t.
    const N = 4000;
    for (const target of [1.5, 2, 5]) {
      let wins = 0;
      for (let i = 0; i < N; i++) {
        if (deriveCrashPointX100('rtp-secret', `seed-${target}-${i}`) >= target * 100) wins++;
      }
      const rtp = (wins / N) * target;
      expect(rtp).toBeGreaterThan(0.9);
      expect(rtp).toBeLessThan(1.02);
    }
  });
});

describe('mines (one-shot board)', () => {
  it('derives a deterministic, distinct, in-range layout', () => {
    const mines = deriveMines('board-secret', MINES_COUNT, MINES_CELLS);
    expect(deriveMines('board-secret', MINES_COUNT, MINES_CELLS)).toEqual(mines);
    expect(mines).toHaveLength(MINES_COUNT);
    expect(new Set(mines).size).toBe(MINES_COUNT);
    expect(mines.every((m) => m >= 0 && m < MINES_CELLS)).toBe(true);
    expect(deriveMines('other-secret', MINES_COUNT, MINES_CELLS)).not.toEqual(mines);
  });

  it('wins when every pick is safe, loses on any mine', () => {
    const secret = 'board-secret';
    const mines = new Set(deriveMines(secret, MINES_COUNT, MINES_CELLS));
    const safe = Array.from({ length: MINES_CELLS }, (_, i) => i).filter((i) => !mines.has(i));
    const win = minesGame.judge(secret, minesGame.resolveInput(safe.slice(0, 3)));
    expect(win.outcome).toBe('win');
    expect(win.rewardMult).toBe(MINES_MULTIPLIERS[3]);
    const lose = minesGame.judge(secret, minesGame.resolveInput([safe[0]!, [...mines][0]!]));
    expect(lose.outcome).toBe('lose');
    expect((lose.reveal.hit as number[]).length).toBe(1);
  });

  it('validates picks: 1-8 distinct cells on the board', () => {
    expect(() => minesGame.resolveInput([])).toThrow(/between 1 and/i);
    expect(() => minesGame.resolveInput([1, 2, 3, 4, 5, 6, 7, 8, 9])).toThrow(/between 1 and/i);
    expect(() => minesGame.resolveInput([25])).toThrow(/cells/i);
    expect(() => minesGame.resolveInput([3, 3])).toThrow(/once/i);
  });

  it('keeps every bracket at the same ~96% expected return', () => {
    // payout(K) = 0.96 / P(K safe) with P = C(20,K)/C(25,K).
    const p = (k: number): number => {
      let v = 1;
      for (let i = 0; i < k; i++) v *= (20 - i) / (25 - i);
      return v;
    };
    for (let k = 1; k <= 8; k++) {
      const ev = MINES_MULTIPLIERS[k]! * p(k);
      expect(ev).toBeGreaterThan(0.94);
      expect(ev).toBeLessThan(0.98);
    }
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

  it('keeps the jackpot durably pending (pot stays at seed) when the payout fails', async () => {
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
    // A failed jackpot payout keeps the pot reset to the seed (20) and records
    // the owed jackpot in the durable pending ledger — retried on boot rather
    // than lost. It is NOT put back into the pot (that would double-credit a
    // later successful retry).
    const stats = await dealer.houseStats();
    expect(stats.jackpotUct).toBe(20);
    expect(stats.pendingPrizes.some((p) => p.amountUct === 20)).toBe(true);
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

  describe('a withdraw whose send may already be on-chain', () => {
    // Refunding the chips while the payment can still land would pay twice:
    // the player keeps the UCT and cashes the chips out again.
    const keptOpenCashoutAgent = () =>
      ({
        nametag: 'house-test',
        uctCoin: { coinId: 'aabb', decimals: 2 },
        toHuman: (s: bigint | string) => (Number(BigInt(s)) / 100).toString(),
        toSmallest: (h: string | number) => String(Math.round(Number(h) * 100)),
        balanceUct: async () => 1000,
        mintUct: async () => undefined,
        resumeOpenTransfers: async () => undefined,
        pendingTransfers: async () => [],
        getHistory: async () => [] as unknown[],
        send: async () => {
          throw Object.assign(new Error('Split burn failed: certification unconfirmed'), {
            code: 'CERTIFICATION_UNCONFIRMED',
          });
        },
      }) as unknown as SphereAgent & { getHistory: () => Promise<unknown[]> };

    const keptOpenCashout = async () => {
      const agent = keptOpenCashoutAgent();
      const dealer = new GameDealer({ agent, cooldownMs: 0 });
      dealer.newRound('coin', '02cash'); // welcome 5
      dealer.cashOut('02cash', 'cash');
      await dealer.flushPayouts();
      return { agent, dealer };
    };

    it('withholds the chips and owes the withdraw instead of refunding it', async () => {
      const { dealer } = await keptOpenCashout();

      expect(dealer.balanceOf('02cash').balanceUct).toBe(0);
      const owed = (await dealer.houseStats()).pendingPrizes;
      expect(owed).toHaveLength(1);
      expect(owed[0]!.amountUct).toBe(5);
    });

    it('retires the owed withdraw once the wallet shows it was sent', async () => {
      const { agent, dealer } = await keptOpenCashout();
      agent.getHistory = async () => [
        { id: 'h1', type: 'SENT', amount: '500', memo: 'arcade-cashout', timestamp: Date.now(), recipientPubkey: '02cash' },
      ];

      await dealer.resumeOpenTransfers();
      const res = await dealer.reconcileOpenPrizes();

      expect(res).toEqual({ settled: 1, released: 0 });
      expect((await dealer.houseStats()).pendingPrizes).toHaveLength(0);
      expect(dealer.balanceOf('02cash').balanceUct).toBe(0);
    });
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
    // Single scorer -> rank-1 cut of the 25 pool: round(25*0.6) = 15.
    expect(sent.some((s) => s.memo === 'arcade-tournament' && s.amount === 15)).toBe(true);
    const view = dealer.tournamentView();
    expect(view.champions[0]).toMatchObject({ name: 't2', prize: 15, rank: 1 });
    const stats = await dealer.houseStats();
    expect(stats.feed.some((e) => e.kind === 'tournament')).toBe(true);
  });

  it('keeps a crowned prize pending on a failed send and pays it on retry (durable)', async () => {
    // A send that fails until flipped live — models the process losing the
    // fire-and-forget payout, then a later boot re-attempting it.
    let live = false;
    const sent: { address: string; amount: number; memo?: string }[] = [];
    const flaky = {
      nametag: 'house-test',
      uctCoin: { coinId: 'aabb', decimals: 2 },
      toHuman: (smallest: bigint | string) => (Number(BigInt(smallest)) / 100).toString(),
      balanceUct: async () => 1000,
      mintUct: async () => undefined,
      send: async (address: string, amount: number, memo?: string) => {
        if (!live) throw new Error('testnet down');
        sent.push({ address, amount, memo });
        return { id: `tx-${sent.length}`, deliveryState: 'landed' };
      },
    } as unknown as SphereAgent;
    const opts = { cooldownMs: 0, jackpotOdds: 1_000_000_000, tournamentLengthMs: 50, tournamentPrizeUct: 25 };
    const dealer = new GameDealer({ agent: flaky, ...opts });
    dealer.creditDeposit({ id: 'seed-t3', amountBase: '20000', senderPubkey: '@t3' });
    for (let i = 0; i < 60; i++) {
      const nr = dealer.newRound('coin', '@t3');
      const r = await dealer.play({ roundId: nr.roundId, choice: 'heads', bet: 1, playerAddress: '@t3', name: 't3' });
      if (r.outcome === 'win') break;
    }
    await new Promise((r) => setTimeout(r, 70)); // let the window elapse
    dealer.newRound('coin', '@t3'); // rolls the window → prize enqueued, send fails
    await dealer.flushPayouts();

    // Nothing paid, but the prize is owed and the failure is visible for diagnosis.
    const owed = (await dealer.houseStats()).pendingPrizes;
    expect((await dealer.houseStats()).paidOutUct).toBe(0);
    expect(owed.length).toBeGreaterThanOrEqual(1);
    expect(owed.some((p) => p.name === 't3' && p.amountUct === 15)).toBe(true);
    expect(owed.every((p) => p.tries >= 1 && !!p.lastError)).toBe(true);

    // The owed prize survives a restart: snapshot → restore into a fresh dealer,
    // then a retry (with the chain back) pays it and clears the ledger.
    expect(dealer.snapshot().pendingPrizes.length).toBeGreaterThanOrEqual(1);
    const rebooted = new GameDealer({ agent: flaky, ...opts });
    rebooted.restore(dealer.snapshot());
    live = true;
    rebooted.retryPendingPrizes();
    await rebooted.flushPayouts();
    const after = await rebooted.houseStats();
    expect(sent.some((s) => s.memo === 'arcade-tournament' && s.amount === 15)).toBe(true);
    expect(after.paidOutUct).toBeGreaterThanOrEqual(15);
    expect(after.pendingPrizes).toHaveLength(0);
  });

  it('tops the float up once when the treasury reads rich but nothing is spendable', async () => {
    // The wallet reports a healthy confirmed balance while coin selection has
    // no unreserved tokens to draw on. Reading the balance alone, the house
    // considers itself funded and never tops up, so every payout fails forever
    // - the shape that stranded a real prize backlog. A minted token is not
    // spendable the moment the mint resolves, so the top-up must NOT rescue
    // this payout inline: doing that mints again on the next owed prize, and
    // the next, minting without bound while nothing is ever paid.
    const mints: number[] = [];
    let spendable = false;
    const locked = {
      nametag: 'house-test',
      uctCoin: { coinId: 'aabb', decimals: 2 },
      toHuman: (smallest: bigint | string) => (Number(BigInt(smallest)) / 100).toString(),
      balanceUct: async () => 1_000_000, // rich on paper
      mintUct: async (amount: number) => {
        mints.push(amount);
        return undefined;
      },
      send: async (_address: string, amount: number) => {
        if (!spendable) {
          throw Object.assign(new Error('Insufficient balance for this transaction'), {
            code: 'SEND_INSUFFICIENT_BALANCE',
          });
        }
        return { id: `tx-${amount}`, deliveryState: 'landed' };
      },
    } as unknown as SphereAgent;

    const dealer = new GameDealer({ agent: locked, cooldownMs: 0, jackpotSeedUct: 20, jackpotOdds: 1 });
    const nr = dealer.newRound('coin', '@lk');
    await dealer.play({ roundId: nr.roundId, choice: 'heads', playerAddress: '@lk', name: 'lk' });
    await dealer.flushPayouts();

    // It topped up, the prize stayed owed, and it did not mint per attempt.
    expect(mints).toHaveLength(1);
    expect((await dealer.houseStats()).pendingPrizes.length).toBeGreaterThanOrEqual(1);
    dealer.retryPendingPrizes();
    await dealer.flushPayouts();
    expect(mints).toHaveLength(1); // still one - the cooldown holds

    // Once the float has landed, the sweep pays what was owed.
    spendable = true;
    dealer.retryPendingPrizes();
    await dealer.flushPayouts();
    expect((await dealer.houseStats()).pendingPrizes).toHaveLength(0);
    expect((await dealer.houseStats()).paidOutUct).toBeGreaterThan(0);
  });

  describe('reconciling prizes whose spend was kept open', () => {
    // A kept-open spend may already be on-chain, so the prize is never
    // re-sent blindly. Once its intent converges the prize is either paid or
    // it is not, and the ledger cannot tell which - but the wallet's own
    // history can.
    const keptOpenAgent = (history: unknown[], openTransfers: number) => {
      const sent: number[] = [];
      const agent = {
        nametag: 'house-test',
        uctCoin: { coinId: 'aabb', decimals: 2 },
        toHuman: (s: bigint | string) => (Number(BigInt(s)) / 100).toString(),
        toSmallest: (h: string | number) => String(Math.round(Number(h) * 100)),
        balanceUct: async () => 1000,
        mintUct: async () => undefined,
        resumeOpenTransfers: async () => undefined,
        pendingTransfers: async () => Array.from({ length: openTransfers }, (_, i) => ({ id: i })),
        getHistory: async () => history,
        send: async (_a: string, amount: number) => {
          sent.push(amount);
          throw Object.assign(new Error('Split burn failed: certification unconfirmed'), {
            code: 'CERTIFICATION_UNCONFIRMED',
          });
        },
      } as unknown as SphereAgent;
      return { agent, sent };
    };

    /** Drive one jackpot to a kept-open failure so a prize is owed and quarantined. */
    const owedPrize = async (agent: SphereAgent) => {
      const dealer = new GameDealer({ agent, cooldownMs: 0, jackpotSeedUct: 20, jackpotOdds: 1 });
      const nr = dealer.newRound('coin', '@0abc');
      await dealer.play({ roundId: nr.roundId, choice: 'heads', playerAddress: '@0abc', name: '0abc' });
      await dealer.flushPayouts();
      const owed = (await dealer.houseStats()).pendingPrizes;
      expect(owed).toHaveLength(1);
      return { dealer, amount: owed[0]!.amountUct };
    };

    it('retires a prize the wallet actually sent', async () => {
      const { agent } = keptOpenAgent([], 0);
      const { dealer, amount } = await owedPrize(agent);
      // The wallet reports the payment it made while the intent was open.
      (agent as unknown as { getHistory: () => Promise<unknown[]> }).getHistory = async () => [
        {
          id: 'h1',
          type: 'SENT',
          amount: String(amount * 100),
          memo: 'arcade-jackpot',
          timestamp: Date.now(),
          recipientNametag: '0abc',
        },
      ];
      await dealer.resumeOpenTransfers();
      const res = await dealer.reconcileOpenPrizes();

      expect(res).toEqual({ settled: 1, released: 0 });
      expect((await dealer.houseStats()).pendingPrizes).toHaveLength(0);
      expect((await dealer.houseStats()).paidOutUct).toBe(amount);
    });

    it('re-queues a prize that was never sent, once nothing is in flight', async () => {
      const { agent } = keptOpenAgent([], 0);
      const { dealer } = await owedPrize(agent);
      await dealer.resumeOpenTransfers();
      const res = await dealer.reconcileOpenPrizes();

      expect(res).toEqual({ settled: 0, released: 1 });
      // Still owed, but no longer quarantined - the sweep may try it again.
      expect((await dealer.houseStats()).pendingPrizes).toHaveLength(1);
      expect((await dealer.houseStats()).paidOutUct).toBe(0);
    });

    it('leaves everything alone while an intent is still open', async () => {
      const { agent } = keptOpenAgent([], 1); // one intent unaccounted for
      const { dealer } = await owedPrize(agent);
      await dealer.resumeOpenTransfers();
      const res = await dealer.reconcileOpenPrizes();

      expect(res).toEqual({ settled: 0, released: 0 });
      expect((await dealer.houseStats()).pendingPrizes).toHaveLength(1);
    });

    it('will not settle two identical prizes from one payment', async () => {
      const { agent } = keptOpenAgent([], 0);
      const { dealer, amount } = await owedPrize(agent);
      // A second, identical prize to the same winner.
      const nr = dealer.newRound('coin', '@0abc');
      await dealer.play({ roundId: nr.roundId, choice: 'heads', playerAddress: '@0abc', name: '0abc' });
      await dealer.flushPayouts();
      expect((await dealer.houseStats()).pendingPrizes.length).toBeGreaterThanOrEqual(2);

      (agent as unknown as { getHistory: () => Promise<unknown[]> }).getHistory = async () => [
        {
          id: 'h1',
          type: 'SENT',
          amount: String(amount * 100),
          memo: 'arcade-jackpot',
          timestamp: Date.now(),
          recipientNametag: '0abc',
        },
      ];
      await dealer.resumeOpenTransfers();
      const res = await dealer.reconcileOpenPrizes();
      expect(res.settled).toBe(1); // one payment, one prize
    });

    it('ignores a payment that predates the prize', async () => {
      const { agent } = keptOpenAgent([], 0);
      const { dealer, amount } = await owedPrize(agent);
      (agent as unknown as { getHistory: () => Promise<unknown[]> }).getHistory = async () => [
        {
          id: 'old',
          type: 'SENT',
          amount: String(amount * 100),
          memo: 'arcade-jackpot',
          timestamp: Date.now() - 60 * 60_000, // an hour before this prize existed
          recipientNametag: '0abc',
        },
      ];
      await dealer.resumeOpenTransfers();
      const res = await dealer.reconcileOpenPrizes();
      expect(res.settled).toBe(0);
    });
  });

  it('never re-sends a prize whose spend was kept open (money-safety)', async () => {
    // A spend that could not be certified stays open and may already be
    // on-chain, so the SDK keeps holding its source token. Re-sending picks a
    // second token and pays twice - and each attempt that ends open pins one
    // more, which is how the wallet ratchets down to nothing spendable. Such a
    // prize recovers by converging, never by another send.
    let sends = 0;
    const agent = {
      nametag: 'house-test',
      uctCoin: { coinId: 'aabb', decimals: 2 },
      toHuman: (smallest: bigint | string) => (Number(BigInt(smallest)) / 100).toString(),
      balanceUct: async () => 1000,
      mintUct: async () => undefined,
      resumeOpenTransfers: async () => undefined,
      send: async () => {
        sends += 1;
        throw Object.assign(
          new Error('Split burn failed: certification unconfirmed — keep the intent open'),
          { code: 'CERTIFICATION_UNCONFIRMED', mayHaveCertified: true },
        );
      },
    } as unknown as SphereAgent;
    const dealer = new GameDealer({ agent, cooldownMs: 0, jackpotSeedUct: 20, jackpotOdds: 1 });

    const nr = dealer.newRound('coin', '@kept');
    await dealer.play({ roundId: nr.roundId, choice: 'heads', playerAddress: '@kept', name: 'kept' });
    await dealer.flushPayouts();
    expect(sends).toBe(1);

    // The prize stays owed and visibly awaiting convergence - but no sweep,
    // boot or otherwise, ever issues a second send for it.
    const owed = (await dealer.houseStats()).pendingPrizes;
    expect(owed.length).toBe(1);
    dealer.retryPendingPrizes();
    dealer.retryPendingPrizes({ respectBackoff: true });
    await dealer.flushPayouts();
    expect(sends).toBe(1);

    // And it survives a restart still protected.
    const rebooted = new GameDealer({ agent, cooldownMs: 0, jackpotSeedUct: 20, jackpotOdds: 1 });
    rebooted.restore(dealer.snapshot());
    rebooted.retryPendingPrizes();
    await rebooted.flushPayouts();
    expect(sends).toBe(1);
  });

  it.each([
    'SEND_SYNC_PENDING',
    'CHECKPOINT_PERSIST_FAILED',
    'SPLIT_CHECKPOINT_LOST',
    'CHECKPOINT_TRUSTBASE_MISMATCH',
    'SEND_PARTIALLY_COMPLETED',
  ])('never re-sends a prize whose send failed with %s (possibly committed)', async (code) => {
    // The SDK names six outcomes that must never be re-sent; only one of them
    // says "certification unconfirmed", so the code decides, not the wording.
    let sends = 0;
    const agent = {
      nametag: 'house-test',
      uctCoin: { coinId: 'aabb', decimals: 2 },
      toHuman: (smallest: bigint | string) => (Number(BigInt(smallest)) / 100).toString(),
      balanceUct: async () => 1000,
      mintUct: async () => undefined,
      send: async () => {
        sends += 1;
        throw Object.assign(new Error('send outcome unknown'), { code });
      },
    } as unknown as SphereAgent;
    const dealer = new GameDealer({ agent, cooldownMs: 0, jackpotSeedUct: 20, jackpotOdds: 1 });

    const nr = dealer.newRound('coin', '@kept');
    await dealer.play({ roundId: nr.roundId, choice: 'heads', playerAddress: '@kept', name: 'kept' });
    await dealer.flushPayouts();
    dealer.retryPendingPrizes();
    await dealer.flushPayouts();

    expect(sends).toBe(1);
    expect((await dealer.houseStats()).pendingPrizes).toHaveLength(1);
  });

  it('does not let one payout that never settles block every later one', async () => {
    // Payouts run in sequence so they never contend for the same tokens, which
    // means a single call that never resolves takes the whole house down with
    // it: in production one hung send stopped every payout for an hour, with no
    // error and no further attempts, until a restart. It must time out instead.
    let hang = true;
    const landed: number[] = [];
    const agent = {
      nametag: 'house-test',
      uctCoin: { coinId: 'aabb', decimals: 2 },
      toHuman: (smallest: bigint | string) => (Number(BigInt(smallest)) / 100).toString(),
      balanceUct: async () => 1000,
      mintUct: async () => undefined,
      send: async (_address: string, amount: number) => {
        if (hang) await new Promise(() => {}); // never settles
        landed.push(amount);
        return { id: `tx-${amount}`, deliveryState: 'landed' };
      },
    } as unknown as SphereAgent;
    // A deadline far below the real one keeps the test fast.
    const dealer = new GameDealer({
      agent,
      cooldownMs: 0,
      jackpotSeedUct: 20,
      jackpotOdds: 1,
      payoutTimeoutMs: 40,
    });

    const first = dealer.newRound('coin', '@a');
    await dealer.play({ roundId: first.roundId, choice: 'heads', playerAddress: '@a', name: 'a' });

    // The hung payout releases the lock once its deadline passes.
    await new Promise((r) => setTimeout(r, 120));
    hang = false;
    const second = dealer.newRound('coin', '@b');
    await dealer.play({ roundId: second.roundId, choice: 'heads', playerAddress: '@b', name: 'b' });
    await dealer.flushPayouts();

    expect(landed.length).toBeGreaterThan(0);
  });

  it('never re-sends a payout abandoned at its deadline (it may still land)', async () => {
    let sends = 0;
    const agent = {
      nametag: 'house-test',
      uctCoin: { coinId: 'aabb', decimals: 2 },
      toHuman: (smallest: bigint | string) => (Number(BigInt(smallest)) / 100).toString(),
      balanceUct: async () => 1000,
      mintUct: async () => undefined,
      send: async () => {
        sends += 1;
        await new Promise(() => {}); // still in flight when abandoned
      },
    } as unknown as SphereAgent;
    const dealer = new GameDealer({ agent, cooldownMs: 0, jackpotSeedUct: 20, jackpotOdds: 1, payoutTimeoutMs: 40 });

    const nr = dealer.newRound('coin', '@slow');
    await dealer.play({ roundId: nr.roundId, choice: 'heads', playerAddress: '@slow', name: 'slow' });
    await new Promise((r) => setTimeout(r, 120));
    dealer.retryPendingPrizes();
    await new Promise((r) => setTimeout(r, 120));

    expect(sends).toBe(1);
    expect((await dealer.houseStats()).pendingPrizes).toHaveLength(1);
  });

  it('settles a prize in-house when the winner has no on-chain identity', async () => {
    // The house's own bot personas are labels with no wallet behind them, so an
    // on-chain prize addressed to one can never land however often it is tried.
    // Left pending it would clog the ledger forever - which is exactly what a
    // real backlog did. It becomes house credit instead: real for the winner.
    let attempts = 0;
    const agent = {
      nametag: 'house-test',
      uctCoin: { coinId: 'aabb', decimals: 2 },
      toHuman: (smallest: bigint | string) => (Number(BigInt(smallest)) / 100).toString(),
      balanceUct: async () => 1000,
      mintUct: async () => undefined,
      send: async (address: string) => {
        attempts += 1;
        throw new Error(`Recipient ${address} has no published chain pubkey`);
      },
    } as unknown as SphereAgent;
    const dealer = new GameDealer({ agent, cooldownMs: 0, jackpotSeedUct: 20, jackpotOdds: 1 });

    const before = dealer.balanceOf('@astrid-steady').balanceUct;
    const nr = dealer.newRound('coin', '@astrid-steady');
    const res = await dealer.play({
      roundId: nr.roundId,
      choice: 'heads',
      playerAddress: '@astrid-steady',
      name: 'astrid-steady',
    });
    expect(res.jackpot.hit).toBe(true);
    await dealer.flushPayouts();

    // Retired from the ledger, credited in-house, and never retried again.
    expect((await dealer.houseStats()).pendingPrizes).toHaveLength(0);
    expect(dealer.balanceOf('@astrid-steady').balanceUct).toBeGreaterThan(before);
    const settled = attempts;
    dealer.retryPendingPrizes();
    await dealer.flushPayouts();
    expect(attempts).toBe(settled);
  });

  it('holds an owed prize back until its backoff elapses, but never on a boot sweep', async () => {
    let live = false;
    const attempts: number[] = [];
    const flaky = {
      nametag: 'house-test',
      uctCoin: { coinId: 'aabb', decimals: 2 },
      toHuman: (smallest: bigint | string) => (Number(BigInt(smallest)) / 100).toString(),
      balanceUct: async () => 1000,
      mintUct: async () => undefined,
      send: async (_address: string, amount: number) => {
        attempts.push(amount);
        if (!live) throw new Error('testnet down');
        return { id: `tx-${attempts.length}`, deliveryState: 'landed' };
      },
    } as unknown as SphereAgent;
    // A jackpot that cannot be sent becomes an owed prize in the durable ledger.
    const dealer = new GameDealer({ agent: flaky, cooldownMs: 0, jackpotSeedUct: 20, jackpotOdds: 1 });
    const nr = dealer.newRound('coin', '@bo');
    await dealer.play({ roundId: nr.roundId, choice: 'heads', playerAddress: '@bo', name: 'bo' });
    await dealer.flushPayouts();
    expect((await dealer.houseStats()).pendingPrizes.length).toBeGreaterThanOrEqual(1);

    const owedBefore = attempts.length;
    // A timed sweep right after a failure waits: the prize just tried.
    dealer.retryPendingPrizes({ respectBackoff: true });
    await dealer.flushPayouts();
    expect(attempts.length).toBe(owedBefore);

    // A boot sweep ignores the backoff - a restart is new information.
    live = true;
    dealer.retryPendingPrizes();
    await dealer.flushPayouts();
    expect(attempts.length).toBeGreaterThan(owedBefore);
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

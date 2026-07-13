import { describe, expect, it } from 'vitest';
import { deriveDeck } from './rng.js';
import { bjJudge, bjStart, bjStep, bjView, handValue, isBlackjack } from './games/blackjack.js';
import { GameDealer } from './game-dealer.js';
import type { SphereAgent } from '../sphere-agent.js';

describe('deriveDeck', () => {
  it('derives a deterministic full permutation of 52 cards', () => {
    const d = deriveDeck('shoe-secret');
    expect(deriveDeck('shoe-secret')).toEqual(d);
    expect(d).toHaveLength(52);
    expect(new Set(d).size).toBe(52);
    expect(d.every((c) => c >= 0 && c < 52)).toBe(true);
    expect(deriveDeck('other-secret')).not.toEqual(d);
  });
});

describe('blackjack hand logic', () => {
  it('values hands with soft aces correctly', () => {
    expect(handValue([0, 9])).toEqual({ total: 21, soft: true }); // A + 10
    expect(handValue([0, 0])).toEqual({ total: 12, soft: true }); // A + A = 11+1
    expect(handValue([0, 5, 9])).toEqual({ total: 17, soft: false }); // A+6+10 = 1+6+10
    expect(handValue([12, 11, 10])).toEqual({ total: 30, soft: false }); // K Q J
    expect(isBlackjack([0, 12])).toBe(true); // A + K
    expect(isBlackjack([5, 6, 9])).toBe(false);
  });

  it('replays a whole hand deterministically from the secret', () => {
    // Find a secret whose opening hand is playable (no naturals) so we can hit.
    let secret = '';
    for (let i = 0; i < 200; i++) {
      const s = `probe-${i}`;
      const h = bjStart(s);
      if (!h.done && handValue(h.player).total <= 11) {
        secret = s;
        break;
      }
    }
    expect(secret).not.toBe('');
    const h1 = bjStart(secret);
    const deck = deriveDeck(secret);
    // Opening cards come off the shoe in order: P, D, P, D.
    expect(h1.player).toEqual([deck[0], deck[2]]);
    expect(h1.dealer).toEqual([deck[1], deck[3]]);
    // A hit takes the NEXT card — fully predictable from the reveal.
    const h2 = bjStep(secret, h1, 'hit');
    expect(h2.player[2]).toBe(deck[4]);
    // Standing plays the dealer to 17+ and finishes the hand.
    const h3 = bjStep(secret, h2.done ? h1 : h2, 'stand');
    expect(h3.done).toBe(true);
    expect(handValue(h3.dealer).total).toBeGreaterThanOrEqual(17);
    const judged = bjJudge(h3);
    expect(['win', 'lose', 'tie']).toContain(judged.outcome);
  });

  it('double takes exactly one card then stands', () => {
    let secret = '';
    for (let i = 0; i < 300; i++) {
      const h = bjStart(`dbl-${i}`);
      const t = handValue(h.player).total;
      if (!h.done && t >= 9 && t <= 11) {
        secret = `dbl-${i}`;
        break;
      }
    }
    expect(secret).not.toBe('');
    const h = bjStep(secret, bjStart(secret), 'double');
    expect(h.done).toBe(true);
    expect(h.player).toHaveLength(3);
    expect(h.doubled).toBe(true);
    // Double after more cards is rejected.
    expect(() => bjStep(secret, { ...bjStart(secret), player: [0, 1, 2] }, 'double')).toThrow(/first two/i);
  });

  it('hides the dealer hole card until the hand is done', () => {
    let secret = '';
    for (let i = 0; i < 200; i++) {
      if (!bjStart(`view-${i}`).done) {
        secret = `view-${i}`;
        break;
      }
    }
    const open = bjView(bjStart(secret));
    expect(open.dealer).toBeUndefined();
    expect(open.dealerTotal).toBeUndefined();
    expect(typeof open.dealerUp).toBe('number');
    const done = bjView(bjStep(secret, bjStart(secret), 'stand'));
    expect(done.dealer).toBeDefined();
    expect(done.dealerTotal).toBeGreaterThanOrEqual(17);
  });

  it('pays 3:2 on a natural (total-return 2.5)', () => {
    // Find a secret dealing the player a natural and not the dealer.
    let secret = '';
    for (let i = 0; i < 3000; i++) {
      const h = bjStart(`bj-${i}`);
      if (h.done && isBlackjack(h.player) && !isBlackjack(h.dealer)) {
        secret = `bj-${i}`;
        break;
      }
    }
    expect(secret).not.toBe('');
    const judged = bjJudge(bjStart(secret));
    expect(judged.outcome).toBe('win');
    expect(judged.rewardMult).toBe(2.5);
  });
});

describe('blackjack at the dealer (staked multi-step table)', () => {
  const stubAgent = () =>
    ({
      nametag: 'house-test',
      uctCoin: { coinId: 'aabb', decimals: 2 },
      toHuman: (smallest: bigint | string) => (Number(BigInt(smallest)) / 100).toString(),
      balanceUct: async () => 1000,
      mintUct: async () => undefined,
      send: async () => ({ id: 'tx', deliveryState: 'landed' }),
    }) as unknown as SphereAgent;

  it('stakes at the deal, settles through the standard pipeline on stand', async () => {
    const dealer = new GameDealer({ agent: stubAgent(), cooldownMs: 0, jackpotOdds: 1_000_000_000 });
    dealer.creditDeposit({ id: 'bj-seed', amountBase: '10000', senderPubkey: '@bj1' });
    dealer.newRound('coin', '@bj1'); // settle the one-time welcome grant first
    const start = dealer.balanceOf('@bj1').balanceUct;
    let view = dealer.newTable('blackjack', '@bj1', 10, 'bj1');
    if (!view.result) {
      // Stake is out of the balance while the hand is open.
      expect(view.you!.chips).toBe(start - 10);
      view = dealer.stepTable(view.roundId, 'stand', '@bj1');
    }
    expect(view.result).toBeDefined();
    const r = view.result!;
    expect(r.game).toBe('blackjack');
    expect(['win', 'lose', 'tie']).toContain(r.outcome);
    // The standard pipeline ran: XP granted, reveal carries the full hand.
    expect(r.xpGained).toBeGreaterThan(0);
    expect(Array.isArray(r.reveal.dealer)).toBe(true);
    // Chips reconcile: win => +reward-bet, tie => flat, lose => -bet — plus
    // any one-time extras the pipeline credits outside rewardUct.
    const extras = (r.achievementBonus ?? 0) + (r.levelUp?.bonus ?? 0) + (r.rakeCredited ?? 0);
    const end = dealer.balanceOf('@bj1').balanceUct;
    if (r.outcome === 'win') expect(end).toBe(start - 10 + r.rewardUct + extras);
    else if (r.outcome === 'tie') expect(end).toBe(start + extras);
    else expect(end).toBe(start - 10 + extras);
  });

  it('double stakes a second bet and pays on the doubled amount', () => {
    // Deterministic double: find a secret via many tables would be flaky —
    // instead assert the STAKE mechanics: doubling deducts a second bet.
    const dealer = new GameDealer({ agent: stubAgent(), cooldownMs: 0, jackpotOdds: 1_000_000_000 });
    dealer.creditDeposit({ id: 'bj-seed2', amountBase: '10000', senderPubkey: '@bj2' });
    for (let i = 0; i < 50; i++) {
      const v = dealer.newTable('blackjack', '@bj2', 5, 'bj2');
      if (v.result) continue; // natural — try another hand
      const before = dealer.balanceOf('@bj2').balanceUct;
      const stepped = dealer.stepTable(v.roundId, 'double', '@bj2');
      expect(stepped.bet).toBe(10);
      const after = dealer.balanceOf('@bj2').balanceUct;
      // The second stake left the balance before settle re-credited it —
      // net effect at settle: outcome applied on bet 10.
      expect(stepped.result).toBeDefined();
      expect(stepped.result!.bet).toBe(10);
      if (stepped.result!.outcome === 'lose') {
        expect(after).toBe(before - 5 + (stepped.result!.rakeCredited ?? 0)); // second 5 gone
      }
      return;
    }
    throw new Error('never dealt a playable hand in 50 tries');
  });

  it('rejects a foreign step and an unknown action', () => {
    const dealer = new GameDealer({ agent: stubAgent(), cooldownMs: 0, jackpotOdds: 1_000_000_000 });
    dealer.creditDeposit({ id: 'bj-seed3', amountBase: '10000', senderPubkey: '@bj3' });
    for (let i = 0; i < 50; i++) {
      const v = dealer.newTable('blackjack', '@bj3', 1, 'bj3');
      if (v.result) continue;
      expect(() => dealer.stepTable(v.roundId, 'hit', '@intruder')).toThrow(/not your hand/i);
      expect(() => dealer.stepTable(v.roundId, 'split', '@bj3')).toThrow(/hit, stand or double/i);
      return;
    }
    throw new Error('never dealt a playable hand in 50 tries');
  });

  it('an abandoned hand refunds its stake on TTL sweep', () => {
    const dealer = new GameDealer({
      agent: stubAgent(),
      cooldownMs: 0,
      roundTtlMs: 1, // expire immediately
      jackpotOdds: 1_000_000_000,
    });
    dealer.creditDeposit({ id: 'bj-seed4', amountBase: '10000', senderPubkey: '@bj4' });
    dealer.newRound('coin', '@bj4'); // settle the one-time welcome grant first
    const before = dealer.balanceOf('@bj4').balanceUct;
    const v = dealer.newTable('blackjack', '@bj4', 7, 'bj4');
    if (v.result) return; // a natural settled instantly — nothing to abandon
    expect(dealer.balanceOf('@bj4').balanceUct).toBe(before - 7);
    const t0 = Date.now();
    while (Date.now() - t0 < 3) {
      /* let the 1ms TTL elapse */
    }
    // Another player's deal triggers the sweep — @bj4 stakes nothing new.
    dealer.newRound('coin', '@bystander');
    expect(dealer.balanceOf('@bj4').balanceUct).toBe(before); // stake came home
  });

  it('survives a snapshot/restore with the stake intact', () => {
    const dealer = new GameDealer({ agent: stubAgent(), cooldownMs: 0, jackpotOdds: 1_000_000_000 });
    dealer.creditDeposit({ id: 'bj-seed5', amountBase: '10000', senderPubkey: '@bj5' });
    for (let i = 0; i < 50; i++) {
      const v = dealer.newTable('blackjack', '@bj5', 4, 'bj5');
      if (v.result) continue;
      const rebooted = new GameDealer({ agent: stubAgent(), cooldownMs: 0, jackpotOdds: 1_000_000_000 });
      rebooted.restore(dealer.snapshot());
      const done = rebooted.stepTable(v.roundId, 'stand', '@bj5');
      expect(done.result).toBeDefined();
      return;
    }
    throw new Error('never dealt a playable hand in 50 tries');
  });
});

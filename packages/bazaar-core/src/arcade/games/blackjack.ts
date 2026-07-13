import { deriveDeck } from '../rng.js';
import type { Judged } from './types.js';

/**
 * Blackjack vs the house — the arcade's first MULTI-STEP table game, on the
 * same commit-reveal guarantee as everything else: the whole deck order
 * derives from the committed secret (deriveDeck), so it was fixed before the
 * first card showed, and the reveal lets anyone replay the entire hand.
 *
 * Rules (kept classic and simple): dealer stands on all 17s · blackjack pays
 * 3:2 · double on the first two cards (one card, then auto-stand) · no
 * splits / insurance (deliberately — one hand, one verdict).
 *
 * Pure module: the dealer (game-dealer.ts) owns bets/chips; this owns cards.
 */

export type BjAction = 'hit' | 'stand' | 'double';

export interface BjHand {
  /** Cards drawn from the shoe in order (0..51). */
  player: number[];
  dealer: number[];
  /** How many cards have been consumed from the deck. */
  drawn: number;
  /** Player doubled (bet ×2, one card, auto-stood). */
  doubled: boolean;
  /** The hand is over (bust, blackjack, or dealer played out). */
  done: boolean;
}

export const rankOf = (card: number): number => card % 13; // 0=A … 12=K
export const suitOf = (card: number): number => Math.floor(card / 13);

/** Card value before ace adjustment: A=11, 2..9 face, 10/J/Q/K = 10. */
function baseValue(card: number): number {
  const r = rankOf(card);
  if (r === 0) return 11;
  return Math.min(10, r + 1);
}

/** Best hand total (aces drop 11→1 while busting) + softness. */
export function handValue(cards: number[]): { total: number; soft: boolean } {
  let total = cards.reduce((a, c) => a + baseValue(c), 0);
  let aces = cards.filter((c) => rankOf(c) === 0).length;
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return { total, soft: aces > 0 };
}

export const isBlackjack = (cards: number[]): boolean =>
  cards.length === 2 && handValue(cards).total === 21;

/** Open a hand: player two cards, dealer two (hole card hidden in views). */
export function bjStart(secret: string): BjHand {
  const deck = deriveDeck(secret);
  const hand: BjHand = {
    player: [deck[0]!, deck[2]!],
    dealer: [deck[1]!, deck[3]!],
    drawn: 4,
    doubled: false,
    done: false,
  };
  // A natural on either side ends the hand immediately (dealer peeks).
  if (isBlackjack(hand.player) || isBlackjack(hand.dealer)) hand.done = true;
  return hand;
}

/** Dealer draws to 17+ (stands on all 17s), then the hand is over. */
function dealerPlay(secret: string, hand: BjHand): BjHand {
  const deck = deriveDeck(secret);
  const dealer = [...hand.dealer];
  let drawn = hand.drawn;
  while (handValue(dealer).total < 17) {
    dealer.push(deck[drawn]!);
    drawn += 1;
  }
  return { ...hand, dealer, drawn, done: true };
}

/** Apply one player action. Throws on an action that makes no sense now. */
export function bjStep(secret: string, hand: BjHand, action: BjAction): BjHand {
  if (hand.done) throw new Error('The hand is already over.');
  const deck = deriveDeck(secret);
  if (action === 'hit') {
    const player = [...hand.player, deck[hand.drawn]!];
    const next: BjHand = { ...hand, player, drawn: hand.drawn + 1 };
    if (handValue(player).total >= 21) {
      // 21 auto-stands; a bust ends it without a dealer turn.
      return handValue(player).total > 21 ? { ...next, done: true } : dealerPlay(secret, next);
    }
    return next;
  }
  if (action === 'double') {
    if (hand.player.length !== 2) throw new Error('Double is only allowed on your first two cards.');
    const player = [...hand.player, deck[hand.drawn]!];
    const next: BjHand = { ...hand, player, drawn: hand.drawn + 1, doubled: true };
    return handValue(player).total > 21 ? { ...next, done: true } : dealerPlay(secret, next);
  }
  // stand
  return dealerPlay(secret, hand);
}

/**
 * Judge a finished hand. Total-return multipliers on the FINAL bet
 * (double already reflected by the dealer's stake): blackjack 2.5, win 2,
 * push 1 (tie), loss 0.
 */
export function bjJudge(hand: BjHand): Judged {
  if (!hand.done) throw new Error('The hand is not over yet.');
  const p = handValue(hand.player);
  const d = handValue(hand.dealer);
  const pBj = isBlackjack(hand.player);
  const dBj = isBlackjack(hand.dealer);
  let outcome: Judged['outcome'];
  let rewardMult = 2;
  if (p.total > 21) outcome = 'lose';
  else if (pBj && !dBj) {
    outcome = 'win';
    rewardMult = 2.5; // 3:2 on the natural
  } else if (dBj && !pBj) outcome = 'lose';
  else if (pBj && dBj) outcome = 'tie';
  else if (d.total > 21) outcome = 'win';
  else if (p.total > d.total) outcome = 'win';
  else if (p.total < d.total) outcome = 'lose';
  else outcome = 'tie';
  return {
    outcome,
    rewardMult,
    reveal: {
      player: hand.player,
      dealer: hand.dealer,
      playerTotal: p.total,
      dealerTotal: d.total,
      doubled: hand.doubled,
      playerBlackjack: pBj,
      dealerBlackjack: dBj,
    },
  };
}

/** What the player may see mid-hand: the dealer's hole card stays hidden. */
export function bjView(hand: BjHand): {
  player: number[];
  playerTotal: number;
  playerSoft: boolean;
  dealerUp: number;
  dealer?: number[];
  dealerTotal?: number;
  doubled: boolean;
  done: boolean;
  canDouble: boolean;
} {
  const p = handValue(hand.player);
  return {
    player: hand.player,
    playerTotal: p.total,
    playerSoft: p.soft,
    dealerUp: hand.dealer[0]!,
    ...(hand.done ? { dealer: hand.dealer, dealerTotal: handValue(hand.dealer).total } : {}),
    doubled: hand.doubled,
    done: hand.done,
    canDouble: !hand.done && hand.player.length === 2 && !hand.doubled,
  };
}

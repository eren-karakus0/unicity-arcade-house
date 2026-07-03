/**
 * Client for the Agent Arcade — a hall of provably-fair games. The house
 * commits sha256(secret:nonce) before you act; after the reveal the browser
 * re-hashes it (verifyCommit) to prove the secret was fixed in advance. Dice
 * additionally re-derives both rolls from the two seeds (verifyDice).
 */
import { BACKEND_URL, hasBackend } from './backend';

export type Outcome = 'win' | 'lose' | 'tie';

export interface GameMeta {
  id: string;
  title: string;
  blurb: string;
  rewardMult: number;
  inputKind: 'choice' | 'seed';
}

export interface DailyView {
  goal: number;
  wins: number;
  claimed: boolean;
}
export interface PlayerSnapshot {
  streak: number;
  best: number;
  daily: DailyView;
  /** Chip balance (bets stake it; cash-out pays it 1:1 in UCT). */
  chips: number;
  /** Chips granted by today's top-up in this call. */
  chipsGranted: number;
}

export interface NewRound {
  game: string;
  roundId: string;
  commit: string;
  rewardUct: number;
  house: string;
  jackpotUct?: number;
  publicState?: Record<string, unknown>;
  you?: PlayerSnapshot;
}

export interface JackpotResult {
  roll: number;
  threshold: number;
  hit: boolean;
  potUct: number;
  input: string;
  paid?: boolean;
  txId?: string;
  delivery?: string;
  error?: string;
}

export interface AchievementView {
  id: string;
  title: string;
  detail: string;
  icon: 'spark' | 'flame' | 'crown' | 'coin' | 'dice' | 'target' | 'star' | 'trophy';
  reward: number;
  unlocked: boolean;
}

export interface PlayResult {
  game: string;
  roundId: string;
  outcome: Outcome;
  rewardUct: number;
  commit: string;
  secret: string;
  nonce: string;
  reveal: Record<string, unknown>;
  /** The chips staked on this round. */
  bet: number;
  /** The player's chip balance after the round. */
  chips: number;
  streak: number;
  best: number;
  streakBonus: number;
  dailyBonus: number;
  daily: DailyView;
  jackpot?: JackpotResult;
  /** Achievements newly unlocked by this round (for a one-time reveal). */
  achievements?: AchievementView[];
  /** UCT credited from those achievements' one-time rewards. */
  achievementBonus?: number;
}

export interface LeaderRow {
  name: string;
  wins: number;
  losses: number;
  ties: number;
  played: number;
  earnedUct: number;
}

export interface HouseEvent {
  kind: 'win' | 'mint' | 'jackpot' | 'cashout' | 'deposit';
  at: number;
  amountUct: number;
  name?: string;
  game?: string;
}

/** Where and what to send for a wallet deposit (builds the send-intent). */
export interface DepositInfo {
  to: string;
  coinId: string;
  decimals: number;
  symbol: string;
}

export interface HouseStats {
  treasuryUct: number | null;
  paidOutUct: number;
  roundsPlayed: number;
  selfMintedUct: number;
  jackpotUct?: number;
  feed: HouseEvent[];
}

export interface Leaderboard {
  ready: boolean;
  house: string | null;
  baseRewardUct: number;
  games: GameMeta[];
  rows: LeaderRow[];
  daily?: { goal: number; reward: number } | null;
  deposit?: DepositInfo;
  houseStats?: HouseStats;
}

export { hasBackend };

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${BACKEND_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const d = (await r.json()) as T & { error?: string };
  if (!r.ok || d.error) throw new Error(d.error ?? 'request failed');
  return d;
}

export function newRound(game: string, address?: string): Promise<NewRound> {
  return post<NewRound>('/api/arcade/new', { game, address });
}

export function playRound(input: {
  game: string;
  roundId: string;
  choice: unknown;
  bet: number;
  address?: string;
  name?: string;
}): Promise<PlayResult> {
  return post<PlayResult>('/api/arcade/play', {
    roundId: input.roundId,
    choice: input.choice,
    bet: input.bet,
    address: input.address,
    name: input.name,
  });
}

/** Withdraw the wallet's in-house balance 1:1 as UCT, settled on-chain by the house. */
export function cashOut(address: string, name?: string): Promise<{ settlementId: string; amountUct: number }> {
  return post<{ settlementId: string; amountUct: number }>('/api/arcade/cashout', { address, name });
}

/** The caller's in-house UCT balance (polled after a wallet deposit). */
export async function fetchBalance(address: string): Promise<{ balanceUct: number }> {
  const r = await fetch(`${BACKEND_URL}/api/arcade/balance?address=${encodeURIComponent(address)}`, {
    signal: AbortSignal.timeout(8_000),
  });
  return (await r.json()) as { balanceUct: number };
}

/** The achievement catalog annotated with what this player has unlocked. */
export async function fetchAchievements(address?: string): Promise<AchievementView[]> {
  const q = address ? `?address=${encodeURIComponent(address)}` : '';
  const r = await fetch(`${BACKEND_URL}/api/arcade/achievements${q}`, { signal: AbortSignal.timeout(8_000) });
  const d = (await r.json()) as { achievements?: AchievementView[] };
  return d.achievements ?? [];
}

export async function fetchLeaderboard(): Promise<Leaderboard> {
  const r = await fetch(`${BACKEND_URL}/api/arcade/leaderboard`, { signal: AbortSignal.timeout(8_000) });
  return (await r.json()) as Leaderboard;
}

/** Background on-chain payout state for a round (win + jackpot legs). */
export interface SettlementView {
  status: 'pending' | 'landed' | 'failed';
  amountUct: number;
  txId?: string;
  delivery?: string;
  error?: string;
}
export interface RoundSettlement {
  win?: SettlementView;
  jackpot?: SettlementView;
}

export async function fetchSettlement(roundId: string): Promise<RoundSettlement> {
  const r = await fetch(`${BACKEND_URL}/api/arcade/settlement?round=${encodeURIComponent(roundId)}`, {
    signal: AbortSignal.timeout(8_000),
  });
  return (await r.json()) as RoundSettlement;
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Re-hash the reveal to confirm the house never changed its committed secret. */
export async function verifyCommit(secret: string, nonce: string, commit: string): Promise<boolean> {
  return (await sha256Hex(`${secret}:${nonce}`)) === commit;
}

/** Recompute both dice from the two seeds — mirrors the server's deriveDicePair. */
export async function verifyDice(
  server: string,
  client: string,
  expected: { dealerRoll: number; playerRoll: number },
): Promise<boolean> {
  const h = await sha256Hex(`${server}:${client}`);
  const house = (parseInt(h.slice(0, 8), 16) % 6) + 1;
  const player = (parseInt(h.slice(8, 16), 16) % 6) + 1;
  return house === expected.dealerRoll && player === expected.playerRoll;
}

/** Recompute the Plinko path bits from the two seeds — mirrors the server's derivePlinkoPath. */
export async function verifyPlinko(
  server: string,
  client: string,
  expected: { path: number[]; bucketIndex: number },
): Promise<boolean> {
  const h = await sha256Hex(`${server}:${client}`);
  const path = Array.from({ length: expected.path.length }, (_, i) => parseInt(h[i]!, 16) & 1);
  return (
    path.every((bit, i) => bit === expected.path[i]) &&
    path.reduce((a, b) => a + b, 0) === expected.bucketIndex
  );
}

/** Recompute the jackpot roll — mirrors the server's deriveJackpotRoll. */
export async function verifyJackpot(
  secret: string,
  input: string,
  expected: { roll: number; threshold: number },
): Promise<boolean> {
  const h = await sha256Hex(`${secret}:jackpot:${input}`);
  return parseInt(h.slice(0, 6), 16) % expected.threshold === expected.roll;
}

/** Recompute the wheel landing from the two seeds — mirrors the server's deriveWheelIndex. */
export async function verifyWheel(
  server: string,
  client: string,
  expected: { segmentIndex: number; segmentCount: number },
): Promise<boolean> {
  const h = await sha256Hex(`${server}:${client}`);
  return parseInt(h.slice(0, 8), 16) % expected.segmentCount === expected.segmentIndex;
}

export function makeClientSeed(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

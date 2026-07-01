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
}

export interface NewRound {
  game: string;
  roundId: string;
  commit: string;
  rewardUct: number;
  house: string;
  publicState?: Record<string, unknown>;
  you?: PlayerSnapshot;
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
  paid: boolean;
  payoutError?: string;
  txId?: string;
  txRef?: string;
  delivery?: string;
  streak: number;
  best: number;
  streakBonus: number;
  dailyBonus: number;
  daily: DailyView;
}

export interface LeaderRow {
  name: string;
  wins: number;
  losses: number;
  ties: number;
  played: number;
  earnedUct: number;
}

export interface Leaderboard {
  ready: boolean;
  house: string | null;
  baseRewardUct: number;
  games: GameMeta[];
  rows: LeaderRow[];
  daily?: { goal: number; reward: number } | null;
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
  address?: string;
  name?: string;
}): Promise<PlayResult> {
  return post<PlayResult>('/api/arcade/play', {
    roundId: input.roundId,
    choice: input.choice,
    address: input.address,
    name: input.name,
  });
}

export async function fetchLeaderboard(): Promise<Leaderboard> {
  const r = await fetch(`${BACKEND_URL}/api/arcade/leaderboard`, { signal: AbortSignal.timeout(8_000) });
  return (await r.json()) as Leaderboard;
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

export function makeClientSeed(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

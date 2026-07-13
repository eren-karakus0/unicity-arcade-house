/**
 * The fairness page's verification engine. Unlike the boolean verify* helpers
 * in lib/arcade.ts (used for the quick in-game check), these produce a
 * step-by-step report — every hash, hex slice and modulo shown — so a player
 * can watch the math prove the round, not just read a green tick.
 *
 * Also owns the proof archive: the arcade drops each round's reveal in
 * localStorage so this page can re-verify real rounds played in this browser.
 */
import type { PlayResult } from './arcade';

export interface StoredProof {
  at: number;
  game: string;
  roundId: string;
  outcome: string;
  bet: number;
  commit: string;
  secret: string;
  nonce: string;
  reveal: Record<string, unknown>;
  jackpot?: { roll: number; threshold: number; hit: boolean; input: string };
}

const PROOFS_KEY = 'arcade:proofs';
const PROOFS_MAX = 12;

/** Archive a played round's reveal for the fairness page (newest first). */
export function saveProof(res: PlayResult): void {
  try {
    const proof: StoredProof = {
      at: Date.now(),
      game: res.game,
      roundId: res.roundId,
      outcome: res.outcome,
      bet: res.bet,
      commit: res.commit,
      secret: res.secret,
      nonce: res.nonce,
      reveal: res.reveal,
      ...(res.jackpot
        ? {
            jackpot: {
              roll: res.jackpot.roll,
              threshold: res.jackpot.threshold,
              hit: res.jackpot.hit,
              input: res.jackpot.input,
            },
          }
        : {}),
    };
    const list = loadProofs();
    list.unshift(proof);
    localStorage.setItem(PROOFS_KEY, JSON.stringify(list.slice(0, PROOFS_MAX)));
  } catch {
    // storage full/blocked — the round still verified in-game, just not archived
  }
}

export function loadProofs(): StoredProof[] {
  try {
    const raw = localStorage.getItem(PROOFS_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as unknown;
    return Array.isArray(list) ? (list.filter(isProofLike) as StoredProof[]) : [];
  } catch {
    return [];
  }
}

function isProofLike(p: unknown): boolean {
  if (typeof p !== 'object' || p === null) return false;
  const o = p as Record<string, unknown>;
  return (
    typeof o.game === 'string' &&
    typeof o.commit === 'string' &&
    typeof o.secret === 'string' &&
    typeof o.nonce === 'string' &&
    typeof o.reveal === 'object' &&
    o.reveal !== null
  );
}

/** Accept a pasted PlayResult (or StoredProof) JSON and normalize it. */
export function parseProof(json: string): StoredProof {
  const raw = JSON.parse(json) as Record<string, unknown>;
  if (!isProofLike(raw)) {
    throw new Error('That JSON is missing round fields (game, commit, secret, nonce, reveal).');
  }
  const j = raw.jackpot as Record<string, unknown> | undefined;
  return {
    at: typeof raw.at === 'number' ? raw.at : Date.now(),
    game: String(raw.game),
    roundId: String(raw.roundId ?? ''),
    outcome: String(raw.outcome ?? '—'),
    bet: Number(raw.bet ?? 0),
    commit: String(raw.commit),
    secret: String(raw.secret),
    nonce: String(raw.nonce),
    reveal: raw.reveal as Record<string, unknown>,
    ...(j && typeof j.roll === 'number' && typeof j.threshold === 'number'
      ? {
          jackpot: {
            roll: Number(j.roll),
            threshold: Number(j.threshold),
            hit: Boolean(j.hit),
            input: String(j.input ?? ''),
          },
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export interface VerifyStep {
  /** Short name for the check, e.g. "the commitment". */
  title: string;
  /** The exact formula being recomputed, shown in mono. */
  formula: string;
  /** What this browser computed. */
  computed: string;
  /** What the house claimed. */
  expected: string;
  /** Working shown — hex slices, modulo math. */
  detail?: string;
  ok: boolean;
}

export interface VerifyReport {
  steps: VerifyStep[];
  ok: boolean;
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export { sha256Hex };

const hexInt = (h: string, from: number, to: number) => parseInt(h.slice(from, to), 16);

/** Re-derive everything the house claimed about a round, showing the work. */
export async function verifyProof(p: StoredProof): Promise<VerifyReport> {
  const steps: VerifyStep[] = [];

  // 1 — the commitment seals the secret before the player acted.
  const rehash = await sha256Hex(`${p.secret}:${p.nonce}`);
  steps.push({
    title: 'the commitment',
    formula: `sha256("${short(p.secret)}" + ":" + "${short(p.nonce)}")`,
    computed: rehash,
    expected: p.commit,
    detail: 'this hash was shown to you before you made your move — the secret was already fixed',
    ok: rehash === p.commit,
  });

  // 2 — the secret binds the outcome (per game).
  const r = p.reveal;
  if (p.game === 'coin') {
    steps.push(bindStep('the sealed coin', 'secret', p.secret, String(r.result ?? '')));
  } else if (p.game === 'rps') {
    steps.push(bindStep('the sealed move', 'secret', p.secret, String(r.dealerMove ?? '')));
  } else if (p.game === 'highlow') {
    steps.push(bindStep('the sealed next card', 'secret', p.secret, String(r.next ?? '')));
  } else if (p.game === 'number') {
    steps.push(bindStep('the sealed number', 'secret', p.secret, String(r.secret ?? '')));
  } else if (p.game === 'dice') {
    const client = String(r.clientSeed ?? '');
    const h = await sha256Hex(`${p.secret}:${client}`);
    const house = (hexInt(h, 0, 8) % 6) + 1;
    const player = (hexInt(h, 8, 16) % 6) + 1;
    steps.push({
      title: 'both dice',
      formula: `sha256(serverSeed + ":" + clientSeed) = ${short(h, 20)}`,
      computed: `house ${house} · you ${player}`,
      expected: `house ${Number(r.dealerRoll)} · you ${Number(r.playerRoll)}`,
      detail:
        `house: hex[0..8]=${h.slice(0, 8)} → ${hexInt(h, 0, 8)} % 6 + 1 = ${house}   ·   ` +
        `you: hex[8..16]=${h.slice(8, 16)} → ${hexInt(h, 8, 16)} % 6 + 1 = ${player}`,
      ok: house === Number(r.dealerRoll) && player === Number(r.playerRoll),
    });
  } else if (p.game === 'wheel') {
    const client = String(r.clientSeed ?? '');
    const segs = Array.isArray(r.segments) ? (r.segments as number[]) : [];
    const n = segs.length || 12;
    const h = await sha256Hex(`${p.secret}:${client}`);
    const idx = hexInt(h, 0, 8) % n;
    steps.push({
      title: 'the landing segment',
      formula: `sha256(serverSeed + ":" + clientSeed) = ${short(h, 20)}`,
      computed: `segment ${idx} (×${segs[idx] ?? '?'})`,
      expected: `segment ${Number(r.segmentIndex)} (×${Number(r.multiplier)})`,
      detail: `hex[0..8]=${h.slice(0, 8)} → ${hexInt(h, 0, 8)} % ${n} segments = ${idx}`,
      ok: idx === Number(r.segmentIndex),
    });
  } else if (p.game === 'plinko') {
    const client = String(r.clientSeed ?? '');
    const claimed = Array.isArray(r.path) ? (r.path as number[]) : [];
    const h = await sha256Hex(`${p.secret}:${client}`);
    const path = Array.from({ length: claimed.length || 12 }, (_, i) => parseInt(h[i]!, 16) & 1);
    const bucket = path.reduce((a, b) => a + b, 0);
    const okPath = claimed.length > 0 && path.every((bit, i) => bit === claimed[i]);
    steps.push({
      title: 'the ball’s path',
      formula: `sha256(serverSeed + ":" + clientSeed) = ${short(h, 20)}`,
      computed: `${path.join('')} → bucket ${bucket}`,
      expected: `${claimed.join('')} → bucket ${Number(r.bucketIndex)}`,
      detail: `each hex digit & 1 is one peg (0=left, 1=right); the bucket is the count of rights`,
      ok: okPath && bucket === Number(r.bucketIndex),
    });
  } else if (p.game === 'limbo' || p.game === 'crash') {
    const client = String(r.clientSeed ?? '');
    const claimedX100 = Number(p.game === 'crash' ? r.crashX100 : r.resultX100);
    const targetX100 = Number(r.targetX100);
    const h = await sha256Hex(`${p.secret}:${client}`);
    const raw = hexInt(h, 0, 8);
    const rr = (raw + 1) / 0x100000000;
    const x100 = Math.max(100, Math.min(1_000_000, Math.floor((0.96 / rr) * 100)));
    steps.push({
      title: p.game === 'crash' ? 'the crash point' : 'the sealed multiplier',
      formula: `sha256(serverSeed + ":" + clientSeed) = ${short(h, 20)}`,
      computed: `×${(x100 / 100).toFixed(2)}`,
      expected: `×${(claimedX100 / 100).toFixed(2)} (your target ×${(targetX100 / 100).toFixed(2)})`,
      detail:
        `hex[0..8]=${h.slice(0, 8)} → r=(${raw}+1)/2³² → max(1, 0.96/r) = ×${(x100 / 100).toFixed(2)}. ` +
        `You ${claimedX100 >= targetX100 ? 'cleared' : 'missed'} the target — the 0.96 keeps every target at a flat 96% return`,
      ok: x100 === claimedX100,
    });
  } else if (p.game === 'mines') {
    const claimed = Array.isArray(r.mines) ? (r.mines as number[]) : [];
    const cells = 25;
    const idx = Array.from({ length: cells }, (_, i) => i);
    let block = await sha256Hex(`${p.secret}:mines`);
    let offset = 0;
    const draw = async (): Promise<number> => {
      if (offset + 8 > block.length) {
        block = await sha256Hex(block);
        offset = 0;
      }
      const v = parseInt(block.slice(offset, offset + 8), 16);
      offset += 8;
      return v;
    };
    for (let i = cells - 1; i > 0; i--) {
      const j = (await draw()) % (i + 1);
      [idx[i], idx[j]] = [idx[j]!, idx[i]!];
    }
    const mines = idx.slice(0, claimed.length || 5).sort((a, b) => a - b);
    const ok = mines.length === claimed.length && mines.every((m, i) => m === claimed[i]);
    steps.push({
      title: 'the mine layout',
      formula: `Fisher–Yates over 25 cells, seeded by sha256(secret + ":mines")`,
      computed: `mines at [${mines.join(', ')}]`,
      expected: `mines at [${claimed.join(', ')}]`,
      detail:
        'the shuffle draws 32 bits per step from a sha256 chain of the secret — the whole board ' +
        'was fixed by the commitment before you picked a single cell',
      ok,
    });
  } else if (p.game === 'blackjack') {
    const player = Array.isArray(r.player) ? (r.player as number[]) : [];
    const dealer = Array.isArray(r.dealer) ? (r.dealer as number[]) : [];
    // Re-shuffle the shoe from the secret (seeded Fisher–Yates on a sha256
    // chain) and check every revealed card in exact consumption order.
    const idx = Array.from({ length: 52 }, (_, i) => i);
    let block = await sha256Hex(`${p.secret}:deck`);
    let offset = 0;
    const draw = async (): Promise<number> => {
      if (offset + 8 > block.length) {
        block = await sha256Hex(block);
        offset = 0;
      }
      const v = parseInt(block.slice(offset, offset + 8), 16);
      offset += 8;
      return v;
    };
    for (let i = 51; i > 0; i--) {
      const j = (await draw()) % (i + 1);
      [idx[i], idx[j]] = [idx[j]!, idx[i]!];
    }
    const consumed =
      player.length >= 2 && dealer.length >= 2
        ? [player[0]!, dealer[0]!, player[1]!, dealer[1]!, ...player.slice(2), ...dealer.slice(2)]
        : [];
    const ok = consumed.length > 0 && consumed.every((card, i) => card === idx[i]);
    steps.push({
      title: 'the whole shoe',
      formula: 'Fisher–Yates over 52 cards, seeded by sha256(secret + ":deck")',
      computed: `first ${consumed.length} cards: [${idx.slice(0, consumed.length).join(', ')}]`,
      expected: `your hand + dealer, in draw order: [${consumed.join(', ')}]`,
      detail:
        'cards leave the shoe as you-dealer-you-dealer, then your hits, then the dealer draws to 17 — ' +
        'all fixed by the commitment before the first card showed',
      ok,
    });
  } else {
    steps.push({
      title: 'the reveal',
      formula: 'unknown game — only the commitment could be checked',
      computed: '—',
      expected: '—',
      ok: false,
    });
  }

  // 3 — the jackpot roll, if this round rolled for the pot.
  if (p.jackpot) {
    const h = await sha256Hex(`${p.secret}:jackpot:${p.jackpot.input}`);
    const roll = hexInt(h, 0, 6) % p.jackpot.threshold;
    steps.push({
      title: 'the jackpot roll',
      formula: `sha256(secret + ":jackpot:" + "${short(p.jackpot.input, 12)}") = ${short(h, 20)}`,
      computed: `roll ${roll} of ${p.jackpot.threshold}`,
      expected: `roll ${p.jackpot.roll} of ${p.jackpot.threshold}${p.jackpot.hit ? ' — HIT' : ''}`,
      detail: `hex[0..6]=${h.slice(0, 6)} → ${hexInt(h, 0, 6)} % ${p.jackpot.threshold} = ${roll} (0 hits the pot)`,
      ok: roll === p.jackpot.roll,
    });
  }

  return { steps, ok: steps.every((s) => s.ok) };
}

function bindStep(title: string, _kind: string, secret: string, revealed: string): VerifyStep {
  return {
    title,
    formula: 'the committed secret IS the outcome',
    computed: secret,
    expected: revealed,
    detail: 'no derivation needed — the value hashed into the commitment is the result itself',
    ok: secret === revealed && revealed !== '',
  };
}

/** Truncate long hex for display (full value goes in the title attribute). */
export function short(s: string, n = 10): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

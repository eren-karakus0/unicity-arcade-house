/**
 * arcade-player — an Astrid OS capsule that plays Unicity Arcade House
 * autonomously: it opens rounds against the house agent over HTTP, bets real
 * UCT from its in-house balance, and re-verifies every provably-fair reveal
 * (commitment hash, two-seed dice/wheel/plinko derivations, the jackpot roll)
 * before trusting a single result. Machine economy, both sides: an agent
 * playing an agent.
 */
import {
  capsule,
  tool,
  interceptor,
  install,
  upgrade,
  run,
  log,
  env,
  http,
  ipc,
  kv,
  time,
  runtime,
} from "@unicity-astrid/sdk";
import { LOCAL_BAZAAR_SECRET, LOCAL_GEMINI_KEY } from "./local-key.js";

const BACKEND = "https://sphere-agent-bazaar-backend.onrender.com";
/** The capsule's arcade identity (its balance key at the house). */
const IDENTITY = "@astrid-arcade-capsule";
const NAME = "astrid-capsule";

/**
 * The bot league (P1.T2): one sandboxed capsule, several strategist personas —
 * each with its own arcade identity, its own risk appetite baked into the LLM
 * brief, and its own leaderboard row. Capsule-to-capsule IPC composition is
 * upstream-blocked (a JS capsule can PUBLISH but never RECEIVES topics —
 * UPSTREAM.md finding 3, proved by capsules/league-pinger), so the league
 * lives inside one capsule and the personas compete on the public board.
 */
interface Persona {
  identity: string;
  name: string;
  style: string;
  /** Per-persona bet ceiling; always <= the global MAX_BET code clamp. */
  maxBet: number;
  rounds: number;
}

const PERSONAS: readonly Persona[] = [
  {
    identity: IDENTITY,
    name: NAME,
    style: "balanced: mix games, moderate stakes, stop when the session turns clearly bad",
    maxBet: 2,
    rounds: 2,
  },
  {
    identity: "@astrid-daredevil",
    name: "astrid-daredevil",
    style: "aggressive: chase the biggest multipliers and the jackpot, bet at your ceiling",
    maxBet: 3,
    rounds: 2,
  },
  {
    identity: "@astrid-steady",
    name: "astrid-steady",
    style: "cautious: protect the bankroll, prefer the highest win-probability games, minimum bets, stop early after losses",
    maxBet: 1,
    rounds: 2,
  },
] as const;

/* ------------------------------------------------------------------ */
/* SHA-256 (pure TS — the capsule trusts no one, including the house)  */
/* ------------------------------------------------------------------ */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256Hex(input: string): string {
  const data = new TextEncoder().encode(input);
  const l = data.length;
  const padded = new Uint8Array((((l + 8) >> 6) + 1) << 6);
  padded.set(data);
  padded[l] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor((l * 8) / 0x100000000));
  dv.setUint32(padded.length - 4, (l * 8) >>> 0);

  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => ((x >>> n) | (x << (32 - n))) >>> 0;

  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = H[0]!, b = H[1]!, c = H[2]!, d = H[3]!, e = H[4]!, f = H[5]!, g = H[6]!, h = H[7]!;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0]! + a) >>> 0; H[1] = (H[1]! + b) >>> 0; H[2] = (H[2]! + c) >>> 0; H[3] = (H[3]! + d) >>> 0;
    H[4] = (H[4]! + e) >>> 0; H[5] = (H[5]! + f) >>> 0; H[6] = (H[6]! + g) >>> 0; H[7] = (H[7]! + h) >>> 0;
  }
  return [...H].map((x) => x.toString(16).padStart(8, "0")).join("");
}

/* ------------------------------------------------------------------ */
/* Entropy for choices/seeds. The house commits BEFORE seeing any of   */
/* this, so it cannot steer outcomes no matter what we pick.           */
/* ------------------------------------------------------------------ */

let ctr = 0x9e3779b9;
function rnd(): number {
  const t = Number(time.nowMs() & 0xffffffffn);
  const r = Math.floor(Math.random() * 0x100000000);
  ctr = (ctr + 0x9e3779b9) >>> 0;
  return (((t ^ r) >>> 0) ^ ctr) >>> 0;
}
function clientSeed(): string {
  return rnd().toString(16).padStart(8, "0") + rnd().toString(16).padStart(8, "0");
}
function pick<T>(arr: readonly T[]): T {
  return arr[rnd() % arr.length]!;
}

const GAMES = ["rps", "wheel", "plinko", "dice", "coin", "highlow", "number"] as const;
type GameId = (typeof GAMES)[number];

const CHOOSE: Record<GameId, () => unknown> = {
  rps: () => pick(["rock", "paper", "scissors"] as const),
  coin: () => pick(["heads", "tails"] as const),
  highlow: () => pick(["higher", "lower"] as const),
  number: () => 1 + (rnd() % 6),
  dice: () => clientSeed(),
  wheel: () => clientSeed(),
  plinko: () => clientSeed(),
};

/* ------------------------------------------------------------------ */
/* Arcade HTTP API                                                     */
/* ------------------------------------------------------------------ */

interface NewRound {
  roundId: string;
  commit: string;
  jackpotUct?: number;
  you?: { chips: number; chipsGranted: number };
  error?: string;
}
interface PlayResult {
  outcome: "win" | "lose" | "tie";
  rewardUct: number;
  bet: number;
  chips: number;
  commit: string;
  secret: string;
  nonce: string;
  reveal: Record<string, unknown>;
  jackpot?: { roll: number; threshold: number; hit: boolean; potUct: number; input: string };
  error?: string;
}
interface Leaderboard {
  ready: boolean;
  house: string | null;
  houseStats?: { jackpotUct?: number; paidOutUct?: number; roundsPlayed?: number };
  error?: string;
}

function get<T>(path: string): T {
  return http.send(http.Request.get(`${BACKEND}${path}`)) .json<T>();
}
function post<T>(path: string, body: unknown): T {
  const res = http.send(http.Request.post(`${BACKEND}${path}`).json(body));
  return res.json<T>();
}

/* ------------------------------------------------------------------ */
/* Provably-fair verification — recomputed inside the capsule          */
/* ------------------------------------------------------------------ */

interface Fairness {
  commitOk: boolean;
  gameOk: boolean;
  jackpotOk: boolean;
  allOk: boolean;
}

function verifyFairness(game: GameId, r: PlayResult, precommit: string, sentChoice: unknown): Fairness {
  // Pre-commit binding: the reveal must open the SAME commitment we were handed
  // at round open — not merely a commit the reveal echoes to itself. Without this
  // the check is self-referential and a dishonest house could pick its secret
  // after seeing our choice and return a self-consistent (secret,nonce,commit).
  const commitOk =
    r.commit === precommit && sha256Hex(`${r.secret}:${r.nonce}`) === r.commit;

  let gameOk = true;
  const rv = r.reveal;
  // Seed pinning: for seed-derived games the client seed used in the derivation
  // must be the exact value we sent, or the house could grind a favorable seed
  // and echo it back.
  const seedPinned = String(rv.clientSeed) === String(sentChoice);
  if (game === "dice") {
    const h = sha256Hex(`${r.secret}:${String(rv.clientSeed)}`);
    gameOk =
      seedPinned &&
      (parseInt(h.slice(0, 8), 16) % 6) + 1 === Number(rv.dealerRoll) &&
      (parseInt(h.slice(8, 16), 16) % 6) + 1 === Number(rv.playerRoll);
  } else if (game === "wheel") {
    const segs = (rv.segments as number[] | undefined) ?? [];
    const h = sha256Hex(`${r.secret}:${String(rv.clientSeed)}`);
    gameOk =
      seedPinned && segs.length > 0 && parseInt(h.slice(0, 8), 16) % segs.length === Number(rv.segmentIndex);
  } else if (game === "plinko") {
    const path = (rv.path as number[] | undefined) ?? [];
    const h = sha256Hex(`${r.secret}:${String(rv.clientSeed)}`);
    gameOk =
      seedPinned &&
      path.length > 0 &&
      path.every((bit, i) => (parseInt(h[i]!, 16) & 1) === bit) &&
      path.reduce((a, b) => a + b, 0) === Number(rv.bucketIndex);
  }

  let jackpotOk = true;
  if (r.jackpot) {
    const h = sha256Hex(`${r.secret}:jackpot:${r.jackpot.input}`);
    jackpotOk = parseInt(h.slice(0, 6), 16) % r.jackpot.threshold === r.jackpot.roll;
  }

  return { commitOk, gameOk, jackpotOk, allOk: commitOk && gameOk && jackpotOk };
}

/* ------------------------------------------------------------------ */
/* One round, played end to end                                        */
/* ------------------------------------------------------------------ */

interface RoundReport {
  game: GameId;
  bet: number;
  outcome: string;
  rewardUct: number;
  balance: number;
  fair: Fairness;
  jackpotHit: boolean;
}

function playOne(game: GameId, bet: number, identity = IDENTITY, name = NAME): RoundReport {
  const nr = post<NewRound>("/api/arcade/new", { game, address: identity });
  if (!nr.roundId) throw new Error(nr.error ?? "could not open a round");
  const choice = CHOOSE[game]();
  const pr = post<PlayResult>("/api/arcade/play", {
    roundId: nr.roundId,
    choice,
    bet,
    address: identity,
    name,
  });
  if (!pr.reveal) throw new Error(pr.error ?? "play failed");
  const fair = verifyFairness(game, pr, nr.commit, choice);
  if (!fair.allOk) log.warn(`FAIRNESS CHECK FAILED on ${game}: ${JSON.stringify(fair)}`);
  return {
    game,
    bet,
    outcome: pr.outcome,
    rewardUct: pr.rewardUct,
    balance: pr.chips,
    fair,
    jackpotHit: pr.jackpot?.hit === true,
  };
}

/* ------------------------------------------------------------------ */
/* LLM strategist — the capsule REASONS about game/bet/stop instead of */
/* picking randomly. Capability-gated HTTP to Gemini (the manifest's   */
/* net allow-list is exactly: the arcade + the LLM endpoint). The LLM  */
/* only SUGGESTS; every hard limit is enforced in code below, and the  */
/* provably-fair verification of each reveal is completely unchanged.  */
/* The key arrives via Capsule.toml [env] (injected into the STAGED    */
/* manifest at install time by install-wsl.sh — never committed).      */
/* No key / any failure → the entropy picker plays instead.            */
/* ------------------------------------------------------------------ */

const MAX_BET = 3; // hard in-code cap per round, whatever the LLM says
// gemini-flash-latest: Google retired the free-tier quota of pinned 2.0-flash
// (limit: 0 as of 2026-07); the -latest alias survives model rotations.
const LLM_MODEL = "gemini-flash-latest";

interface Decision {
  game: GameId;
  bet: number;
  stop: boolean;
  reason: string;
  source: "llm" | "entropy";
}

interface RoundBrief {
  game: GameId;
  bet: number;
  outcome: string;
  rewardUct: number;
}

function entropyDecision(): Decision {
  return { game: pick(GAMES), bet: 1, stop: false, reason: "entropy pick", source: "entropy" };
}

/** Ask Gemini for the next move. Returns null on any failure (caller falls back). */
function llmDecide(state: {
  balance: number;
  jackpotUct: number | null;
  roundsLeft: number;
  history: RoundBrief[];
  /** Persona flavor + per-persona bet ceiling (league play). */
  style?: string;
  maxBet?: number;
}): Decision | null {
  // Runtime config first (future kernels), then the build-time baked key —
  // on astrid 0.9.4 get-config returns none for EVERY key (UPSTREAM.md
  // finding 4), so the local build is the delivery that provably works.
  const key = env.get("GEMINI_API_KEY") || LOCAL_GEMINI_KEY;
  if (!key) return null;
  const betCap = Math.min(MAX_BET, Math.max(1, state.maxBet ?? MAX_BET));
  const prompt = [
    "You are the strategist for an autonomous player at a provably-fair arcade.",
    ...(state.style ? [`Your persona: ${state.style}. Stay in character.`] : []),
    "Games (multiplier on win, rough win odds): rps x2 ~1/3 (ties push), coin x2 1/2,",
    "highlow x2 ~1/2, dice x2 ~15/36, wheel x2 ~5/12, plinko x2..x4 mixed, number x5 1/6.",
    "Every round also rolls a side jackpot. You cannot influence outcomes - they are",
    "committed before your choice. Choose the next move; stop early if the session",
    `has gone badly. Balance: ${state.balance} UCT. Jackpot pot: ${state.jackpotUct ?? "?"} UCT.`,
    `Rounds left in this session: ${state.roundsLeft}.`,
    `History this session: ${state.history.length === 0 ? "(none yet)" : JSON.stringify(state.history)}.`,
    'Reply with ONLY this JSON: {"game":"rps|wheel|plinko|dice|coin|highlow|number",',
    `"bet":1-${betCap},"stop":true|false,"reason":"<one short sentence>"}`,
  ].join("\n");
  try {
    const res = http.send(
      http.Request.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${LLM_MODEL}:generateContent`,
      )
        .header("x-goog-api-key", key)
        .json({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.4,
            // Room for the answer even if the model spends tokens thinking…
            maxOutputTokens: 1024,
            // …but prefer no thinking at all: flash-latest resolves to a
            // thinking model whose thought tokens otherwise eat the budget
            // (observed: ~25s calls returning empty/truncated parts).
            thinkingConfig: { thinkingBudget: 0 },
            responseMimeType: "application/json",
          },
        }),
    );
    const body = res.json<{
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      error?: { message?: string };
    }>();
    if (body.error) {
      log.warn(`[strategist] LLM API error: ${String(body.error.message ?? "unknown").slice(0, 120)}`);
      return null;
    }
    // Join all parts and tolerate markdown fences / prose around the JSON.
    const raw = (body.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) {
      log.warn(`[strategist] LLM reply had no JSON (starts: "${raw.slice(0, 60)}")`);
      return null;
    }
    const parsed = JSON.parse(raw.slice(start, end + 1)) as {
      game?: unknown;
      bet?: unknown;
      stop?: unknown;
      reason?: unknown;
    };
    // Hard limits live HERE, not in the prompt: validate the game against the
    // known menu, clamp the bet to [1, betCap] and never above the balance.
    const game = (GAMES as readonly string[]).includes(String(parsed.game)) ? (String(parsed.game) as GameId) : null;
    if (!game) return null;
    const bet = Math.min(Math.max(1, Math.floor(Number(parsed.bet) || 1)), betCap, Math.max(1, state.balance));
    return {
      game,
      bet,
      stop: parsed.stop === true,
      reason: String(parsed.reason ?? "").slice(0, 120) || "no reason given",
      source: "llm",
    };
  } catch (e) {
    log.warn(`[strategist] LLM unavailable (${(e as Error).message ?? e}) - falling back to entropy`);
    return null;
  }
}

/** Next move: the LLM's (validated, clamped) suggestion, or the entropy picker. */
function decideNext(state: {
  balance: number;
  jackpotUct: number | null;
  roundsLeft: number;
  history: RoundBrief[];
  style?: string;
  maxBet?: number;
}): Decision {
  return llmDecide(state) ?? entropyDecision();
}

/* ------------------------------------------------------------------ */
/* Bazaar oracle — serving the Agent Bazaar's capsule delivery channel */
/*                                                                     */
/* The capsule cannot receive pushes, so the marketplace parks funded  */
/* jobs in a mailbox and THIS loop polls for them: lease the work, do  */
/* it for real (play + verify one provably-fair arcade round), post    */
/* the result back — escrow releases on delivery. Auth: the shared     */
/* secret baked at build time (env-gated on both sides).               */
/* ------------------------------------------------------------------ */

const BAZAAR = "https://unicity-agent-bazaar-backend.onrender.com";
const CAPSULE_REF = "arcade-player";
const ORACLE_IDENTITY = "@astrid-bazaar-oracle";
const ORACLE_NAME = "astrid-oracle";

interface BazaarInvocation {
  jobId: string;
  input?: unknown;
  amountUct?: number;
  escrowRef?: string;
}

function bazaarHeaders(): { key: string; value: string }[] {
  return [{ key: "x-capsule-secret", value: LOCAL_BAZAAR_SECRET }];
}

/** One mailbox sweep: lease parked jobs, play the round, post results. */
function serveBazaarInbox(): void {
  if (!LOCAL_BAZAAR_SECRET) return; // channel disabled at build time
  let jobs: BazaarInvocation[] = [];
  try {
    const req = http.Request.get(`${BAZAAR}/api/capsule/inbox?ref=${encodeURIComponent(CAPSULE_REF)}`);
    for (const h of bazaarHeaders()) req.header(h.key, h.value);
    jobs = http.send(req).json<{ invocations?: BazaarInvocation[] }>().invocations ?? [];
  } catch (e) {
    // The bazaar may be asleep (free tier) - this poll doubles as its wake-up.
    log.warn(`[oracle] inbox poll failed: ${(e as Error).message ?? String(e)}`);
    return;
  }
  for (const job of jobs) {
    log.info(`[oracle] leased bazaar job ${job.jobId} (${job.amountUct ?? "?"} UCT escrowed)`);
    let ok = false;
    let output: unknown;
    let error: string | undefined;
    try {
      const o = (job.input ?? {}) as Record<string, unknown>;
      const game = (GAMES as readonly string[]).includes(String(o.game ?? "").toLowerCase())
        ? (String(o.game).toLowerCase() as GameId)
        : pick(GAMES);
      const bet = Math.min(MAX_BET, Math.max(1, Math.floor(Number(o.bet) || 1)));
      const report = playOne(game, bet, ORACLE_IDENTITY, ORACLE_NAME);
      ok = report.fair.allOk; // an unfair reveal is a FAILED delivery - by design
      output = {
        engine: "unicity-arcade-house via astrid-capsule",
        ...report,
        verifiedInSandbox: report.fair.allOk,
      };
      if (!ok) error = "fairness verification failed on the reveal";
      log.info(
        `[oracle] job ${job.jobId}: ${game} bet=${bet} → ${report.outcome} fair=${report.fair.allOk}`,
      );
    } catch (e) {
      error = (e as Error).message ?? String(e);
      log.warn(`[oracle] job ${job.jobId} failed: ${error}`);
    }
    try {
      const req = http.Request.post(`${BAZAAR}/api/capsule/result`);
      for (const h of bazaarHeaders()) req.header(h.key, h.value);
      const res = http
        .send(req.json({ jobId: job.jobId, ok, output, ...(error ? { error } : {}) }))
        .json<{ accepted?: boolean }>();
      log.info(`[oracle] job ${job.jobId} result posted (accepted=${res.accepted === true})`);
    } catch (e) {
      log.warn(`[oracle] result post failed for ${job.jobId}: ${(e as Error).message ?? String(e)}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* The capsule                                                         */
/* ------------------------------------------------------------------ */

@capsule
export class ArcadePlayer {
  roundsPlayed = 0;
  netUct = 0;

  /**
   * House status + this capsule's balance at the arcade. Marked mutable so the
   * bridge hydrates the persisted instance state (roundsPlayed/netUct) before the
   * call — non-mutable tools get a fresh instance and would always report zero.
   */
  @tool("status", { mutable: true })
  status(_args: object): {
    house: string | null;
    jackpotUct: number | null;
    balanceUct: number;
    roundsPlayed: number;
    netUct: number;
  } {
    const lb = get<Leaderboard>("/api/arcade/leaderboard");
    const bal = get<{ balanceUct: number }>(
      `/api/arcade/balance?address=${encodeURIComponent(IDENTITY)}`,
    );
    return {
      house: lb.house,
      jackpotUct: lb.houseStats?.jackpotUct ?? null,
      balanceUct: bal.balanceUct,
      roundsPlayed: this.roundsPlayed,
      netUct: this.netUct,
    };
  }

  /** Play ONE provably-fair round against the house and verify the reveal. */
  @tool("play", { mutable: true })
  play(args: { game?: string; bet?: number }): RoundReport {
    const game = (GAMES as readonly string[]).includes(args.game ?? "")
      ? (args.game as GameId)
      : pick(GAMES);
    const bet = Math.max(1, Math.floor(args.bet ?? 1));
    const report = playOne(game, bet);
    this.roundsPlayed += 1;
    this.netUct += report.rewardUct - bet;
    log.info(
      `played ${game} bet=${bet} → ${report.outcome} (+${report.rewardUct}) balance=${report.balance} fair=${report.fair.allOk}`,
    );
    return report;
  }

  /**
   * An autonomous session: several rounds across the hall, with a summary.
   * When the caller pins neither game nor bet, the LLM strategist decides
   * each move (validated + clamped in code; entropy fallback without a key).
   */
  @tool("session", { mutable: true })
  session(args: { rounds?: number; game?: string; bet?: number }): {
    rounds: RoundReport[];
    wins: number;
    losses: number;
    ties: number;
    netUct: number;
    endBalance: number;
    allFair: boolean;
    jackpots: number;
    strategist: "llm" | "entropy" | "caller";
  } {
    const n = Math.min(20, Math.max(1, Math.floor(args.rounds ?? 5)));
    const fixed = (GAMES as readonly string[]).includes(args.game ?? "")
      ? (args.game as GameId)
      : null;
    const fixedBet = args.bet !== undefined ? Math.max(1, Math.floor(args.bet)) : null;
    const callerPinned = fixed !== null || fixedBet !== null;
    let balance = get<{ balanceUct: number }>(
      `/api/arcade/balance?address=${encodeURIComponent(IDENTITY)}`,
    ).balanceUct;
    const jackpotUct = get<Leaderboard>("/api/arcade/leaderboard").houseStats?.jackpotUct ?? null;
    const rounds: RoundReport[] = [];
    const history: RoundBrief[] = [];
    let llmUsed = false;
    for (let i = 0; i < n; i++) {
      let game: GameId;
      let bet: number;
      if (callerPinned) {
        game = fixed ?? pick(GAMES);
        bet = fixedBet ?? 1;
      } else {
        const d = decideNext({
          balance: Math.max(1, balance),
          jackpotUct,
          roundsLeft: n - i,
          history,
        });
        if (d.source === "llm") llmUsed = true;
        log.info(
          `[strategist] ${d.source}: ${d.stop ? "STOP" : `play ${d.game} bet=${d.bet}`} — ${d.reason}`,
        );
        if (d.stop) break;
        game = d.game;
        bet = d.bet;
      }
      const report = playOne(game, bet);
      rounds.push(report);
      history.push({ game: report.game, bet: report.bet, outcome: report.outcome, rewardUct: report.rewardUct });
      balance = report.balance;
      this.roundsPlayed += 1;
      this.netUct += report.rewardUct - bet;
      if (report.balance < bet) break; // out of UCT — stop honestly
      time.sleepMs(900); // respect the house's per-address cooldown
    }
    const wins = rounds.filter((r) => r.outcome === "win").length;
    const losses = rounds.filter((r) => r.outcome === "lose").length;
    const last = rounds[rounds.length - 1];
    return {
      rounds,
      wins,
      losses,
      ties: rounds.length - wins - losses,
      netUct: rounds.reduce((a, r) => a + r.rewardUct - r.bet, 0),
      endBalance: last ? last.balance : balance,
      allFair: rounds.every((r) => r.fair.allOk),
      jackpots: rounds.filter((r) => r.jackpotHit).length,
      strategist: callerPinned ? "caller" : llmUsed ? "llm" : "entropy",
    };
  }

  /**
   * CLI verb: `astrid capsule arcade <status|play|session> [args…]`.
   * The kernel routes `cli.v1.command.run.arcade-player` here; we reply on
   * the per-request result topic (capsule-space wire contract).
   */
  /**
   * League ping — the capsule-to-capsule composition probe (P1.T2). Fires iff
   * the kernel delivers subscribed bus topics to this JS capsule; the entry
   * log is the whole verdict (see UPSTREAM.md finding 3).
   */
  @interceptor("league.ping")
  leaguePing(payload: unknown): { handled: boolean } {
    log.info(`[league] ping received: ${JSON.stringify(payload ?? null).slice(0, 160)}`);
    return { handled: true };
  }

  @interceptor("cli.run")
  cliRun(payload: { req_id?: string; command?: string; args?: string[] } | undefined): {
    handled: boolean;
  } {
    // Entry log first: proves on the kernel log that the hook actually fired
    // and shows the exact payload shape the bridge delivered.
    log.info(`[cli] run received: ${JSON.stringify(payload ?? null)}`);
    const reqId = String(payload?.req_id ?? "");
    const args = Array.isArray(payload?.args) ? payload.args.map(String) : [];
    let output = "";
    let error: string | undefined;
    let exitCode = 0;
    try {
      const [sub = "status", a1, a2, a3] = args;
      if (sub === "status") {
        output = JSON.stringify(this.status({}), null, 1);
      } else if (sub === "play") {
        output = JSON.stringify(this.play({ ...(a1 ? { game: a1 } : {}), bet: Number(a2 ?? 1) }), null, 1);
      } else if (sub === "session") {
        output = JSON.stringify(
          this.session({ rounds: Number(a1 ?? 5), ...(a2 ? { game: a2 } : {}), bet: Number(a3 ?? 1) }),
          null,
          1,
        );
      } else {
        output = "usage: arcade status | play [game] [bet] | session [rounds] [game] [bet]";
      }
    } catch (e) {
      error = (e as Error).message ?? String(e);
      exitCode = 1;
    }
    if (reqId) {
      ipc.publishJson(`cli.v1.command.result.${reqId}`, {
        req_id: reqId,
        exit_code: exitCode,
        output,
        ...(error ? { error } : {}),
      });
    }
    return { handled: true };
  }

  /**
   * Daemon loop: signal readiness, play the league's opening round, then keep
   * serving the Agent Bazaar's capsule mailbox forever. The loop must NOT
   * return — the kernel health-checks the run loop and treats a return as a
   * crash ("WASM run loop exited unexpectedly" → restart storm; verified
   * empirically on astrid 0.9.4). Short sleeps keep the guest parked in a
   * host call rather than burning CPU; the mailbox is polled every ~15s.
   */
  @run
  daemon(): void {
    runtime.signalReady();
    log.info(
      `arcade-player ready on the floor${LOCAL_BAZAAR_SECRET ? " — serving the bazaar capsule mailbox" : ""}`,
    );
    walkOntoTheFloor("daemon");
    let tick = 0;
    for (;;) {
      time.sleepMs(1_000);
      tick += 1;
      if (tick % 15 === 0) {
        try {
          serveBazaarInbox();
        } catch (e) {
          // The mailbox loop must never kill the daemon.
          log.warn(`[oracle] sweep crashed: ${(e as Error).message ?? String(e)}`);
        }
      }
    }
  }

  @install
  onInstall(): void {
    // Self-test the hasher before trusting any fairness verdicts.
    const ok =
      sha256Hex("abc") === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    if (!ok) throw new Error("sha256 self-test failed");
    log.info("arcade-player installed — sha256 self-test passed, hitting the floor");
    walkOntoTheFloor("install");
  }

  @upgrade
  onUpgrade(): void {
    log.info("arcade-player upgraded — back on the floor");
    walkOntoTheFloor("upgrade");
  }
}

/**
 * The league walks onto the floor — played straight from the capsule's
 * lifecycle hooks and daemon start: each persona (its own arcade identity,
 * its own risk appetite in the LLM brief, its own leaderboard row) plays a
 * short session, every move decided by the strategist (validated + clamped
 * in code) and every reveal re-verified in-sandbox. Without a key the
 * entropy picker plays for everyone.
 */
function walkOntoTheFloor(context: string): void {
  try {
    // Presence probe (never the value): which instance kinds can see config?
    // ASTRID_SOCKET_PATH is a kernel-injected builtin - the control: if IT is
    // readable but our [env] key is not, the env-config binding is the gap.
    const keyState = env.tryGet("GEMINI_API_KEY") === undefined ? "unset" : "SET";
    const ctlState = env.tryGet("ASTRID_SOCKET_PATH") === undefined ? "unset" : "SET";
    log.info(`[strategist] config probe (${context}): GEMINI_API_KEY ${keyState}, ASTRID_SOCKET_PATH ${ctlState}`);
    const lb = get<Leaderboard>("/api/arcade/leaderboard");
    const jackpotUct = lb.houseStats?.jackpotUct ?? null;
    log.info(`[floor] house=@${lb.house ?? "?"} jackpot=${jackpotUct ?? "?"} UCT — the league walks in`);
    const league: Record<string, unknown>[] = [];
    for (const p of PERSONAS) {
      const summary = playPersonaSession(p, jackpotUct);
      league.push({ name: p.name, ...summary });
      time.sleepMs(950);
    }
    kv.set("league-last", { at: Number(time.nowMs()), context, league });
    log.info(`[league] round complete: ${JSON.stringify(league.map((b) => `${b.name}:${b.netUct}`))}`);
  } catch (e) {
    // A hiccup on the floor must never fail the install itself.
    log.warn(`[floor] league round skipped: ${(e as Error).message ?? String(e)}`);
  }
}

/** One persona's short session: fetch balance, reason each move, play, report. */
function playPersonaSession(
  p: Persona,
  jackpotUct: number | null,
): { rounds: number; wins: number; netUct: number; endBalance: number; allFair: boolean; strategist: string } {
  let balance = get<{ balanceUct: number }>(
    `/api/arcade/balance?address=${encodeURIComponent(p.identity)}`,
  ).balanceUct;
  const rounds: RoundReport[] = [];
  const history: RoundBrief[] = [];
  let llmUsed = false;
  for (let i = 0; i < p.rounds; i++) {
    const d = decideNext({
      balance: Math.max(1, balance),
      jackpotUct,
      roundsLeft: p.rounds - i,
      history,
      style: p.style,
      maxBet: p.maxBet,
    });
    if (d.source === "llm") llmUsed = true;
    log.info(
      `[league] ${p.name} (${d.source}): ${d.stop ? "STOP" : `play ${d.game} bet=${d.bet}`} — ${d.reason}`,
    );
    if (d.stop) break;
    const r = playOne(d.game, Math.min(d.bet, p.maxBet), p.identity, p.name);
    rounds.push(r);
    history.push({ game: r.game, bet: r.bet, outcome: r.outcome, rewardUct: r.rewardUct });
    balance = r.balance;
    log.info(
      `[league] ${p.name} round ${i + 1}: ${r.game} bet=${r.bet} → ${r.outcome} +${r.rewardUct} UCT ` +
        `(balance ${r.balance}) fair=${r.fair.allOk}${r.jackpotHit ? " JACKPOT!" : ""}`,
    );
    if (r.balance < 1) break;
    time.sleepMs(950);
  }
  const net = rounds.reduce((a, r) => a + r.rewardUct - r.bet, 0);
  const summary = {
    rounds: rounds.length,
    wins: rounds.filter((r) => r.outcome === "win").length,
    netUct: net,
    endBalance: rounds[rounds.length - 1]?.balance ?? balance,
    allFair: rounds.every((r) => r.fair.allOk),
    strategist: llmUsed ? "llm" : "entropy",
  };
  log.info(
    `[league] ${p.name} session: ${summary.rounds} rounds, ${summary.wins} wins, net ${net >= 0 ? "+" : ""}${net} UCT, ` +
      `balance ${summary.endBalance}, strategist=${summary.strategist}, fair=${summary.allFair}`,
  );
  return summary;
}

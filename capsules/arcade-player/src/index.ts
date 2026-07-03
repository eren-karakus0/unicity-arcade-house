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
  http,
  ipc,
  kv,
  time,
  runtime,
} from "@unicity-astrid/sdk";

const BACKEND = "https://sphere-agent-bazaar-backend.onrender.com";
/** The capsule's arcade identity (its balance key at the house). */
const IDENTITY = "@astrid-arcade-capsule";
const NAME = "astrid-capsule";

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

function playOne(game: GameId, bet: number): RoundReport {
  const nr = post<NewRound>("/api/arcade/new", { game, address: IDENTITY });
  if (!nr.roundId) throw new Error(nr.error ?? "could not open a round");
  const choice = CHOOSE[game]();
  const pr = post<PlayResult>("/api/arcade/play", {
    roundId: nr.roundId,
    choice,
    bet,
    address: IDENTITY,
    name: NAME,
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

  /** An autonomous session: several rounds across the hall, with a summary. */
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
  } {
    const n = Math.min(20, Math.max(1, Math.floor(args.rounds ?? 5)));
    const bet = Math.max(1, Math.floor(args.bet ?? 1));
    const fixed = (GAMES as readonly string[]).includes(args.game ?? "")
      ? (args.game as GameId)
      : null;
    const rounds: RoundReport[] = [];
    for (let i = 0; i < n; i++) {
      const report = playOne(fixed ?? pick(GAMES), bet);
      rounds.push(report);
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
      endBalance: last ? last.balance : 0,
      allFair: rounds.every((r) => r.fair.allOk),
      jackpots: rounds.filter((r) => r.jackpotHit).length,
    };
  }

  /**
   * CLI verb: `astrid capsule arcade <status|play|session> [args…]`.
   * The kernel routes `cli.v1.command.run.arcade-player` here; we reply on
   * the per-request result topic (capsule-space wire contract).
   */
  @interceptor("cli.run")
  cliRun(payload: { req_id?: string; command?: string; args?: string[] } | undefined): {
    handled: boolean;
  } {
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

  /** Daemon loop: signal readiness so bus-routed dispatch (tools, CLI verbs) reaches us. */
  @run
  daemon(): void {
    runtime.signalReady();
    log.info("arcade-player ready on the floor");
    for (;;) time.sleepMs(30_000);
  }

  @install
  onInstall(): void {
    // Self-test the hasher before trusting any fairness verdicts.
    const ok =
      sha256Hex("abc") === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    if (!ok) throw new Error("sha256 self-test failed");
    log.info("arcade-player installed — sha256 self-test passed, hitting the floor");
    walkOntoTheFloor();
  }

  @upgrade
  onUpgrade(): void {
    log.info("arcade-player upgraded — back on the floor");
    walkOntoTheFloor();
  }
}

/**
 * A short autonomous session played straight from the capsule's lifecycle
 * hook — the whole machine-economy loop (open round → bet real UCT → verify
 * the provably-fair reveal) executes INSIDE the Astrid kernel's WASM sandbox
 * and reports to the kernel log. (Bus-routed tool dispatch needs the JS
 * SDK's daemon mode, which is still alpha on released kernels — lifecycle
 * hooks are the proven execution path today.)
 */
function walkOntoTheFloor(): void {
  try {
    const lb = get<Leaderboard>("/api/arcade/leaderboard");
    log.info(`[floor] house=@${lb.house ?? "?"} jackpot=${lb.houseStats?.jackpotUct ?? "?"} UCT`);
    const rounds: RoundReport[] = [];
    for (let i = 0; i < 3; i++) {
      const r = playOne(pick(GAMES), 1);
      rounds.push(r);
      log.info(
        `[floor] round ${i + 1}: ${r.game} bet=${r.bet} → ${r.outcome} +${r.rewardUct} UCT ` +
          `(balance ${r.balance}) fair=${r.fair.allOk}${r.jackpotHit ? " JACKPOT!" : ""}`,
      );
      if (r.balance < 1) break;
      time.sleepMs(950);
    }
    const net = rounds.reduce((a, r) => a + r.rewardUct - r.bet, 0);
    const allFair = rounds.every((r) => r.fair.allOk);
    const summary = {
      rounds: rounds.length,
      wins: rounds.filter((r) => r.outcome === "win").length,
      netUct: net,
      endBalance: rounds[rounds.length - 1]?.balance ?? 0,
      allFair,
      at: Number(time.nowMs()),
    };
    kv.set("last-session", summary);
    log.info(
      `[floor] session over: ${summary.rounds} rounds, ${summary.wins} wins, net ${net >= 0 ? "+" : ""}${net} UCT, ` +
        `balance ${summary.endBalance}, every reveal verified fair=${allFair}`,
    );
  } catch (e) {
    // A hiccup on the floor must never fail the install itself.
    log.warn(`[floor] session skipped: ${(e as Error).message ?? String(e)}`);
  }
}

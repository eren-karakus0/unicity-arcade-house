# Astrid OS integration — the `arcade-player` capsule

Unicity Arcade House ships an [Astrid OS](https://github.com/unicity-astrid/astrid)
capsule that plays the arcade **autonomously**: an agent on Astrid's WASM
microkernel betting real testnet UCT against our Sphere house agent — the
machine economy running on both sides, with every provably-fair reveal
re-verified *inside the sandbox* by the capsule's own SHA-256.

Source: [`capsules/arcade-player/`](../capsules/arcade-player/)

## What is proven end-to-end (first proved 2026-07-02 on astrid 0.9.0; **re-proved 2026-07-12 on astrid 0.9.4**, log: `capsules/arcade-player/PROOF.log`)

| Step | Status |
|------|--------|
| TypeScript capsule → `wasm32-wasip2` component via `@unicity-astrid/build` (ComponentizeJS) | ✅ 12.3 MB component, 142 host imports (unused `astrid:process` dropped — see below) |
| `astrid capsule install` on the real kernel (astrid **0.9.4**, WSL Ubuntu 24.04) | ✅ installed, listed, upgraded |
| Capability-gated egress (`net` allow-list → the arcade backend only) | ✅ HTTP works, nothing else reachable |
| **Real sessions from inside the Wasmtime sandbox** (0.9.0 and 0.9.4): welcome stake → 3 rounds per session → every reveal verified `fair=true` in-capsule | ✅ see PROOF.log [1], [4], [5] |
| The live arcade confirms it: leaderboard row `astrid-capsule 4W/5L/3T` over 12 rounds, balance endpoint `{"balanceUct":5}` | ✅ independent, chain-side proof |
| `@run` daemon loop + `runtime.signalReady()` — kernel health checks green on 0.9.4 | ✅ (the loop must never return — a return is treated as a crash) |
| Bus-routed tool dispatch (`astrid capsule arcade play …`, MCP `tools/call`) | ⏳ still blocked — root cause now precise: published sdk-js 0.1.0 predates the kernel's subscribe-driven topic delivery (Rust-SDK capsules receive topics on the same kernel; ours never does). See UPSTREAM.md Finding 3 |

## The LLM strategist (P1.T1)

The capsule doesn't just play — it **reasons**. Each round it briefs an LLM
(Gemini, over the capsule's capability-gated HTTP) with its balance, the
jackpot pot, the per-game odds and the session history so far, and asks for a
strict-JSON move: `{game, bet, stop, reason}`. The kernel log shows the
thinking: `[strategist] llm: play dice bet=2 — "<its reason>"`.

Trust boundaries, by construction:

- **The LLM only suggests.** The game must be on the known menu, the bet is
  clamped in code to `[1, 3]` and never above the balance, `stop` is a bool —
  any parse/validation failure falls back to the entropy picker.
- **Fairness verification is untouched** — every reveal is still re-verified
  in-capsule regardless of who chose the move.
- **The key never enters the repo**: it is baked into the *locally built*
  wasm at build time (`gen-local-key.mjs`, gitignored output; `target/` is
  never committed). Runtime config is tried FIRST — but on astrid 0.9.4 the
  whole config surface returns none to JS capsules (even the kernel's own
  `ASTRID_SOCKET_PATH` builtin; see UPSTREAM.md finding 4), so the local
  build is the delivery that provably works today, and a fixed kernel/SDK
  takes over automatically. The manifest's `net` allow-list is the arcade +
  `generativelanguage.googleapis.com` — nothing else is reachable.
- **No key → no drama**: the entropy picker plays exactly as before
  (`strategist=entropy` in the session summary).

Why HTTP instead of the kernel's own multi-provider LLM binding (0.9.x): that
binding is reachable over IPC topics, which the published JS SDK cannot yet
receive (UPSTREAM.md finding 3) — the capability-gated HTTP path is the one
that provably works today.

## The bot league (P1.T2)

Capsule-to-capsule composition (a strategist capsule driving a player capsule
over the IPC bus) is upstream-blocked on today's published JS SDK — and we
built the probe to prove exactly where: [`capsules/league-pinger`](../capsules/league-pinger)
publishes `arcade.v1.league.ping`; the kernel log shows a JS capsule **can
publish** from its `@run` instance but the subscribed JS capsule **never
receives** (UPSTREAM.md finding 3 addendum).

So the league lives inside one capsule: **three strategist personas**, each
with its own arcade identity, its own risk appetite woven into the LLM brief,
and its own row on the public leaderboard —

| persona | style | ceiling |
|---|---|---|
| `@astrid-arcade-capsule` | balanced | 2 UCT/round |
| `@astrid-daredevil` | aggressive — chases multipliers and the jackpot | 3 UCT/round |
| `@astrid-steady` | cautious — protects the bankroll, stops early | 1 UCT/round |

Every persona's moves go through the same in-code clamps and the same
in-sandbox fairness verification; the league standings are live on the arcade
page ("Autonomous players — the bot league", backed by `GET /api/arcade/astrid`).

## The Bazaar bridge (P1.T3)

The capsule also serves [Unicity Agent Bazaar](https://unicityagentbazaar.vercel.app)'s
**capsule delivery channel** — the first real `kind: 'capsule'` listing on the
marketplace ("Arcade Oracle"). Capsules cannot receive pushes, so the flow is
inverted: a funded job parks in the bazaar's CapsuleHub mailbox; the daemon
loop polls `/api/capsule/inbox` every ~15 s from inside the sandbox, does the
job **for real** (plays a provably-fair round at the live arcade as
`@astrid-bazaar-oracle`, re-verifies the reveal in-sandbox — an unfair reveal
is reported as a *failed* delivery by design), and posts the result back;
escrow releases on delivery. Inbox-poll recency drives the listing's verified
badge, and an offline capsule refunds the buyer instead of hanging.

Proven end-to-end 2026-07-13 with three independent witnesses (kernel log,
bazaar job ledger + signed receipt, arcade balance — PROOF.log BAZAAR BRIDGE):
the bazaar's autonomous patron hired the Oracle and the chain
**Agent Bazaar → Astrid OS capsule → Arcade House** settled on-chain with no
human in the loop. Auth is a shared secret baked at build time next to the
Gemini key (env-gated on both sides, never committed).

## The capsule

- **Tools** (declared in `Capsule.toml`, dispatched once upstream matures):
  `status`, `play {game?, bet?}`, `session {rounds?, game?, bet?}` + a CLI verb
  (`astrid capsule arcade …`).
- **Autonomy**: picks games/choices with its own entropy; the house's
  commitment lands *before* any of it, so neither side can steer outcomes.
- **Trustlessness**: re-derives the commit hash, the two-seed dice/wheel/plinko
  results and the jackpot roll from the reveal with a pure-TS SHA-256
  (self-tested against a known vector at install).
- **Lifecycle demo**: on install/upgrade the capsule walks onto the floor and
  plays a short verified session, reporting to the kernel log — that is the
  execution path proven on today's released kernels.

## Upstream findings (reported to the Astrid team)

Getting here surfaced three real issues in the published JS toolchain, all
documented with fixes/reproductions in
[`patches/UPSTREAM.md`](../capsules/arcade-player/patches/UPSTREAM.md) and
patched locally via [`patch-sdk.mjs`](../capsules/arcade-player/patch-sdk.mjs)
(npm postinstall):

1. **Decorator-registry timing bug** (sdk-js#20/#21, filed 2026-07-03): the
   runtime bridge reads the registry before any construction, so install/run/
   tool registrations look empty on stock 0.1.0.
2. **Stock JS capsules cannot install on kernels ≥ 0.9.1**: the published
   world imports `astrid:process/host@1.0.0`, which current lifecycle linkers
   no longer register. We drop the unused import (world + bridge stub) —
   that's what put this capsule on 0.9.4.
3. **sdk-js 0.1.0 predates subscribe-driven topic delivery**: with the CLI
   proxy capsule installed, the correct provider topic and `[subscribe]`
   manifest entry, the JS interceptor hook still never fires — JS capsules
   can't receive bus dispatch until sdk-js ships the current guest interface.

## Reproduce (WSL / Linux)

```bash
# 1. Build the component (any OS with Node >= 20)
cd capsules/arcade-player
npm install                 # postinstall applies the SDK patch
# One-time npm-layout aliasing (published build tool expects paths npm doesn't
# create; the alias MUST be a link, not a copy — see UPSTREAM.md finding 3):
#   node_modules/@unicity-astrid/astrid-sdk -> link/junction to ./sdk
#   node_modules/contracts                  -> copy of @unicity-astrid/contracts
npx astrid-js-build . --out target/arcade-player.wasm

# 2. Install on the kernel (Linux x86_64; astrid 0.9.0 release binary)
mkdir /tmp/arcade-player
cp Capsule.toml target/arcade-player.wasm /tmp/arcade-player/
astrid capsule install /tmp/arcade-player
# → watch the [floor] session play in the hook output

# 3. (optional) daemon mode
astrid start && astrid status   # capsule loads, run loop signals ready
```

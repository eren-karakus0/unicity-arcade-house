# Astrid OS integration — the `arcade-player` capsule

Unicity Arcade House ships an [Astrid OS](https://github.com/unicity-astrid/astrid)
capsule that plays the arcade **autonomously**: an agent on Astrid's WASM
microkernel betting real testnet UCT against our Sphere house agent — the
machine economy running on both sides, with every provably-fair reveal
re-verified *inside the sandbox* by the capsule's own SHA-256.

Source: [`capsules/arcade-player/`](../capsules/arcade-player/)

## What is proven end-to-end (verified 2026-07-02, log: `capsules/arcade-player/PROOF.log`)

| Step | Status |
|------|--------|
| TypeScript capsule → `wasm32-wasip2` component via `@unicity-astrid/build` (ComponentizeJS) | ✅ 13 MB component, 170 host imports |
| `astrid capsule install` on the real kernel (astrid 0.9.0, WSL Ubuntu 24.04) | ✅ installed, listed |
| Capability-gated egress (`net` allow-list → the arcade backend only) | ✅ HTTP works, nothing else reachable |
| **A real session from inside the Wasmtime sandbox**: welcome stake → 3 rounds (dice **win +2 UCT**, wheel lose, plinko push) → every reveal verified `fair=true` | ✅ see PROOF.log |
| The live arcade confirms it: leaderboard row `astrid-capsule 1W/1L/1T`, balance endpoint `{"balanceUct":5}` | ✅ independent, chain-side proof |
| `@run` daemon loop + `runtime.signalReady()` — kernel health checks green | ✅ |
| Bus-routed tool dispatch (`astrid capsule arcade play …`, MCP `tools/call`) | ⏳ blocked upstream (alpha) — see below |

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

Getting here surfaced a real bug in the published JS SDK 0.1.0: the runtime
bridge reads the decorator registry **before any construction**, while TC39
method-decorator initializers only run **at first construction** — so
install/run/tool registrations always look empty (silent no-op installs,
"run loop exited before signaling ready" restart storms, empty tool tables).
We patch it locally via [`patch-sdk.mjs`](../capsules/arcade-player/patch-sdk.mjs)
(npm postinstall); the full write-up ready for an upstream issue/PR lives in
[`patches/UPSTREAM.md`](../capsules/arcade-player/patches/UPSTREAM.md).
The remaining gap (bus-routed tool dispatch to JS capsules) sits behind the
same alpha surface and is documented there too.

## Reproduce (WSL / Linux)

```bash
# 1. Build the component (any OS with Node >= 20)
cd capsules/arcade-player
npm install                 # postinstall applies the SDK patch
npx astrid-js-build . --out target/arcade-player.wasm

# 2. Install on the kernel (Linux x86_64; astrid 0.9.0 release binary)
mkdir /tmp/arcade-player
cp Capsule.toml target/arcade-player.wasm /tmp/arcade-player/
astrid capsule install /tmp/arcade-player
# → watch the [floor] session play in the hook output

# 3. (optional) daemon mode
astrid start && astrid status   # capsule loads, run loop signals ready
```

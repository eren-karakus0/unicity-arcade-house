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
npx astrid-js-build . --out target/arcade-player.wasm

# 2. Install on the kernel (Linux x86_64; astrid 0.9.0 release binary)
mkdir /tmp/arcade-player
cp Capsule.toml target/arcade-player.wasm /tmp/arcade-player/
astrid capsule install /tmp/arcade-player
# → watch the [floor] session play in the hook output

# 3. (optional) daemon mode
astrid start && astrid status   # capsule loads, run loop signals ready
```

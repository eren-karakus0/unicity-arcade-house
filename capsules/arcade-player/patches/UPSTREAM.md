# Upstream bug report — @unicity-astrid/sdk 0.1.0 (sdk-js)

Filed upstream: [unicity-astrid/sdk-js#20](https://github.com/unicity-astrid/sdk-js/issues/20) (issue) and
[unicity-astrid/sdk-js#21](https://github.com/unicity-astrid/sdk-js/pull/21) (fix PR) — 2026-07-03.

> **Note on the two fixes.** [`patch-sdk.mjs`](../patch-sdk.mjs) patches the *published dist* with a
> minimal warm-up (construct once before the bridge reads) so this repo builds today. The upstream
> PR #21 uses a cleaner root-cause fix on the *source*: member decorators defer their registration
> onto a module-scoped queue and `@capsule` flushes it — no construction needed, and it also fixes
> the per-instance re-registration flagged in #18. Verified by compiling with the package's own tsc
> and reading the registry the way the bridge does (populated at decoration time, no construction),
> plus a full-package `tsc --noEmit`.

## Title

Runtime bridge reads the decorator registry before any construction — all
lifecycle/tool/run registrations appear empty on published 0.1.0

## Summary

The SDK registers `@tool` / `@interceptor` / `@command` / `@install` /
`@upgrade` / `@run` methods via TC39 `context.addInitializer(...)`. Per the
decorators proposal, initializers added by **non-static method decorators run
during instance construction** — i.e. only when `new CapsuleClass()` first
executes.

`createBridge()` in `runtime/bridge.js`, however, reads the registration maps
**before constructing anything**:

- `astridInstall()` checks `r.installMethod === undefined` → returns (the
  instance that would have populated it is only constructed *after* this
  check);
- `run()` checks `r.runMethod === undefined` → returns immediately, so the
  kernel sees "run loop exited before signaling ready" and health-restarts the
  capsule forever;
- `tool_describe` / hook dispatch see empty `tools` / `interceptors` /
  `commands` maps.

Net effect on a stock capsule built with the published 0.1.0 packages and run
on released kernels (verified on astrid 0.9.0/0.9.1, Ubuntu 24.04):
`@install` hooks silently no-op, `@run` loops never start, and bus-routed tool
dispatch never reaches the capsule. The class decorator (`@capsule`) *does*
register the constructor (it runs at class definition), which makes the
failure look like "the capsule is fine but empty".

## Reproduction

1. `npm i @unicity-astrid/sdk@0.1.0 @unicity-astrid/build@0.1.0`
2. Any capsule with `@install` that logs; build; `astrid capsule install .`
3. Observe: `Lifecycle hook completed successfully` in <2 ms with no guest log
   output. Add `@run` with `runtime.signalReady()`: observe
   `run loop exited before signaling ready` + health-restart loop.

## Fix that worked for us

Warm the registry with one throwaway construction before the first read, and
make duplicate records idempotent (the warm-up construction plus the real one
would otherwise trip the duplicate guards):

```js
// bridge.js — inside createBridge()
let warmed = false;
function reg() {
  const r = getRegistration();
  if (r !== undefined && !warmed) {
    warmed = true;
    try { new r.ctor(); } catch { /* state-free constructor */ }
  }
  // ... existing undefined check ...
}
```

```js
// registry.js — recordTool/recordInterceptor/recordCommand/recordInstall/
// recordUpgrade/recordRun: replace the duplicate-throw with an early return.
```

(Alternative cleaner fix: record method metadata from the *decorator call
itself* rather than `addInitializer`, since the method name and options are
already known at decoration time — construction would then not be needed at
all.)

With this patch applied, our capsule's `@install` hook executed a full
HTTP session inside the kernel sandbox and `@run` + `runtime.signalReady()`
kept the daemon healthy on astrid 0.9.0.

The exact patch we apply on top of the published package:
[`patch-sdk.mjs`](../patch-sdk.mjs) (npm postinstall).

## Environment

- @unicity-astrid/sdk 0.1.0, @unicity-astrid/build 0.1.0 (npm)
- astrid 0.9.0 / 0.9.1 release binaries, x86_64-unknown-linux-gnu
- Ubuntu 24.04 (WSL2), Node 22
- Capsule source: TypeScript, standard TC39 decorators
  (`experimentalDecorators: false`, target ES2022), built via
  `astrid-js-build` → ComponentizeJS → wasm32-wasip2

## Finding 2 (2026-07-12): stock JS capsules cannot install on kernels >= 0.9.1
### `astrid:process/host@1.0.0` gone from the lifecycle linker

Confirmed on astrid **0.9.1 and 0.9.4** release binaries: installing any
component built with the published JS packages fails with

```
lifecycle dispatch failed: Unsupported entry point: Failed to instantiate WASM
component for lifecycle: component imports instance `astrid:process/host@1.0.0`,
but a matching implementation was not found in the linker
```

The published `@unicity-astrid/build` 0.1.0 synthesizes a world importing
`astrid:process/host@1.0.0`, and the SDK bridge unconditionally imports the
specifier (esbuild keeps it — every JS capsule links every SDK module whether
used or not). Kernels >= 0.9.1 register `process@1.1.0` but no longer register
the 1.0.0 implementation in the lifecycle linker, so **every stock JS capsule
is uninstallable on current kernels**. (The binary still contains the
`astrid:process/host@1.0.0` string, so this may be an unintended registration
gap rather than a deliberate drop.)

**Fix that worked for us** (see `patch-sdk.mjs` section 3): drop the import on
both sides — stub `spawn`/`spawnBackground` in `sdk/dist/process.js`, and
remove `import astrid:process/host@1.0.0;` from the world template in
`build/src/index.mjs`. Our capsule never spawns processes (the SDK itself
documents `astrid:process` as optional per target). Component shrank
13.10 MB / 170 host imports → 12.30 MB / 142, and installs + runs verified
sessions on 0.9.4 (see ../PROOF.log sections [4]-[7]).

Suggested upstream fixes: re-register the 1.0.0 shim in the lifecycle linker,
or publish SDK/build packages targeting the current WITs, or make the build
tree-shake host domains the capsule does not use.

## Finding 3 (2026-07-12): JS SDK predates subscribe-driven topic delivery
### bus-routed CLI verb dispatch never reaches a JS capsule on 0.9.4

Setup that SHOULD work on astrid 0.9.4 (with Finding 2's patch applied):

- `astrid-capsule-cli` 0.2.0 (prebuilt `.capsule`) installed — CLI verbs now
  route through it, and its own manifest shows the current schema: topic
  delivery is declared via `[publish]` / `[subscribe]` tables.
- Provider-targeted run topic confirmed from capsule-cli source
  (astrid#891): `cli.v1.command.run.<provider-id>` — matches our
  `[[interceptor]] event = "cli.v1.command.run.arcade-player"`.
- Our manifest declares `[subscribe] "cli.v1.command.run.arcade-player"` and
  `[publish] "cli.v1.command.result.*"`.
- `@run` loop healthy (see below), entry `log.info` added as the first line of
  the interceptor handler.

Result: `astrid capsule arcade status` times out after 70 s and the entry log
**never appears** in the kernel log — the hook is never invoked. Meanwhile the
Rust-SDK capsule (astrid-capsule-cli) demonstrably receives subscribed topics
on the same kernel. Conclusion: the published JS SDK 0.1.0 predates the
subscribe-driven delivery interface — it implements lifecycle hooks and the
run loop (both work, PROOF.log), but not whatever guest export current kernels
call to deliver bus topics. JS capsules therefore cannot receive tools/CLI
dispatch until sdk-js ships that interface.

### Sub-observation: a returned `@run` is treated as a crash

An experiment returning from `@run` right after `runtime.signalReady()`
produced `Capsule health check failed ... reason=WASM run loop exited
unexpectedly` and a restart storm (5 attempts). The run loop must block
forever; worth documenting in the SDK docs (the naive "signal and return"
reading of the API is fatal).

## Environment (Findings 2-3)

- astrid 0.9.4 (also 0.9.1) release binaries, x86_64-unknown-linux-gnu, WSL2 Ubuntu 24.04
- @unicity-astrid/sdk 0.1.0 + build 0.1.0 (npm latest as of 2026-07-12), Node 22
- astrid-capsule-cli 0.2.0 (release asset `astrid-capsule-cli.capsule`)

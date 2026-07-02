# Upstream bug report — @unicity-astrid/sdk 0.1.0 (sdk-js)

Ready to file as an issue/PR against `unicity-astrid/sdk-js`.

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

## Related observation (separate, minor)

astrid 0.9.1 fails to pre-instantiate JS capsules with
`component imports instance astrid:process/host@1.0.0, but a matching
implementation was not found in the linker` — the JS bundle always links every
SDK module (esbuild keeps the side-effectful WIT imports), so kernels that
gate host interfaces on capabilities can no longer load stock JS capsules.
0.9.0 links it unconditionally and works.

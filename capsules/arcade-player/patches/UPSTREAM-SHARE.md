# Astrid OS — JS capsule findings (share-ready batch)

A batch of findings from building a real, non-trivial JavaScript capsule
(`arcade-player`: an LLM-driven bot league that plays a provably-fair arcade and
serves a for-hire oracle) against the published `@unicity-astrid/sdk` 0.1.0 on
released kernels. Each was reproduced end-to-end, has a root-cause hypothesis,
and ships with the fix/workaround we actually used.

**Ready to file as separate issues.** Copy each draft below into the matching repo.

| # | Title | Severity | Where to file | Status |
|---|-------|----------|---------------|--------|
| 1 | Decorator registry read before construction → all lifecycle/tool/run regs empty | Blocker | `astrid-runtime/sdk-js` | **Filed** — [#20](https://github.com/astrid-runtime/sdk-js/issues/20) / fix PR [#21](https://github.com/astrid-runtime/sdk-js/pull/21) |
| 2 | Stock JS capsules uninstallable on kernels ≥ 0.9.1 (`astrid:process/host@1.0.0` gone from linker) | Blocker | `astrid-runtime/sdk-js` | **Filed 2026-07-13** — [#23](https://github.com/astrid-runtime/sdk-js/issues/23) |
| 3 | JS SDK predates subscribe-driven topic delivery → capsule never receives tool/CLI dispatch | High | `astrid-runtime/sdk-js` | **Filed 2026-07-13** — [#25](https://github.com/astrid-runtime/sdk-js/issues/25) |
| 4 | `astrid:sys get-config` returns none to JS capsules for every key (incl. kernel builtins) | High | `astrid-runtime/sdk-js` | **Filed 2026-07-13** — [#24](https://github.com/astrid-runtime/sdk-js/issues/24) |
| A1 | `elliptic ^6.6.1` direct dep → low advisory inherited by downstreams | Low | `unicity-sphere/sphere-sdk` | **Filed 2026-07-13** — [#674](https://github.com/unicity-sphere/sphere-sdk/issues/674) |

> **Notes.** The `unicity-astrid/*` repos redirect to **`astrid-runtime/*`** (renamed org) — issues land there. `@unicitylabs/sphere-sdk` lives at **`unicity-sphere/sphere-sdk`**. Issues are filed by an external contributor, so **labels are applied by maintainers on triage** (we can't set them). **All four findings are now filed and open.** A1 was refined to note `elliptic` is a *direct* dependency of sphere-sdk 0.11.11 and that the SDK already ships `@noble/curves`, so it could migrate off `elliptic` entirely. **Optional next step:** the install-path fixes for #23/#25 (`patch-sdk.mjs`) can follow as PRs — issues first (done), PRs as a follow-up.

**Common environment** (unless a draft says otherwise): `@unicity-astrid/sdk`
0.1.0 + `@unicity-astrid/build` 0.1.0 (npm latest, 2026-07-12); astrid **0.9.4**
(also repro'd on 0.9.1 / 0.9.0 where noted), x86_64-unknown-linux-gnu, WSL2
Ubuntu 24.04, Node 22; capsule = TypeScript with standard TC39 decorators
(`experimentalDecorators: false`, ES2022) → `astrid-js-build` → ComponentizeJS →
wasm32-wasip2; CLI dispatch via `astrid-capsule-cli` 0.2.0.

A minimal reproducing probe capsule (`league-pinger`) and the full patch set
(`patch-sdk.mjs`) are available on request — offer to share the repo when you
file these.

---

## Issue 2 — Stock JS capsules cannot install on kernels ≥ 0.9.1

**Title:** Stock JS capsules uninstallable on kernels ≥ 0.9.1 — `astrid:process/host@1.0.0` missing from the lifecycle linker

**Severity:** Blocker (no JS capsule built with the published packages installs on a current kernel)

**Summary**

Installing any component built with the published JS packages fails on astrid
**0.9.1 and 0.9.4** with:

```
lifecycle dispatch failed: Unsupported entry point: Failed to instantiate WASM
component for lifecycle: component imports instance `astrid:process/host@1.0.0`,
but a matching implementation was not found in the linker
```

`@unicity-astrid/build` 0.1.0 synthesizes a world that imports
`astrid:process/host@1.0.0`, and the SDK bridge imports the specifier
unconditionally (esbuild keeps it — every JS capsule links every SDK module
whether used or not). Kernels ≥ 0.9.1 register `process@1.1.0` but no longer
register a `1.0.0` implementation in the lifecycle linker, so every stock JS
capsule is uninstallable. The `astrid:process/host@1.0.0` string is still
present in the binary, which suggests an unintended registration gap rather than
a deliberate removal.

**Reproduction**

1. `npm i @unicity-astrid/sdk@0.1.0 @unicity-astrid/build@0.1.0`
2. Build any capsule (even a no-op `@install` that logs).
3. `astrid capsule install .` → the error above.

**Impact**

The published JS SDK/build toolchain produces no installable artifact on
released kernels; JS capsule authors are blocked at step one.

**Workaround we used**

Drop the import on both sides — stub `spawn` / `spawnBackground` in
`sdk/dist/process.js`, and remove `import astrid:process/host@1.0.0;` from the
world template in `build/src/index.mjs`. Our capsule never spawns processes (the
SDK documents `astrid:process` as optional per target). The component shrank
13.10 MB / 170 host imports → 12.30 MB / 142 and then installed and ran verified
sessions on 0.9.4.

**Suggested upstream fix (any one)**

- Re-register the `1.0.0` shim in the lifecycle linker, or
- Publish SDK/build packages targeting the current WITs, or
- Make the build tree-shake host domains the capsule does not use.

---

## Issue 3 — JS SDK predates subscribe-driven topic delivery

**Title:** JS capsule never receives bus-routed tool/CLI dispatch on 0.9.4 — SDK predates the subscribe delivery interface

**Severity:** High (JS capsules can implement tools/CLI verbs but can never be invoked)

**Summary**

With Issue 2's patch applied, a JS capsule installs and its `@install` / `@run`
hooks run correctly — but bus-routed CLI-verb / tool dispatch never reaches it.

Setup that *should* work on 0.9.4:

- `astrid-capsule-cli` 0.2.0 installed (CLI verbs route through it; its manifest
  shows the current schema — topic delivery declared via `[publish]` /
  `[subscribe]` tables).
- Provider-targeted run topic confirmed from capsule-cli source:
  `cli.v1.command.run.<provider-id>`.
- Our manifest declares `[subscribe] "cli.v1.command.run.arcade-player"` and
  `[publish] "cli.v1.command.result.*"`; interceptor handler logs on its first
  line; `@run` loop healthy.

**Result:** `astrid capsule arcade status` times out after 70 s and the entry
log **never appears** — the hook is never invoked. The Rust-SDK capsule
(`astrid-capsule-cli`) demonstrably receives subscribed topics on the *same*
kernel. Conclusion: the published JS SDK 0.1.0 implements lifecycle hooks and
the run loop (both verified working) but not whatever guest export current
kernels call to deliver bus topics.

**Airtight confirmation (capsule-to-capsule probe)**

A dedicated probe capsule (`league-pinger`, `[publish] "arcade.v1.league.ping"`)
publishing to a topic our capsule subscribes to, both loaded in the same daemon:

- JS publish **works from the `@run` (runtime) instance** (kernel log confirms).
- JS publish **fails from lifecycle instances** — `[HostError] ipc.publish(...)`
  during install/upgrade (same lifecycle-instance capability gap as Issue 4).
- Delivery to the subscribed JS capsule **never happens** (0 of N pings), while
  the Rust capsule receives its subscribed topics on the same kernel.

**Impact**

JS capsules cannot expose tools or CLI verbs to the rest of the system until the
SDK ships the subscribe-delivery guest export — a large capability gap versus
Rust capsules.

**Two smaller items surfaced alongside (worth a docs note or separate issue)**

- *Fresh install doesn't build.* `npm i @unicity-astrid/{sdk,build}@0.1.0` does
  not build: the build tool resolves the SDK runtime at
  `node_modules/@unicity-astrid/astrid-sdk` and the canonical WIT at
  `node_modules/contracts/host`, neither of which npm creates. Required manual
  aliasing: link/junction `@unicity-astrid/astrid-sdk` → `@unicity-astrid/sdk`
  (**must be a link, not a copy** — a copy makes esbuild bundle two SDK
  instances and the decorator registry splits, yielding "No @capsule class
  registered"), and copy `@unicity-astrid/contracts` → `node_modules/contracts`.
- *A returned `@run` is treated as a crash.* Returning from `@run` right after
  `runtime.signalReady()` produces `WASM run loop exited unexpectedly` and a
  restart storm. The run loop must block forever; the naive "signal and return"
  reading of the API is fatal and should be documented.

---

## Issue 4 — `get-config` returns none to JS capsules for every key

**Title:** `astrid:sys get-config` returns none to JS capsules for every key, including kernel builtins (0.9.4)

**Severity:** High (JS capsules cannot read any configuration — env defaults, set values, or builtins)

**Summary**

On astrid 0.9.4, `env.tryGet(...)` (→ `astrid:sys/host@1.0.0 get-config`) returns
`none` for **every** key from a JS capsule, in BOTH the lifecycle and the runtime
(`@run`) instance:

- manifest `[env]` defaults (`GEMINI_API_KEY = { type = "string", default = "…" }`) → none
- values set via `astrid capsule config <name> --set KEY=VALUE` (stored at
  `~/.astrid/home/<principal>/.config/env/<name>.env.json`, confirmed with
  `--show`, capsule reloaded) → none
- the kernel's own injected builtin `ASTRID_SOCKET_PATH` (the SDK's documented
  `CONFIG_SOCKET_PATH` control) → none

Probe log: `[strategist] config probe (upgrade): GEMINI_API_KEY unset,
ASTRID_SOCKET_PATH unset`.

Because even the builtin `ASTRID_SOCKET_PATH` is missing, this points at the host
`get-config` binding for JS capsules rather than at secret semantics.

**Impact**

JS capsules cannot be configured at all through the documented surface —
including reading secrets or the socket path — which blocks any capsule that
needs a runtime key or endpoint.

**Schema notes discovered on the way (useful for docs)**

Manifest `[env]` values must be `EnvDef` structs — a bare string fails with
`expected struct EnvDef`, and `type` is required
(`{ type = "string" | "secret", default = "…" }` both pass `astrid capsule check`).

**Workaround we used**

Bake the key into the locally-built wasm at build time (gitignored output,
`target/` never committed), with runtime config tried first so a fixed
kernel/SDK takes over automatically.

---

## A1 — `elliptic` low advisory (different SDK: `@unicitylabs/sphere-sdk`)

Not an Astrid finding — surfaced by `pnpm audit --prod` on both of our projects,
which depend on the chain SDK. File on `unicitylabs/sphere-sdk`, not the Astrid
repos.

- **Advisory:** GHSA-848j-6mx2-7j84, `elliptic ≤ 6.6.1`, severity **LOW**
  ("risky cryptographic primitive implementation").
- **Path:** transitive — `@unicitylabs/sphere-sdk → elliptic`.
- **Ask:** bump `elliptic` in a Sphere SDK release. Downstreams can't fix it
  without an `overrides` pin (which we avoid, to keep the SDK's vetted version).
- **Repro:** `pnpm audit --prod` in a project that depends on the SDK
  (2026-07-13). No HIGH/CRITICAL advisories present.

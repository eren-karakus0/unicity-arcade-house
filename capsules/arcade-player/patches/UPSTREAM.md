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

### Addendum (2026-07-13): capsule-to-capsule probe makes it airtight

A dedicated probe capsule (`capsules/league-pinger`, Capsule.toml `[publish]
"arcade.v1.league.ping"`) publishing to a topic the arcade-player capsule
subscribes to, both loaded in the same daemon:

- **JS publish WORKS from the `@run` (runtime) instance** — kernel log:
  `[pinger] published arcade.v1.league.ping (daemon)`.
- **JS publish FAILS from lifecycle instances** — `[HostError]
  ipc.publish(...)` during install/upgrade hooks (same lifecycle-instance
  capability gap as finding 4).
- **Delivery to the subscribed JS capsule never happens** — the interceptor's
  entry log never appears (0 of N pings), while the Rust-SDK capsule-cli
  demonstrably receives its subscribed topics on the same kernel.

Also worth an SDK docs note (hit while building the probe): a fresh
`npm i @unicity-astrid/{sdk,build}@0.1.0` project does NOT build — the build
tool resolves the SDK runtime at `node_modules/@unicity-astrid/astrid-sdk`
and the canonical WIT at `node_modules/contracts/host`, neither of which npm
creates. Required manual aliasing: link/junction `@unicity-astrid/astrid-sdk`
→ `@unicity-astrid/sdk` (MUST be a link, not a copy — a copy makes esbuild
bundle two SDK instances and the decorator registry splits, yielding
"No @capsule class registered"), and copy `@unicity-astrid/contracts` →
`node_modules/contracts`.

### Sub-observation: a returned `@run` is treated as a crash

An experiment returning from `@run` right after `runtime.signalReady()`
produced `Capsule health check failed ... reason=WASM run loop exited
unexpectedly` and a restart storm (5 attempts). The run loop must block
forever; worth documenting in the SDK docs (the naive "signal and return"
reading of the API is fatal).

## Finding 4 (2026-07-13): the whole config surface returns none to JS capsules
### `astrid:sys get-config` sees nothing — not even kernel builtins

On astrid 0.9.4, `env.tryGet(...)` (→ `astrid:sys/host@1.0.0 get-config`)
returns `none` for **every** key from a JS capsule, in BOTH the lifecycle and
the runtime (`@run`) instance:

- manifest `[env]` defaults (`GEMINI_API_KEY = { type = "string", default = "…" }`) → none
- values set via `astrid capsule config <name> --set KEY=VALUE` (stored at
  `~/.astrid/home/<principal>/.config/env/<name>.env.json`, confirmed by
  `--show`, capsule reloaded) → none
- the kernel's own injected builtin `ASTRID_SOCKET_PATH` (the SDK's documented
  `CONFIG_SOCKET_PATH` control) → none

Probe log (also in ../PROOF.log): `[strategist] config probe (upgrade):
GEMINI_API_KEY unset, ASTRID_SOCKET_PATH unset`.

Schema notes discovered on the way (useful for docs): manifest `[env]` values
must be `EnvDef` structs — a bare string fails with `expected struct EnvDef`,
and `type` is required (`{ type = "string" | "secret", default = "…" }` both
pass `astrid capsule check`). `type = "secret"` presumably keeps the value in
the SecretStore by design ("the value never leaves the SecretStore",
sdk elicit.js), but `type = "string"` not arriving either — and the builtin
socket path missing — points at the host get-config binding for JS capsules,
not at secret semantics.

**Workaround used here:** the strategist's key is baked into the locally-built
wasm at build time (`gen-local-key.mjs`, gitignored output, `target/` never
committed) with runtime config tried first, so a fixed kernel/SDK takes over
automatically.

## Environment (Findings 2-4)

- astrid 0.9.4 (also 0.9.1) release binaries, x86_64-unknown-linux-gnu, WSL2 Ubuntu 24.04
- @unicity-astrid/sdk 0.1.0 + build 0.1.0 (npm latest as of 2026-07-12), Node 22
- astrid-capsule-cli 0.2.0 (release asset `astrid-capsule-cli.capsule`)

---

# Appendix — dependency advisory (separate upstream: @unicitylabs/sphere-sdk)

Not an Astrid/sdk-js bug, but surfaced by `pnpm audit --prod` and worth flagging
to the Unicity team since it ships with the chain SDK both projects depend on.

**Finding A1 — `elliptic ≤ 6.6.1` (GHSA-848j-6mx2-7j84, severity: LOW).** Pulled
in transitively: `@unicitylabs/sphere-sdk → elliptic`. Advisory is "risky
cryptographic primitive implementation". It is a transitive dependency, not a
direct one, so it cannot be resolved in these repos without a Sphere SDK release
that bumps `elliptic` (or an npm `overrides` pin, which we deliberately avoid so
the SDK's own vetted version is used). No HIGH/CRITICAL advisories in either
project. Reproduce: `pnpm audit --prod` in either repo root (2026-07-13).

## Finding A2 (2026-08-09) — a wallet reports a large confirmed balance while every send is refused for insufficient balance

**Upstream:** `@unicitylabs/sphere-sdk` (observed on 0.12.0 **and** 0.14.3 — the
upgrade neither caused nor fixed it). **Severity: high** — the wallet holds a
balance it cannot spend, so a live service cannot pay anyone.

**Filed:** [unicity-sphere/sphere-sdk#737](https://github.com/unicity-sphere/sphere-sdk/issues/737) — 2026-08-10.

### Symptom

The house wallet of a running arcade backend (hosted, long-lived, testnet2 via
the wallet-api rail) reports a healthy confirmed balance, but **every** transfer
fails:

```
payments.assets()  ->  UCT confirmedAmount ≈ 1,009,629 UCT
payments.send({ coinId: <UCT>, amount: '15', recipient: <0x02… chain pubkey> })
  -> SphereError: Insufficient balance for this transaction  (SEND_INSUFFICIENT_BALANCE)
```

It is not a transient race: 90+ consecutive sends over ~20 minutes, serialized
(one in flight at a time), all refused. It has persisted for days across many
restarts, and survived the 0.12.0 → 0.14.3 upgrade.

### What we ruled out

- **Not concurrency.** Sends are serialized behind a promise chain; the log shows
  strict send → fail → send → fail alternation, never overlap.
- **Not the recipients.** These are ordinary `02…`/`03…` chain pubkeys. A separate,
  clearly different error (`no published chain pubkey`) is what unresolvable
  recipients produce, and those are excluded here.
- **Not an empty wallet.** `assets()` reports ~1M UCT confirmed, and minting adds
  to it — the confirmed figure rises by exactly the minted amount each time.
- **Not a failed mint.** `mint()` resolves with `success !== false` and the
  confirmed balance rises, so fresh tokens really do land.
- **Not the amounts.** Sends are 6–25 UCT against a ~1M balance.

### Very likely cause: certifications stopped confirming on 2026-08-05

Both symptoms start on the same day and have not stopped since:

```
Aug 05 22:08:34  Split mint failed: certification unconfirmed — the source spend
                 may be on-chain; keep the intent open and resume under the same transferId
Aug 05 22:10:07  Split burn failed: certification unconfirmed — …
```

66 such failures on the arcade wallet, 16 more on a second, independent wallet
(a different service, its own identity) — so it is not one wallet's state.

The SDK's documented response to `CERTIFICATION_UNCONFIRMED` is to **keep the
intent open** and resume it later under the same `transferId` — correct for
money-safety. But if certification keeps failing, those intents never close, and
each one holds its source token. Over days the whole inventory ends up
reserved, which is precisely what `freeView()` then reports as nothing free,
while `assets()` still counts the tokens as confirmed holdings.

**A fresh wallet does not escape it.** We provisioned a brand-new identity with
an empty inventory: its very first `mint()` failed with
`Mint certification failed: certification unconfirmed`, and its sends failed the
same way. So the condition is upstream of any wallet's local state.

### Where it appears to come from

`SpendQueue.plan()` (`modules/payments-v2/select/queue.ts`) rejects when
`freeTotal + expectedChangeTotal < amount`, and `freeView()` counts a token only
when it is *entirely* unreserved:

```js
if (this.deps.ledger.getFreeAmount(entry.tokenId, entry.amount) === entry.amount) { … }
```

So the refusal is consistent with every token in the pool being (at least
partly) held by the ledger, while `assets()` — which reports confirmed holdings
— still counts them. **Freshly minted tokens do not restore spendability
either**, which is the part we cannot explain: a newly minted token should be
unreserved by construction, yet sends immediately after a successful mint are
refused identically.

### What would help

1. A public way to see *spendable* balance and what holds the rest — today
   `assets()` is the only balance surface, and it cannot distinguish "rich" from
   "able to pay". `pendingTransfers()` hints at shortfalls but does not attribute
   reservations to tokens.
2. If this is stuck/open intents holding the inventory, a supported way to
   observe and release them. The docs state open intents resume when the vertical
   starts; here restarts do not clear the condition.
3. Failing that, a clearer error: `SEND_INSUFFICIENT_BALANCE` reads as "you are
   broke", which sent us looking at the treasury for days when the balance was
   never the problem. "No spendable tokens — N held by open intents" would have
   pointed straight at it.
4. Most of all: whatever stopped confirming certifications on testnet2 around
   2026-08-05. Everything above is downstream of that.

### Environment

- `@unicitylabs/sphere-sdk` 0.14.3 (and previously 0.12.0), Node 20, tsx, Oracle Linux 9
- testnet2 via `https://wallet-api.unicity.network`, long-lived process (weeks)
- Wallet has a high transaction count: ~30,000 rounds played, ~13.3M UCT paid out,
  ~12.3M UCT self-minted over its lifetime

---

Both monorepos otherwise pass a full quality + security pass on 2026-07-13:
sphere-agent-bazaar 112/112 core tests, unicity-agent-bazaar 158/158 tests,
lint + typecheck clean, no committed secrets (`.env` gitignored in both).

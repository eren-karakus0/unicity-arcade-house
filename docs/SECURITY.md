# Security

Sphere Agent Bazaar runs **autonomous agents that hold a wallet and move value**
on their own. That makes a few threat classes first-order concerns, so we treat
security as part of the design rather than an afterthought.

## Current posture (M1)

- **No secrets in the repository.** `.env` and `data/` (wallets, mnemonics,
  tokens) are gitignored. `.env.example` contains only the **public** testnet2
  gateway key, which the SDK documents as non-secret.
- **No dangerous sinks.** The first-party code contains no `eval`, `new Function`,
  `child_process`, or shell execution.
- **Safe money math.** All amounts are handled as smallest-unit strings / `BigInt`
  (via `parseTokenAmount` / `toHumanReadable`) — never JS floats.
- **Isolated identities.** Each agent uses its own wallet data directory and
  `deviceId`.
- **Audit posture.** `pnpm audit` reports advisories in two places, neither of
  which is reachable by the running agents:
  - **Dev-tooling only:** the critical/high/moderate advisories all sit under the
    `vitest → vite → esbuild` chain (test-runner UI server, vite/esbuild dev
    servers). We run tests headless (`vitest run`) and never start those servers,
    and none of this ships in the agent runtime. Forcing the patched majors broke
    the test suite (vitest 4 / vite peer mismatch), so we keep the working pinned
    versions rather than degrade the suite for a non-reachable advisory.
  - **Upstream (low):** `elliptic`, a transitive dependency of
    `@unicitylabs/sphere-sdk`, with no patched version published — outside our
    control, tracked for the SDK to fix.
- **Operational note:** a freshly generated mnemonic is printed once to the
  console so the operator can save it. Console logs are gitignored (`*.log`); do
  not ship raw agent logs to a public sink.

## Economy hardening — implemented in M2

The threats where untrusted input meets value transfer are handled in code:

1. **Untrusted `repoUrl` → SSRF guard ✅.** The analyst validates every `repoUrl`
   with `parseRepoUrl` **before any network call and before billing** — the host
   is allowlisted to `github.com` and the `owner/repo` path is strictly checked
   (internal IPs / other hosts / non-http schemes are rejected). Covered by unit
   tests, including the `169.254.169.254` metadata-endpoint case.
2. **Treasury safety ✅.** AlphaScout's `tryPay` enforces a hard **total budget
   cap** and a **max price per job**, pays **idempotently** (a request id is paid
   at most once), and settles **only against jobs it initiated this session**
   (quote for one of its own `jobId`s) — so unsolicited or stale bills are never
   paid. The cap check uses the **actual bill amount**, not the quoted price.
3. **Message validation ✅ (baseline).** Inbound DMs are parsed by
   `parseBazaarMessage` (kind discriminator) and the handlers re-check the service
   id and required fields before acting; the analyst bills only after the repoUrl
   validates.
4. **LLM prompt-injection containment ✅.** Repo-controlled text flows into the
   summarizer prompt, but the model output is used **only** as summary prose — it
   never drives payments, swaps, or control flow.

### Residual hardening (tracked for M3)

- Verify `replyTo` matches the DM sender before billing (anti-spoofing).
- Expire/evict stale entries from the analyst's `pending` and AlphaScout's
  `quotes`/`bills` maps for long-running services.
- Per-sender rate limiting on job-requests (cheap-spam mitigation).

## Reporting

This is a testnet hackathon project. For anything sensitive, open a private
report rather than a public issue.

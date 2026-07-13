# Unicity Arcade House — Roadmap

Two tracks, executed tier by tier (a tier ships fully — tests, deploy, live
verification — before the next one starts). Later tiers may be re-scoped as
earlier ones land; anything conditional is marked honestly.

## Part 1 — Astrid OS depth

The [`arcade-player` capsule](./ASTRID.md) already plays the arcade autonomously
from inside Astrid's WASM sandbox, re-verifying every provably-fair reveal with
its own SHA-256. This track polishes it, upgrades it, and makes it visible.

- [x] **P1.T0 — Polish + kernel 0.9.4 + web showcase** *(shipped 2026-07-12)*
  Repo lint fully clean · capsule re-proved live on astrid **0.9.4** (stale
  `astrid:process` import dropped — see UPSTREAM.md finding 2 — PROOF.log
  refreshed with verified in-sandbox sessions) · **Autonomous Players** panel
  live on the arcade page, backed by `GET /api/arcade/astrid` (real traces
  only). Bus-routed dispatch remains upstream-blocked with a precise root
  cause (sdk-js predates subscribe-driven delivery — UPSTREAM.md finding 3).
- [x] **P1.T1 — LLM strategist** *(shipped 2026-07-13)*
  The capsule now *reasons* about game/bet/stop over capability-gated HTTP to
  Gemini — kernel-log sessions show per-round reasoning referencing the
  session's own history, bets clamped in code, every reveal still verified
  `fair=true` (PROOF.log). Key rides in the locally-built wasm because the
  kernel's config surface returns none to JS capsules (UPSTREAM.md finding 4);
  runtime config is tried first so a fixed kernel takes over automatically.
- [x] **P1.T2 — Multi-capsule composition → bot league** *(shipped 2026-07-13)*
  Cross-capsule IPC is upstream-blocked and now precisely proved by a probe
  capsule (`league-pinger`: JS publish works from `@run`, delivery to a
  subscribed JS capsule never fires — UPSTREAM.md finding 3 addendum). Pivoted
  to the **bot league**: three strategist personas (balanced / aggressive /
  cautious), each with its own arcade identity, LLM risk appetite and
  leaderboard row; live standings on the arcade page.
- [ ] **P1.T3 — Bazaar bridge (capsule delivery channel)**
  List an Astrid-hosted agent on Unicity Agent Bazaar via the `capsule`
  channel and prove one end-to-end hire — Arcade + Bazaar + Astrid OS in a
  single machine-economy story.

## Part 2 — Arcade level-up

Benchmarked against today's provably-fair leaders (crash/mines/limbo, seed
verification, VIP/races, live feeds).

- [ ] **P2.T1 — Live-arcade feel**: Limbo · single-player Crash (committed
  crash point, claim model) · one-shot Mines · a public live win/deposit
  ticker.
- [ ] **P2.T2 — Trust layer**: player-editable client seeds · a `/verify`
  page that recomputes any past round in the browser · a Fairness & Solvency
  page (per-game RTP + live treasury).
- [ ] **P2.T3 — Retention**: XP/levels with log-scaled progress · tiered
  rakeback · prize-ladder races (60/25/15) on the durable payout rail ·
  auto-bet.
- [ ] **P2.T4 — Unicity moat**: one unified Autonomous Players showcase
  (Astrid bots + the Bazaar patron) · stretch: async PvP duels, on-chain
  badges.
- [ ] **P2.T5 — Table games**: a multi-step round engine (same commit-reveal
  guarantees) · **Blackjack vs the house** first · poker vs bots as stretch.
  *Live multiplayer tables are explicitly conditional on an always-on host —
  not promised on the current free tier.*

## Working protocol

Each tier: mini-plan → build → tests green → conventional commit → deploy →
**live verification** → check the box here. Testnet2 only; secrets live only
in host env vars; persistent state stays bounded.

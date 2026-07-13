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
- [x] **P1.T3 — Bazaar bridge (capsule delivery channel)** *(shipped 2026-07-13)*
  The first real `kind: 'capsule'` listing on Agent Bazaar ("Arcade Oracle"):
  funded jobs park in a CapsuleHub mailbox, the sandboxed capsule polls, does
  the work for real (a verified provably-fair round at the live arcade) and
  posts the result; offline capsule → honest refund; poll recency → verified
  badge. **Proven end-to-end**: the autonomous patron hired it and escrow
  released on-chain — Bazaar → Astrid OS → Arcade in one autonomous chain
  (PROOF.log BAZAAR BRIDGE, three independent witnesses).

## Part 2 — Arcade level-up

Benchmarked against today's provably-fair leaders (crash/mines/limbo, seed
verification, VIP/races, live feeds).

- [x] **P2.T1 — Live-arcade feel** *(shipped 2026-07-13)*: **Limbo** and
  **Crash** (target vs sealed multiplier on a flat-96%-RTP curve, two-seed
  fair) and one-shot **Mines** (5 sealed mines on 5×5, brackets up to ×8.39,
  layout reproducible from the reveal) — all browser-verifiable, wired into
  the existing fairness check; the live-payouts ticker now carries notable
  chip wins too. 10 games in the hall; smoke-verified live (real limbo +
  mines rounds judged correctly on deploy).
- [x] **P2.T2 — Trust layer** *(shipped 2026-07-13)*: the fairness verifier
  now covers all 10 games with step-by-step math (Limbo/Crash curve, Mines
  Fisher–Yates re-run) · persistent player-editable client seed (save/rotate,
  feeds every two-seed round) · **Provably solvent** — live house-wallet
  panel (treasury, on-chain payouts, rounds, jackpot) beside the odds table.
  Bonus: clean URLs — `/fairness`, `/profile` (no `#`), SPA rewrite + legacy
  hash-link upgrade.
- [x] **P2.T3 — Retention** *(shipped 2026-07-13)*: XP on every round
  (log-scaled — uncapped bets can't buy the ladder) across five tiers
  Bronze→Diamond · tiered rakeback (2–10% of lost bets back, milli-chip
  accrual) with one-time level-up bonuses · podium races — the tournament
  pool now splits 60/25/15 across the top three on the durable payout rail ·
  auto-bet (×5/×10/×25, cooldown-paced, self-stopping) · tier card + XP bar
  on the profile. Smoke-verified live (xpGained math exact on a real round).
- [x] **P2.T4 — Unicity moat** *(shipped 2026-07-13)*: one unified Autonomous
  Players showcase — the Astrid bot league now includes the ⛓ **for-hire
  oracle** (plays only when the Bazaar's autonomous patron pays it through
  on-chain escrow), with cross-links both ways (arcade → `/machine`, bazaar →
  the arcade). *Deliberately deferred*: async PvP duels and on-chain
  achievement badges — real features, but blackjack (P2.T5) is the higher-
  value next build; both stay on the future list rather than shipping thin.
- [x] **P2.T5 — Table games** *(shipped 2026-07-13)*: the multi-step table
  engine landed — staked hands, TTL-refunded when abandoned, persisted across
  restarts, settling through the same single pipeline as every one-shot game —
  and **Blackjack vs the house** is live on it (S17, naturals 3:2, double;
  the whole shoe committed before the first card and verified card-by-card in
  the browser). *Still deferred by design*: poker vs bots (stretch), and live
  multiplayer tables remain conditional on an always-on host.

**Both tracks complete.** Future list: poker vs bots · async PvP duels ·
on-chain badges · live multiplayer tables (always-on host) · real-Arcade
`ARCADE_SERVICE_URL` routing.

## Working protocol

Each tier: mini-plan → build → tests green → conventional commit → deploy →
**live verification** → check the box here. Testnet2 only; secrets live only
in host env vars; persistent state stays bounded.

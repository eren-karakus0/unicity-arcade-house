# Sphere Agent Bazaar

> An on-network **agent service marketplace** on Unicity — autonomous AI agents
> that discover, hire, and pay each other peer-to-peer, with no human in the
> loop for each transaction.

Built on the [Sphere SDK](https://github.com/unicity-sphere/sphere-sdk) for the
Unicity **"Build the machine economy"** builder campaign.

**Submission track:** Autonomous agents · **Runs on:** Unicity testnet2

---

## The idea

The internet is being rebuilt for AI. Billions of agents will need to find each
other, agree terms, and settle — at machine speed. Sphere Agent Bazaar is a small
but complete demonstration of exactly that: a **two-sided agent economy** where

- a **provider** agent advertises a real service on the network and gets paid for
  delivering it, and
- a **client** agent autonomously discovers that service, hires it, pays for it,
  and consumes the result — driven by its own budget and goals, on a loop.

The flagship demo is a **crypto repo-risk economy**:

```
  AlphaScout (client / treasury)                 Repo Risk Analyst (provider)
  ──────────────────────────────                 ────────────────────────────
  picks a repo from its watchlist
        │
        │  1. market.search("repo risk analysis")  ───────────►  posts a `service`
        │                                                         intent to the market
        │  2. DM: job-request { repoUrl }          ───────────►
        │                                          ◄───────────  3. payment-request (price)
        │  4. pays the request (UCT)               ───────────►
        │                                                         5. analyzes the repo
        │                                                            (GitHub + OSV.dev, free)
        │  6. DM: job-result { riskReport }        ◄───────────
        ▼
  aggregates into a report for the user
```

Money actually moves between the two agents on every job. No human clicks
"send" — AlphaScout decides when to act, finds its counterparty through the
market, and settles programmatically.

## Why it fits the network

Depth over breadth — the build uses the Sphere primitives the way they are meant
to be used, not a wallet bolted onto a chat bot:

| Primitive | Used for |
|-----------|----------|
| **nametag** | each agent's on-network identity (`@bzr-analyst`, `@bzr-scout`) |
| **market (intents)** | the provider advertises; the client discovers via semantic search |
| **DM (Nostr)** | job negotiation and result delivery |
| **payment requests** | the provider bills the client for a job |
| **payments (mint/send/receive)** | treasury funding and settlement |
| **swap (escrow)** | *(stretch)* trustless report-token ⇄ payment settlement |

## Monorepo layout

```
sphere-agent-bazaar/
├── packages/
│   ├── bazaar-core/        # shared library: Sphere v2 wiring, marketplace
│   │                       #   protocol types, pluggable LLM summarizer
│   ├── analyst-agent/      # provider: Repo Risk Analyst
│   └── alphascout-agent/   # client: autonomous treasury that hires the analyst
└── (dashboard/ — live economy visualizer, lands in a later milestone)
```

`@bazaar/core` wraps a single Sphere wallet (`SphereAgent`) and does the two-step
v2 provider wiring — base providers **plus** the wallet-api rails, the step that
silently disables transfers if skipped.

## Getting started

Requirements: Node ≥ 20, pnpm ≥ 10.

```bash
pnpm install
cp .env.example .env        # the testnet2 key is public; mnemonics auto-generate
```

### Verify the wiring (end-to-end)

The smoke test stands up two agents, self-mints UCT on one, and transfers value
to the other — proving the full testnet2 path works on your machine:

```bash
pnpm smoke
```

Expected tail:

```
[smoke] analyst balance after mint: 10 UCT
[smoke] transfer ... status=completed
[smoke] scout   balance: 3 UCT
[smoke] ✅ E2E TRANSFER SUCCESS — v2 wiring confirmed.
```

### Run the agents

```bash
pnpm analyst       # start the provider (Repo Risk Analyst)
pnpm alphascout    # start the client (AlphaScout)
```

## Configuration

All config lives in `.env` (see `.env.example`). Notable values:

- `SPHERE_ORACLE_API_KEY` — the **public** testnet2 gateway key (not a secret).
- `ANALYST_MNEMONIC` / `ALPHASCOUT_MNEMONIC` — leave empty to auto-generate;
  paste back to keep stable identities. **Never commit a real mnemonic.**
- `GEMINI_API_KEY` — *optional*; the report summarizer falls back to a
  deterministic template when absent, so the agents run with zero external cost.

## Status

- [x] **M1 — foundation:** monorepo, `SphereAgent` v2 wiring, identities, self-mint,
      end-to-end transfer verified on testnet2.
- [x] **M2 — economy:** provider service loop (SSRF-guarded GitHub risk scoring),
      market `service` intents, semantic discovery, DM job protocol, payment-request
      settlement, and AlphaScout's autonomous hire loop with hard treasury caps.
      **Verified live on testnet2:** AlphaScout discovers `@analyst-knkchn` on the
      market, hires it for two repos, pays the bills itself, and receives the
      reports — money moving between two agents with no human in the loop.
- [ ] **M3 — polish:** live dashboard, deploy, `sphere-apps` listing, more risk signals (OSV.dev CVEs).
- [ ] **M4 — stretch:** escrow-swap settlement, AstridOS runtime, Gemini summaries.

## License

[MIT](./LICENSE) © eren-karakus0

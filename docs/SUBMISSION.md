# Builder Campaign Submission

Everything needed to submit **Sphere Agent Bazaar** to the Unicity
"Build the machine economy" builder call.

## Quick facts

| Field | Value |
|-------|-------|
| **Project** | Sphere Agent Bazaar |
| **Track** | Autonomous agents |
| **Repository** | https://github.com/eren-karakus0/unicity-arcade-house |
| **Live app** | https://unicity-arcade-house.vercel.app/ |
| **Network** | Unicity testnet2 |
| **Agentic?** | **Yes** |
| **Runs on AstridOS?** | No (planned, M4) |

## One-paragraph description

Sphere Agent Bazaar is an on-network **agent service marketplace**. A budgeted
treasury agent, **AlphaScout**, discovers a **Repo Risk Analyst** provider on the
Unicity market, hires it to score the maintenance & security risk of GitHub repos
(including a real dependency-CVE scan via OSV.dev), pays per job via on-chain
payment requests, and collects the reports — with no
human approving individual transactions. Value moves between two autonomous agents
peer-to-peer; a live control-room dashboard streams the whole economy.

## Why it is agentic

AlphaScout runs as an autonomous loop: it **decides when to act**, **finds its
counterparty through the market** (semantic intent search), and **executes payment
and settlement programmatically** — paying provider invoices within hard treasury
caps (total budget + max-per-job), idempotently, only for jobs it initiated. A
human sets goals and limits (the watchlist and budget); the agent acts within them
on its own. The Analyst likewise runs as a service: it advertises, bills, analyzes,
and delivers without human intervention.

## Depth of SDK use

| Primitive | Where |
|-----------|-------|
| **nametag** | each agent's on-network identity (`@analyst-knkchn`, `@alphascout-knkchn`) |
| **market (intents)** | provider posts a `service` intent; client discovers via semantic search |
| **DM (Nostr)** | job negotiation and report delivery |
| **payment requests** | provider bills the client per job |
| **payments (mint/send/receive)** | treasury funding and settlement |
| **swap (escrow)** | available; trustless settlement is the M4 stretch |

## How to run against testnet2

```bash
pnpm install
cp .env.example .env          # public testnet2 key; mnemonics auto-generate
pnpm analyst                  # terminal 1: the provider service
pnpm alphascout               # terminal 2: the autonomous client
# optional live dashboard:
pnpm dashboard:build && pnpm dashboard   # http://localhost:4317
```

The deployed dashboard replays a recorded testnet2 run so the public URL is
populated without the agents running.

## Eligibility checklist

- [x] Code public in a readable, runnable repository
- [x] App live on a publicly viewable location
- [x] README with description, chosen track, and run instructions against testnet2
- [x] States whether it is agentic (yes) and AstridOS (no)
- [ ] Shipped within the campaign window — submit before the deadline
- [ ] Submitted through the developer portal (https://developers.unicity.network/)

## sphere-apps directory entry

To list in the Sphere desktop, open a PR to
[`unicity-sphere/sphere-apps`](https://github.com/unicity-sphere/sphere-apps)
adding this to `apps.json`:

```json
{
  "category": "dev",
  "name": "Sphere Agent Bazaar",
  "description": "Autonomous agents that discover, hire, and pay each other for repo-risk analysis",
  "url": "https://unicity-arcade-house.vercel.app/",
  "icon": "https://unicity-arcade-house.vercel.app/icon.svg"
}
```

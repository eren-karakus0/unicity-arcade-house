# Builder Campaign Submission

Everything needed to submit **Unicity Arcade House** to the Unicity
"Build the machine economy" builder call.

## Quick facts

| Field | Value |
|-------|-------|
| **Project** | Unicity Arcade House |
| **Track** | Autonomous agents |
| **Repository** | https://github.com/eren-karakus0/unicity-arcade-house |
| **Live app** | https://unicity-arcade-house.vercel.app/ |
| **Network** | Unicity testnet2 |
| **Agentic?** | **Yes** |
| **Runs on AstridOS?** | **Yes** — an autonomous player capsule, proven on kernel v0.9.0 ([docs/ASTRID.md](ASTRID.md)) |

## One-paragraph description

Unicity Arcade House is a hall of seven **provably-fair games** played for
**real testnet UCT** against an **autonomous house** — a Sphere agent on
testnet2. Your wallet is your login; you buy in with a wallet-approved Sphere
Connect transfer (the house detects the incoming payment and credits you),
bet any amount across rock-paper-scissors, lucky wheel, plinko, dice duel,
coin flip, high-low and lucky number, and withdraw on-chain any time — the
agent sends the transfer itself, no human in the loop. Every round commits
`sha256(secret : nonce)` before you act and the browser re-verifies the
reveal; a progressive jackpot (also verifiable) can hit on any bet. An
**Astrid OS capsule** plays the same floor autonomously — agents betting
against agents.

## Why it is agentic

The house is a fully autonomous agent. On its own it **deals** each round
(picking and committing a hidden value), **judges** the outcome, **funds its own
treasury** (self-minting UCT when low), and **settles winnings on-chain** —
sending real testnet UCT to the winner's address with no human approving any
individual payout. The player only supplies their move; every economic action on
the house side is agent-initiated and verifiable.

## Depth of SDK use

Everything on-chain goes through `@unicitylabs/sphere-sdk` — **no other
web3 library is used anywhere in the repo**.

| Primitive | Where |
|-----------|-------|
| **nametag** | the house's on-network identity |
| **wallet connect** | player login + deposit approval (Sphere Connect `send` intent — the wallet's own UI signs) |
| **payments — mint** | the house self-funds its prize treasury |
| **payments — send** | withdrawals + jackpot payouts, settled by the agent (transfer id + delivery state in the UI) |
| **payments — history** | crediting incoming deposits by sender pubkey/nametag |

The house is built on the same autonomous-agent infrastructure as the rest of
the repo (`@bazaar/core` wraps a single Sphere v2 wallet with the two-step
provider wiring), so market/DM/swap are available under the hood for future
agent-to-agent features.

## Provably fair

```
1. deal   → house picks a secret, returns sha256(secret : nonce)   (commitment)
2. play   → the player makes a choice
3. reveal → house reveals secret + nonce; the browser re-hashes and checks it
```

**Dice Duel** uses a two-seed RNG (committed house seed + player-supplied client
seed) so neither side can steer the roll; the browser re-derives both dice.

## How to run against testnet2

```bash
pnpm install
pnpm -r test                 # game-logic unit tests (provably-fair + engagement)
pnpm backend                 # the house agent + /api/arcade (needs a testnet mnemonic in .env)
pnpm dashboard:dev           # the web app (set VITE_BACKEND_URL to reach the backend)
```

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
  "category": "games",
  "name": "Unicity Arcade House",
  "description": "Provably-fair games vs an autonomous house agent — win real testnet UCT on-chain",
  "url": "https://unicity-arcade-house.vercel.app/",
  "icon": "https://unicity-arcade-house.vercel.app/icon.svg"
}
```

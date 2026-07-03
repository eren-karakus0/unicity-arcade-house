# Unicity Arcade House

> A hall of **provably-fair games** played against an **autonomous house** on
> Unicity. Beat the house and it pays you real testnet UCT **on-chain** —
> automatically, with no human in the loop.

Built on the [Sphere SDK](https://github.com/unicity-sphere/sphere-sdk) for the
Unicity **"Build the machine economy"** builder campaign.

**Track:** Autonomous agents · **Runs on:** Unicity testnet2

**🔴 Live:** **https://unicity-arcade-house.vercel.app/**

[![CI](https://github.com/eren-karakus0/unicity-arcade-house/actions/workflows/ci.yml/badge.svg)](https://github.com/eren-karakus0/unicity-arcade-house/actions/workflows/ci.yml)

---

## The idea

Most "machine economy" demos are impressive but have zero everyday users. The
Arcade House flips that: a simple, sticky product **anyone** can use — while
still being a genuine showcase of Unicity's core primitives (identity + payments
+ an autonomous agent).

You connect your Unicity wallet (that's your login), pick a game, and play
against **the house — an autonomous Sphere agent**. When you win, the house
agent sends you real testnet UCT on-chain by itself. No human presses "pay".

### Provably fair

Every game commits to its hidden value **before** you act:

```
1. deal   →  house picks a secret, sends you sha256(secret : nonce)   (the "commitment")
2. play   →  you make your choice
3. reveal →  house reveals secret + nonce; your browser re-hashes it and
             checks it matches the commitment — so the house could not have
             changed its move after seeing yours
```

**Dice Duel** goes further with a two-seed RNG: the house commits a server seed,
your browser contributes a client seed, and both dice derive from the hash of the
two — so neither side can steer the roll. The browser re-derives it to verify.

### The games

| Game | You do | Win pays |
|------|--------|----------|
| **Rock · Paper · Scissors** | beat the sealed move | 1× |
| **Dice Duel** | higher roll wins (two-seed fair) | 1× |
| **Coin Flip** | call the sealed coin | 1× |
| **High · Low** | is the next card higher or lower? | 1× |
| **Lucky Number** | guess the sealed number 1–6 | **5×** |

On a win the house pays out from its treasury; the UI shows the real on-chain
transfer id and its delivery state.

### Keep playing — progression, a live tournament, and referrals

- **Achievements** — ten badges (first win, streak milestones, play-all-games,
  high roller, jackpot, …); several grant a small UCT bonus on unlock.
- **Rolling tournament** — a recurring window where players race on net UCT won.
  When it closes the house **crowns the top scorer and pays a prize on-chain,
  autonomously** — no operator crowns anyone.
- **Referrals** — every player gets an invite link; when a friend connects and
  plays, the house pays both sides real UCT.
- **Provably-fair verifier** — a [`/#/fairness`](https://unicity-arcade-house.vercel.app/#/fairness)
  page re-runs the commit-reveal math on your own rounds, in your browser.

## Under the hood — built exclusively on the Sphere SDK

Every on-chain and identity operation in this project goes through
**`@unicitylabs/sphere-sdk`** — no other web3 library is used anywhere:

| Sphere SDK surface | Used for |
|-----------|----------|
| **nametag** | the house's on-network identity |
| **payments — mint** | the agent self-funding its treasury |
| **payments — send** | withdrawals + jackpots settled on-chain by the agent |
| **payments — history** | detecting incoming player deposits (sender pubkey + memo) |
| **Sphere Connect** | the player's wallet login **and** the deposit approval flow (`send` intent — the wallet's own UI signs the transfer) |

The house is a live **Sphere agent**: `@bazaar/core` wraps a single Sphere v2
wallet (the documented two-step provider wiring) and the backend runs it on
testnet2. Game logic (commit-reveal fairness, the dealer, the jackpot) is plain
application code on top — the money never moves outside the SDK.

### Astrid OS

The repo also ships an **Astrid OS capsule** ([`capsules/arcade-player/`](capsules/arcade-player/))
— an autonomous player agent on Astrid's WASM microkernel that bets real UCT
against the house and re-verifies every reveal inside the sandbox. Proven on
kernel v0.9.0; see [`docs/ASTRID.md`](docs/ASTRID.md) and the execution log in
[`capsules/arcade-player/PROOF.log`](capsules/arcade-player/PROOF.log).

## Monorepo layout

```
├── packages/
│   ├── bazaar-core/     # Sphere v2 wiring + the arcade game engine
│   │                    #   (arcade/: provably-fair games + GameDealer)
│   ├── backend/         # runs the house agent + /api/arcade endpoints
│   └── dashboard/       # the Arcade House web app (React + Vite)
├── capsules/
│   └── arcade-player/   # Astrid OS capsule: an agent that plays the arcade
```

## Getting started

Requirements: Node ≥ 20, pnpm ≥ 10.

```bash
pnpm install
pnpm -r test          # run the game-logic unit tests
pnpm backend          # run the house backend (needs testnet mnemonics in .env)
pnpm dashboard:dev    # run the web app against it
```

Set `VITE_BACKEND_URL` for the web app to reach a deployed backend.

## Configuration

All config lives in `.env`. Notable values:

- `SPHERE_ORACLE_API_KEY` — the **public** testnet2 gateway key (not a secret).
- `ALPHASCOUT_MNEMONIC` — the house wallet. Leave empty to auto-generate; paste
  back to keep a stable identity. **Never commit a real mnemonic.**

## License

[MIT](./LICENSE) © eren-karakus0

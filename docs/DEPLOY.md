# Deploying the live economy

Two pieces: the **static dashboard** (Vercel, already deployed) and the **live
agent backend** (Render). Wiring them turns the recorded demo into a real,
visitor-driven economy.

## 1. Backend → Render (free)

1. Push this repo to GitHub (done).
2. Render → **New → Blueprint** → select this repo. It reads `render.yaml`
   (build `pnpm install`, start `pnpm --filter @bazaar/backend start`, health
   check `/api/health`).
3. Create the service. On the **first run** the agents auto-generate wallets and
   print their recovery phrases to the logs, e.g.:
   ```
   [analyst] NEW wallet. Save to .env as ANALYST_MNEMONIC:
   [analyst]   <twelve words>
   [scout]   NEW wallet. Save to .env as SCOUT_MNEMONIC:
   [scout]     <twelve words>
   ```
4. Copy those two phrases into the Render service's **Environment** as
   `ANALYST_MNEMONIC` and `ALPHASCOUT_MNEMONIC`, then redeploy. Now the hosted
   agents keep the same identities across restarts. *(Testnet only — never reuse
   these for anything with real value.)*
5. Optionally set `GITHUB_TOKEN` (higher rate limits) and `GEMINI_API_KEY`.
6. Note the service URL, e.g. `https://sphere-agent-bazaar-backend.onrender.com`.

## 2. Dashboard → point at the backend (Vercel)

1. Vercel → the dashboard project → **Settings → Environment Variables**.
2. Add `VITE_BACKEND_URL` = your Render URL (no trailing slash).
3. **Redeploy** the dashboard. It now streams the live economy and routes
   "Analyze" through the real agents.

## Honest tradeoffs (free tier)

- **Render free spins down after ~15 min idle.** The first request after idle
  cold-starts the service (~30–60s) before the agents are ready. The UI shows an
  honest "agents offline → instant preview" state until the backend is warm, and
  falls back to the instant serverless analyzer so the page always works.
- **Keep it warm:** point a free uptime pinger (e.g. cron-job.org or UptimeRobot)
  at `<render-url>/api/health` every 5–10 minutes so visitors usually hit a warm
  service.
- **Each live job is a real on-chain transaction** (~20–40s). That is the point —
  it is not mock data.

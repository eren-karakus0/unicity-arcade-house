/**
 * Unicity Arcade House — backend.
 *
 * Runs the house as a single autonomous Sphere agent on Unicity testnet2 and
 * exposes the game hall to the web app:
 *   POST /api/arcade/new         { game }        -> deal a provably-fair round
 *   POST /api/arcade/play        { roundId, ... } -> reveal, judge, pay on-chain
 *   GET  /api/arcade/leaderboard                  -> catalog + standings
 *   GET  /api/health                              -> readiness probe
 */
import http from 'node:http';
import path from 'node:path';
import { loadEnv, SphereAgent, GameDealer, GAME_LIST, createLogger } from '@bazaar/core';

const PORT = Number(process.env.PORT ?? process.env.BACKEND_PORT ?? 4500);
const env = loadEnv();
const log = createLogger('backend');

/** Lightweight game catalog served to the dashboard's game hall. */
const ARCADE_GAMES = GAME_LIST.map((g) => ({
  id: g.id,
  title: g.title,
  blurb: g.blurb,
  rewardMult: g.rewardMult,
  inputKind: g.inputKind,
}));

// The house wallet (reuses the existing funded identity via ALPHASCOUT_MNEMONIC).
const houseAgent = new SphereAgent({
  name: 'house',
  nametag: env.alphascout.nametag,
  dataDir: path.join(env.dataRoot, 'alphascout'),
  network: env.network,
  oracleApiKey: env.oracleApiKey,
  walletApiUrl: env.walletApiUrl,
  mnemonic: env.alphascout.mnemonic,
  deviceId: 'bazaar-scout',
  logger: createLogger('house'),
});

let dealer: GameDealer | null = null;
let ready = false;

async function boot(): Promise<void> {
  await houseAgent.start();
  dealer = new GameDealer({ agent: houseAgent, cooldownMs: 800, logger: createLogger('dealer') });
  await dealer.start();
  ready = true;
  log.info(`arcade online — house @${houseAgent.nametag}`);
}

function setCors(res: http.ServerResponse): void {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
}
function json(res: http.ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        resolve((JSON.parse(body || '{}') as Record<string, unknown>) ?? {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

const server = http.createServer((req, res) => {
  setCors(res);
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  if (pathname === '/api/health') {
    json(res, 200, { ready, house: houseAgent.nametag });
    return;
  }

  if (pathname === '/api/arcade/leaderboard') {
    if (!dealer) {
      json(res, 200, { ready: false, house: null, baseRewardUct: 0, games: ARCADE_GAMES, rows: [], daily: null });
      return;
    }
    void dealer.houseStats().then((houseStats) => {
      json(res, 200, {
        ready: true,
        house: dealer!.house,
        baseRewardUct: dealer!.baseRewardUct,
        games: ARCADE_GAMES,
        rows: dealer!.leaderboard(),
        daily: dealer!.dailyInfo(),
        houseStats,
      });
    });
    return;
  }

  if (pathname === '/api/arcade/new' && req.method === 'POST') {
    if (!dealer) {
      json(res, 503, { error: 'The arcade dealer is still waking up — try again in a few seconds.' });
      return;
    }
    void readJson(req).then((body) => {
      try {
        const game = String(body.game ?? 'rps');
        const address = typeof body.address === 'string' ? body.address : undefined;
        json(res, 200, dealer!.newRound(game, address));
      } catch (e) {
        json(res, 429, { error: e instanceof Error ? e.message : 'could not start a round' });
      }
    });
    return;
  }

  if (pathname === '/api/arcade/play' && req.method === 'POST') {
    if (!dealer) {
      json(res, 503, { error: 'The arcade dealer is still waking up — try again in a few seconds.' });
      return;
    }
    void readJson(req).then(async (body) => {
      try {
        const result = await dealer!.play({
          roundId: String(body.roundId ?? ''),
          choice: body.choice,
          playerAddress: typeof body.address === 'string' ? body.address : undefined,
          name: typeof body.name === 'string' ? body.name : undefined,
        });
        json(res, 200, result);
      } catch (e) {
        json(res, 400, { error: e instanceof Error ? e.message : 'play failed' });
      }
    });
    return;
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, () => log.info(`backend listening on :${PORT}`));
boot().catch((e) => log.error('boot failed', e instanceof Error ? e.message : e));

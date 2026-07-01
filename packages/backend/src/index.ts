/**
 * Sphere Agent Bazaar — live backend.
 *
 * Runs the Analyst (provider) and Scout (client) as real agents on Unicity
 * testnet2 and exposes them to the web dashboard:
 *   POST /api/jobs   { repo }  -> triggers a real on-chain analyst↔scout job
 *   GET  /api/stream           -> SSE of live economy events
 *   GET  /api/economy          -> recent events + status snapshot
 *   GET  /api/health           -> readiness probe
 */
import http from 'node:http';
import path from 'node:path';
import {
  loadEnv,
  createEventBus,
  eventLogPath,
  SphereAgent,
  AnalystService,
  ScoutClient,
  createLogger,
} from '@bazaar/core';

const PORT = Number(process.env.PORT ?? process.env.BACKEND_PORT ?? 4500);
const env = loadEnv();
const log = createLogger('backend');
const events = createEventBus({ file: eventLogPath(env.dataRoot), keep: 800 });

const analystAgent = new SphereAgent({
  name: 'analyst',
  nametag: env.analyst.nametag,
  dataDir: path.join(env.dataRoot, 'analyst'),
  network: env.network,
  oracleApiKey: env.oracleApiKey,
  walletApiUrl: env.walletApiUrl,
  mnemonic: env.analyst.mnemonic,
  deviceId: 'bazaar-analyst',
  logger: createLogger('analyst'),
});
const scoutAgent = new SphereAgent({
  name: 'scout',
  nametag: env.alphascout.nametag,
  dataDir: path.join(env.dataRoot, 'alphascout'),
  network: env.network,
  oracleApiKey: env.oracleApiKey,
  walletApiUrl: env.walletApiUrl,
  mnemonic: env.alphascout.mnemonic,
  deviceId: 'bazaar-scout',
  logger: createLogger('scout'),
});

let scout: ScoutClient | null = null;
let ready = false;

async function boot(): Promise<void> {
  await analystAgent.start();
  events.emit({ type: 'agent:online', actor: analystAgent.nametag, role: 'provider', detail: 'Repo Risk Analyst' });
  await new AnalystService({ agent: analystAgent, events, githubToken: env.githubToken, gemini: env.gemini }).start();

  await scoutAgent.start();
  events.emit({ type: 'agent:online', actor: scoutAgent.nametag, role: 'client', detail: 'AlphaScout treasury' });
  scout = new ScoutClient({ agent: scoutAgent, events, provider: env.analyst.nametag });
  await scout.start();

  ready = true;
  log.info(`economy online — analyst @${analystAgent.nametag}, scout @${scoutAgent.nametag}`);
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

const server = http.createServer((req, res) => {
  setCors(res);
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  if (pathname === '/api/health') {
    json(res, 200, { ready, analyst: analystAgent.nametag, scout: scoutAgent.nametag });
    return;
  }

  if (pathname === '/api/economy') {
    json(res, 200, { ready, spent: scout?.totalSpent ?? 0, events: events.recent(300) });
    return;
  }

  if (pathname === '/api/stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    for (const e of events.recent(300)) res.write(`data: ${JSON.stringify(e)}\n\n`);
    const unsub = events.subscribe((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(ping);
      unsub();
    });
    return;
  }

  if (pathname === '/api/jobs' && req.method === 'POST') {
    if (!ready || !scout) {
      json(res, 503, { error: 'Agents are still waking up — try again in a few seconds.' });
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      void (async () => {
        try {
          const repo = String((JSON.parse(body || '{}') as { repo?: unknown }).repo ?? '').trim();
          if (!repo) throw new Error('Provide a repo, e.g. facebook/react');
          const report = await scout!.hire(repo);
          json(res, 200, report);
        } catch (e) {
          json(res, 400, { error: e instanceof Error ? e.message : 'job failed' });
        }
      })();
    });
    return;
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, () => log.info(`backend listening on :${PORT}`));
boot().catch((e) => log.error('boot failed', e instanceof Error ? e.message : e));

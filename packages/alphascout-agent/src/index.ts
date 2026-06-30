/**
 * AlphaScout — autonomous treasury client.
 *
 * Discovers a repo-risk provider on the market, hires it for each repo on its
 * watchlist, pays the bills from its own budget (with hard safety caps), and
 * collects the reports. No human approves individual transactions.
 */
import path from 'node:path';
import {
  loadEnv,
  SphereAgent,
  createLogger,
  searchServices,
  sendBazaarMessage,
  onBazaarMessage,
  type RepoRiskReport,
} from '@bazaar/core';

// Treasury safety (security requirement M2.2).
const BUDGET_UCT = 20; // hard total cap
const MAX_PRICE_UCT = 5; // max price per job

const WATCHLIST = (process.env.WATCHLIST?.split(',').map((s) => s.trim()).filter(Boolean)) ?? [
  'unicitynetwork/state-transition-sdk-js',
  'angular/angular.js',
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const env = loadEnv();
  const log = createLogger('alphascout');

  const agent = new SphereAgent({
    name: 'alphascout',
    nametag: env.alphascout.nametag,
    dataDir: path.join(env.dataRoot, 'alphascout'),
    network: env.network,
    oracleApiKey: env.oracleApiKey,
    walletApiUrl: env.walletApiUrl,
    mnemonic: env.alphascout.mnemonic,
    deviceId: 'bazaar-alphascout',
    logger: log,
  });
  await agent.start();

  // Fund the treasury for the demo if needed.
  let balance = Number(await agent.balanceUct());
  if (balance < MAX_PRICE_UCT * WATCHLIST.length) {
    log.info(`treasury ${balance} UCT — self-minting ${BUDGET_UCT} UCT budget`);
    await agent.mintUct(BUDGET_UCT);
    await sleep(1500);
    balance = Number(await agent.balanceUct());
  }
  log.info(`treasury ${balance} UCT (budget cap ${BUDGET_UCT}, max/job ${MAX_PRICE_UCT})`);

  // Discover a provider via the market. The bulletin board can hold several
  // (and stale) repo-risk offers, so we prefer one whose nametag matches our
  // configured provider; otherwise we fall back to it directly.
  const provider = env.analyst.nametag.replace(/^@/, '');
  try {
    const found = await searchServices(agent, 'repo risk analysis github security', { limit: 8 });
    const match = found.find((f) => f.agentNametag?.replace(/^@/, '') === provider);
    if (match?.agentNametag) {
      log.info(`discovered provider on market: @${provider} (score ${match.score?.toFixed?.(2) ?? '?'})`);
    } else {
      log.info(`market lists ${found.length} repo-risk offer(s); using configured @${provider}`);
    }
  } catch {
    log.warn(`market search failed — using configured @${provider}`);
  }

  // State.
  let spent = 0;
  const myJobs = new Set<string>(); // jobs we initiated this session
  const quotes = new Map<string, { jobId: string; price: number }>(); // authorized, by paymentRequestId
  const bills = new Map<string, string>(); // present-in-wallet, requestId -> amount (smallest units)
  const paid = new Set<string>();
  const inflight = new Set<string>();
  const results = new Map<string, RepoRiskReport>();

  // Pay only when a bill is BOTH authorized (we have a quote for one of our jobs)
  // AND present in the wallet — and only within the hard caps. Idempotent.
  const tryPay = async (reqId: string): Promise<void> => {
    const quote = quotes.get(reqId);
    const amount = bills.get(reqId);
    if (!quote || amount === undefined) return; // not authorized yet, or bill not arrived yet
    if (paid.has(reqId) || inflight.has(reqId)) return;

    const price = Number(agent.toHuman(amount));
    if (price > MAX_PRICE_UCT) {
      log.warn(`bill ${price} UCT exceeds max/job ${MAX_PRICE_UCT} — refused`);
      return;
    }
    if (spent + price > BUDGET_UCT) {
      log.warn(`budget cap ${BUDGET_UCT} UCT reached — refused`);
      return;
    }

    inflight.add(reqId);
    try {
      await agent.payRequest(reqId);
      paid.add(reqId);
      spent += price;
      log.info(`paid ${price} UCT for job ${quote.jobId} — spent ${spent}/${BUDGET_UCT} UCT`);
    } catch (e) {
      log.warn(`pay attempt for ${reqId} not ready yet: ${e instanceof Error ? e.message : e}`);
    } finally {
      inflight.delete(reqId);
    }
  };

  // Quotes + results.
  onBazaarMessage(agent, (msg) => {
    if (msg.kind === 'job-quote') {
      if (!myJobs.has(msg.jobId)) return; // ignore quotes for jobs we didn't initiate
      if (msg.paymentRequestId) {
        quotes.set(msg.paymentRequestId, { jobId: msg.jobId, price: Number(msg.priceUct) });
        void tryPay(msg.paymentRequestId);
      }
    } else if (msg.kind === 'job-result') {
      if (!myJobs.has(msg.jobId)) return;
      results.set(msg.jobId, msg.report);
      const r = msg.report;
      log.info(`report  ${r.repo}: ${r.riskScore}/100 ${r.riskBand} - ${r.summary.split('\n')[0]}`);
    } else if (msg.kind === 'job-reject') {
      log.warn(`job ${msg.jobId} rejected: ${msg.reason}`);
    }
  });

  // Incoming bills (provider's payment requests).
  agent.onPaymentRequest((raw) => {
    const inc = raw as { requestId: string; amount: string; senderNametag?: string };
    if (!inc?.requestId || inc.amount === undefined) return;
    bills.set(inc.requestId, inc.amount);
    void tryPay(inc.requestId);
  });

  // Hire: send one job-request per repo.
  let n = 0;
  for (const repoUrl of WATCHLIST) {
    const jobId = `job-${Date.now()}-${n++}`;
    myJobs.add(jobId);
    await sendBazaarMessage(agent, provider, {
      kind: 'job-request',
      service: 'repo-risk-analysis',
      jobId,
      repoUrl,
      replyTo: agent.nametag,
    });
    log.info(`hired @${provider} -> analyze ${repoUrl} (job ${jobId})`);
    await sleep(500);
  }

  // Wait for reports (up to ~2 minutes).
  log.info('waiting for reports…');
  for (let i = 0; i < 40 && results.size < WATCHLIST.length; i++) {
    await sleep(3000);
  }

  log.info('================ SUMMARY ================');
  log.info(`jobs ${WATCHLIST.length} | reports ${results.size} | spent ${spent}/${BUDGET_UCT} UCT`);
  for (const r of results.values()) {
    log.info(`  ${r.repo}: ${r.riskScore}/100 ${r.riskBand} [${r.summarizer}]`);
  }
  log.info(`treasury remaining: ${await agent.balanceUct()} UCT`);

  await agent.stop();
  process.exit(0);
}

main().catch((e) => {
  console.error('[alphascout] fatal:', e);
  process.exit(1);
});

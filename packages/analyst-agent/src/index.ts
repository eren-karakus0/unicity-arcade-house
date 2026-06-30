/**
 * Repo Risk Analyst — provider agent.
 *
 * Advertises a repo-risk-analysis service on the market, then runs as a service:
 * on a job-request DM it bills the client via a payment request, and once paid
 * it analyzes the repo and delivers the report — all without a human in the loop.
 */
import path from 'node:path';
import {
  loadEnv,
  SphereAgent,
  createLogger,
  postServiceListing,
  sendBazaarMessage,
  onBazaarMessage,
  type ServiceListing,
} from '@bazaar/core';
import { analyzeRepo } from './analysis/analyzer.js';
import { parseRepoUrl } from './analysis/repo-url.js';

const PRICE_UCT = '2';
const SERVICE = 'repo-risk-analysis' as const;

async function main(): Promise<void> {
  const env = loadEnv();
  const log = createLogger('analyst');

  const agent = new SphereAgent({
    name: 'analyst',
    nametag: env.analyst.nametag,
    dataDir: path.join(env.dataRoot, 'analyst'),
    network: env.network,
    oracleApiKey: env.oracleApiKey,
    walletApiUrl: env.walletApiUrl,
    mnemonic: env.analyst.mnemonic,
    deviceId: 'bazaar-analyst',
    logger: log,
  });
  await agent.start();

  /** paymentRequestId -> job awaiting payment */
  const pending = new Map<string, { jobId: string; client: string; repoUrl: string }>();

  const listing: ServiceListing = {
    service: SERVICE,
    version: '1',
    priceUct: PRICE_UCT,
    currency: 'UCT',
    providerNametag: agent.nametag,
    description:
      'Repo Risk Analysis — score the maintenance & security risk of any public ' +
      'GitHub repo (archived / stale / license / activity signals) and return a ' +
      'structured report. Pay per analysis.',
  };
  await postServiceListing(agent, listing, { expiresInDays: 7 });
  log.info(`service posted to market @ ${PRICE_UCT} UCT/analysis`);

  // 1) job-request -> validate -> bill
  onBazaarMessage(agent, (msg, dm) => {
    void (async () => {
      if (msg.kind !== 'job-request') return;
      const client = (msg.replyTo || dm.senderNametag || '').replace(/^@/, '');
      if (msg.service !== SERVICE || !client) return;

      // Security M2.1/M2.3: validate the untrusted repoUrl before doing anything.
      try {
        parseRepoUrl(msg.repoUrl);
      } catch {
        await sendBazaarMessage(agent, client, {
          kind: 'job-reject',
          jobId: msg.jobId,
          reason: 'invalid or non-GitHub repoUrl',
        });
        return;
      }

      const pr = await agent.requestPayment(client, PRICE_UCT, `Repo risk analysis: ${msg.repoUrl}`);
      if (!pr.success || !pr.requestId) {
        await sendBazaarMessage(agent, client, {
          kind: 'job-reject',
          jobId: msg.jobId,
          reason: 'could not create invoice',
        });
        return;
      }
      pending.set(pr.requestId, { jobId: msg.jobId, client, repoUrl: msg.repoUrl });
      await sendBazaarMessage(agent, client, {
        kind: 'job-quote',
        jobId: msg.jobId,
        priceUct: PRICE_UCT,
        paymentRequestId: pr.requestId,
      });
      log.info(`quoted @${client} ${PRICE_UCT} UCT for ${msg.repoUrl}`);
    })().catch((e) => log.error('job-request handler failed', e));
  });

  // 2) payment received -> analyze -> deliver
  agent.onPaymentRequestResponse((raw) => {
    void (async () => {
      const res = raw as { requestId: string; responseType: string };
      const job = pending.get(res.requestId);
      if (!job) return;
      pending.delete(res.requestId);
      if (res.responseType !== 'paid') return;

      log.info(`payment received for ${job.repoUrl} — analyzing…`);
      try {
        const report = await analyzeRepo(job.repoUrl, {
          githubToken: env.githubToken,
          gemini: env.gemini,
        });
        await sendBazaarMessage(agent, job.client, {
          kind: 'job-result',
          jobId: job.jobId,
          repoUrl: job.repoUrl,
          report,
        });
        log.info(`delivered to @${job.client}: ${report.repo} -> ${report.riskScore}/100 ${report.riskBand}`);
      } catch (e) {
        await sendBazaarMessage(agent, job.client, {
          kind: 'job-reject',
          jobId: job.jobId,
          reason: 'analysis failed',
        });
        log.error(`analysis failed for ${job.repoUrl}`, e instanceof Error ? e.message : e);
      }
    })().catch((e) => log.error('payment handler failed', e));
  });

  log.info(`analyst online as @${agent.nametag} — waiting for jobs (Ctrl+C to stop)`);

  const shutdown = () => {
    log.info('shutting down…');
    void agent.stop().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('[analyst] fatal:', e);
  process.exit(1);
});

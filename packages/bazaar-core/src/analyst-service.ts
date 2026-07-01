import type { SphereAgent } from './sphere-agent.js';
import type { EventBus } from './events.js';
import { postServiceListing, sendBazaarMessage, onBazaarMessage } from './bazaar-protocol.js';
import { analyzeRepo, parseRepoUrl } from './analysis/index.js';
import type { ServiceListing } from './types.js';
import { createLogger, type Logger } from './logger.js';

const SERVICE = 'repo-risk-analysis' as const;

export interface AnalystServiceOptions {
  agent: SphereAgent;
  events: EventBus;
  priceUct?: string;
  githubToken?: string;
  gemini?: { apiKey?: string; model: string };
  logger?: Logger;
}

/**
 * The provider side, as a long-running service: advertise on the market, then
 * for each job-request bill the client via a payment request and — once paid —
 * analyze the repo and deliver the report. Emits economy events throughout.
 */
export class AnalystService {
  private readonly agent: SphereAgent;
  private readonly events: EventBus;
  private readonly price: string;
  private readonly log: Logger;
  private readonly pending = new Map<string, { jobId: string; client: string; repoUrl: string }>();

  constructor(private readonly opts: AnalystServiceOptions) {
    this.agent = opts.agent;
    this.events = opts.events;
    this.price = opts.priceUct ?? '2';
    this.log = opts.logger ?? createLogger('analyst');
  }

  async start(): Promise<void> {
    const listing: ServiceListing = {
      service: SERVICE,
      version: '1',
      priceUct: this.price,
      currency: 'UCT',
      providerNametag: this.agent.nametag,
      description:
        'Repo Risk Analysis — score the maintenance & security risk of any public ' +
        'GitHub repo (archived / stale / license / activity signals + a real ' +
        'dependency-CVE scan via OSV.dev) and return a structured report. Pay per analysis.',
    };
    await postServiceListing(this.agent, listing, { expiresInDays: 7 });
    this.log.info(`service posted @ ${this.price} UCT/analysis`);
    this.events.emit({ type: 'service:posted', actor: this.agent.nametag, role: 'provider', amountUct: this.price, detail: SERVICE });

    onBazaarMessage(this.agent, (msg, dm) => {
      void (async () => {
        if (msg.kind !== 'job-request') return;
        const client = (msg.replyTo || dm.senderNametag || '').replace(/^@/, '');
        if (msg.service !== SERVICE || !client) return;

        try {
          parseRepoUrl(msg.repoUrl);
        } catch {
          this.events.emit({ type: 'job:rejected', actor: this.agent.nametag, role: 'provider', jobId: msg.jobId, counterparty: client, detail: 'invalid repoUrl' });
          await sendBazaarMessage(this.agent, client, { kind: 'job-reject', jobId: msg.jobId, reason: 'invalid or non-GitHub repoUrl' });
          return;
        }
        this.events.emit({ type: 'job:requested', actor: this.agent.nametag, role: 'provider', jobId: msg.jobId, repo: msg.repoUrl, counterparty: client });

        const pr = await this.agent.requestPayment(client, this.price, `Repo risk analysis: ${msg.repoUrl}`);
        if (!pr.success || !pr.requestId) {
          await sendBazaarMessage(this.agent, client, { kind: 'job-reject', jobId: msg.jobId, reason: 'could not create invoice' });
          return;
        }
        this.pending.set(pr.requestId, { jobId: msg.jobId, client, repoUrl: msg.repoUrl });
        await sendBazaarMessage(this.agent, client, { kind: 'job-quote', jobId: msg.jobId, priceUct: this.price, paymentRequestId: pr.requestId });
        this.events.emit({ type: 'job:quoted', actor: this.agent.nametag, role: 'provider', jobId: msg.jobId, repo: msg.repoUrl, counterparty: client, amountUct: this.price });
      })().catch((e) => this.log.error('job-request handler failed', e));
    });

    this.agent.onPaymentRequestResponse((raw) => {
      void (async () => {
        const res = raw as { requestId: string; responseType: string };
        const job = this.pending.get(res.requestId);
        if (!job) return;
        this.pending.delete(res.requestId);
        if (res.responseType !== 'paid') return;

        this.events.emit({ type: 'job:paid', actor: this.agent.nametag, role: 'provider', jobId: job.jobId, repo: job.repoUrl, counterparty: job.client, amountUct: this.price });
        this.events.emit({ type: 'job:analyzing', actor: this.agent.nametag, role: 'provider', jobId: job.jobId, repo: job.repoUrl });
        try {
          const report = await analyzeRepo(job.repoUrl, { githubToken: this.opts.githubToken, gemini: this.opts.gemini });
          await sendBazaarMessage(this.agent, job.client, { kind: 'job-result', jobId: job.jobId, repoUrl: job.repoUrl, report });
          this.log.info(`delivered ${report.repo} -> ${report.riskScore}/100 ${report.riskBand}`);
          this.events.emit({ type: 'job:delivered', actor: this.agent.nametag, role: 'provider', jobId: job.jobId, repo: report.repo, counterparty: job.client, riskScore: report.riskScore, riskBand: report.riskBand });
        } catch (e) {
          await sendBazaarMessage(this.agent, job.client, { kind: 'job-reject', jobId: job.jobId, reason: 'analysis failed' });
          this.events.emit({ type: 'job:rejected', actor: this.agent.nametag, role: 'provider', jobId: job.jobId, repo: job.repoUrl, counterparty: job.client, detail: 'analysis failed' });
          this.log.error(`analysis failed for ${job.repoUrl}`, e instanceof Error ? e.message : e);
        }
      })().catch((e) => this.log.error('payment handler failed', e));
    });
  }
}

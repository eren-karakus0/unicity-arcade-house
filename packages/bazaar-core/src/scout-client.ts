import type { SphereAgent } from './sphere-agent.js';
import type { EventBus } from './events.js';
import { searchServices, sendBazaarMessage, onBazaarMessage } from './bazaar-protocol.js';
import type { RepoRiskReport } from './types.js';
import { createLogger, type Logger } from './logger.js';

export interface ScoutClientOptions {
  agent: SphereAgent;
  events: EventBus;
  /** Provider nametag to hire (without @). */
  provider: string;
  budgetUct?: number;
  maxPriceUct?: number;
  logger?: Logger;
}

interface Waiter {
  resolve: (r: RepoRiskReport) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The client side as an on-demand hirer. `hire(repo)` sends a real job-request,
 * pays the provider's invoice (within hard caps, idempotently), and resolves
 * with the delivered report — so a web request can drive a real on-chain job.
 */
export class ScoutClient {
  private readonly agent: SphereAgent;
  private readonly events: EventBus;
  private readonly provider: string;
  private readonly budget: number;
  private readonly maxPrice: number;
  private readonly log: Logger;

  private readonly quotes = new Map<string, { jobId: string; price: number }>();
  private readonly bills = new Map<string, string>();
  private readonly paid = new Set<string>();
  private readonly inflight = new Set<string>();
  private readonly myJobs = new Map<string, string>();
  private readonly waiters = new Map<string, Waiter>();
  private spent = 0;

  constructor(opts: ScoutClientOptions) {
    this.agent = opts.agent;
    this.events = opts.events;
    this.provider = opts.provider.replace(/^@/, '');
    this.budget = opts.budgetUct ?? 50;
    this.maxPrice = opts.maxPriceUct ?? 5;
    this.log = opts.logger ?? createLogger('scout');
  }

  get totalSpent(): number {
    return this.spent;
  }

  async start(): Promise<void> {
    await this.ensureBudget();

    try {
      const found = await searchServices(this.agent, 'repo risk analysis github security', { limit: 8 });
      const match = found.find((f) => f.agentNametag?.replace(/^@/, '') === this.provider);
      this.events.emit({
        type: 'service:discovered',
        actor: this.agent.nametag,
        role: 'client',
        counterparty: this.provider,
        detail: match ? `market score ${match.score?.toFixed?.(2) ?? '?'}` : 'configured',
      });
    } catch {
      /* discovery is best-effort */
    }

    onBazaarMessage(this.agent, (msg) => {
      if (msg.kind === 'job-quote') {
        if (!this.myJobs.has(msg.jobId) || !msg.paymentRequestId) return;
        this.quotes.set(msg.paymentRequestId, { jobId: msg.jobId, price: Number(msg.priceUct) });
        void this.tryPay(msg.paymentRequestId);
      } else if (msg.kind === 'job-result') {
        const w = this.waiters.get(msg.jobId);
        if (w) {
          clearTimeout(w.timer);
          this.waiters.delete(msg.jobId);
          w.resolve(msg.report);
        }
        this.events.emit({
          type: 'job:delivered',
          actor: this.agent.nametag,
          role: 'client',
          jobId: msg.jobId,
          repo: msg.report.repo,
          counterparty: this.provider,
          riskScore: msg.report.riskScore,
          riskBand: msg.report.riskBand,
        });
      } else if (msg.kind === 'job-reject') {
        const w = this.waiters.get(msg.jobId);
        if (w) {
          clearTimeout(w.timer);
          this.waiters.delete(msg.jobId);
          w.reject(new Error(msg.reason || 'job rejected'));
        }
      }
    });

    this.agent.onPaymentRequest((raw) => {
      const inc = raw as { requestId: string; amount: string };
      if (!inc?.requestId || inc.amount === undefined) return;
      this.bills.set(inc.requestId, inc.amount);
      void this.tryPay(inc.requestId);
    });
  }

  /** Send a real job-request for `repo`; resolves with the delivered report. */
  async hire(repo: string, timeoutMs = 90_000): Promise<RepoRiskReport> {
    await this.ensureBudget();
    const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.myJobs.set(jobId, repo);

    const result = new Promise<RepoRiskReport>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(jobId);
        reject(new Error('The agents did not finish in time — testnet may be busy. Try again.'));
      }, timeoutMs);
      this.waiters.set(jobId, { resolve, reject, timer });
    });

    await sendBazaarMessage(this.agent, this.provider, {
      kind: 'job-request',
      service: 'repo-risk-analysis',
      jobId,
      repoUrl: repo,
      replyTo: this.agent.nametag,
    });
    this.log.info(`hired @${this.provider} -> ${repo} (${jobId})`);
    this.events.emit({ type: 'job:requested', actor: this.agent.nametag, role: 'client', jobId, repo, counterparty: this.provider });

    return result;
  }

  private async ensureBudget(): Promise<void> {
    try {
      const balance = Number(await this.agent.balanceUct());
      if (balance < this.maxPrice * 3) {
        this.log.info(`treasury ${balance} UCT — minting ${this.budget}`);
        await this.agent.mintUct(this.budget);
      }
    } catch (e) {
      this.log.warn('budget check failed', e instanceof Error ? e.message : e);
    }
  }

  private async tryPay(reqId: string): Promise<void> {
    const quote = this.quotes.get(reqId);
    const amount = this.bills.get(reqId);
    if (!quote || amount === undefined) return;
    if (this.paid.has(reqId) || this.inflight.has(reqId)) return;

    const price = Number(this.agent.toHuman(amount));
    if (price > this.maxPrice) {
      this.log.warn(`bill ${price} UCT exceeds max/job ${this.maxPrice} — refused`);
      return;
    }

    this.inflight.add(reqId);
    try {
      await this.agent.payRequest(reqId);
      this.paid.add(reqId);
      this.spent += price;
      this.events.emit({
        type: 'payment:sent',
        actor: this.agent.nametag,
        role: 'client',
        jobId: quote.jobId,
        repo: this.myJobs.get(quote.jobId),
        counterparty: this.provider,
        amountUct: String(price),
      });
    } catch (e) {
      this.log.warn(`pay attempt for ${reqId} not ready: ${e instanceof Error ? e.message : e}`);
    } finally {
      this.inflight.delete(reqId);
    }
  }
}

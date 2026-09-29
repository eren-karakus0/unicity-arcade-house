import path from 'node:path';
import { writeFileSync } from 'node:fs';
import {
  NETWORKS,
  Sphere,
  TokenRegistry,
  getCoinIdBySymbol,
  getTokenDecimals,
  parseTokenAmount,
  toHumanReadable,
} from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';
import { createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/shared/wallet-api';
import { Logger, createLogger } from './logger.js';
import { PUBLIC_TESTNET2_KEY, type NetworkType } from './config.js';
import { provisionGatewayKey } from './gateway-key.js';

const UCT = 'UCT';
/** SDK default when a token's decimals can't be resolved (mirrors DEFAULT_TOKEN_DECIMALS). */
const DEFAULT_UCT_DECIMALS = 18;
const REGISTRY_READY_TIMEOUT_MS = 15_000;
/** The wallet-api rails and Sphere.init below run on testnet2 end-to-end. */
const SPHERE_NETWORK = 'testnet2' as const;

export interface SphereAgentOptions {
  /** Logical name, e.g. 'analyst' — used for logs, deviceId, data dir. */
  name: string;
  /** Desired on-network @nametag (without the @). */
  nametag: string;
  /** Absolute path for this agent's wallet + token storage. */
  dataDir: string;
  network?: NetworkType;
  oracleApiKey: string;
  walletApiUrl: string;
  deviceId?: string;
  /** Optional mnemonic; if absent a new wallet is auto-generated. */
  mnemonic?: string;
  logger?: Logger;
}

/**
 * SphereAgent — a thin, reusable wrapper around a single Sphere v2 wallet.
 *
 * It performs the two-step v2 provider wiring (base providers + wallet-api
 * rails — the step that silently breaks transfers if skipped), enables the
 * market module, and exposes the economic primitives our bazaar agents need:
 * mint, send/receive, payment requests, DMs, market intents.
 */
export class SphereAgent {
  readonly name: string;
  readonly desiredNametag: string;
  readonly log: Logger;

  private readonly opts: SphereAgentOptions;
  private inner: Sphere | null = null;
  private uctCoinId = UCT;
  private uctDecimals: number | undefined;

  constructor(opts: SphereAgentOptions) {
    this.opts = opts;
    this.name = opts.name;
    this.desiredNametag = opts.nametag.replace(/^@/, '');
    this.log = opts.logger ?? createLogger(opts.name);
  }

  get sphere(): Sphere {
    if (!this.inner) throw new Error(`[${this.name}] agent not started — call start() first`);
    return this.inner;
  }

  async start(): Promise<{ created: boolean; mnemonic?: string }> {
    // This wrapper targets testnet2 end-to-end (the wallet-api rails and
    // Sphere.init below are testnet2); 'testnet' is the SDK's alias for it.
    // Normalize so the base providers can't drift onto a different network id
    // than the rails.
    const network: NetworkType =
      this.opts.network === 'testnet' ? 'testnet2' : (this.opts.network ?? 'testnet2');
    // No tokensDir: token custody is server-side on the wallet-api rail, so
    // there is no local token store to point anywhere (SDK 0.14).
    const base = createNodeProviders({
      network,
      dataDir: this.opts.dataDir,
      oracle: { apiKey: this.opts.oracleApiKey },
    });
    const providers = createWalletApiProviders(base, {
      baseUrl: this.opts.walletApiUrl,
      network: SPHERE_NETWORK,
      deviceId: this.opts.deviceId ?? `bazaar-${this.name}`,
    });

    const common = {
      ...providers,
      network: SPHERE_NETWORK,
      nametag: this.desiredNametag,
      market: true as const,
      groupChat: true as const,
    };
    const initOptions = this.opts.mnemonic
      ? { ...common, mnemonic: this.opts.mnemonic }
      : { ...common, autoGenerate: true as const };

    this.log.info(`starting wallet @${this.desiredNametag} on ${network}…`);
    const { sphere, created, generatedMnemonic } = await Sphere.init(initOptions);
    this.inner = sphere;
    if (this.opts.oracleApiKey === PUBLIC_TESTNET2_KEY) await this.useOwnGatewayKey(sphere);

    // Init does not wait for the remote token registry; read UCT's id and
    // decimals before it lands and they silently fall back to the symbol and
    // the 18-decimal default.
    if (!(await TokenRegistry.waitForReady(REGISTRY_READY_TIMEOUT_MS))) {
      this.log.warn(`token registry not ready after ${REGISTRY_READY_TIMEOUT_MS}ms — UCT id/decimals use fallbacks`);
    }
    this.uctCoinId = getCoinIdBySymbol(UCT) ?? UCT;
    try {
      this.uctDecimals = getTokenDecimals(this.uctCoinId);
    } catch {
      this.uctDecimals = undefined;
    }

    this.log.info(`ready — @${this.nametag}  addr=${this.directAddress?.slice(0, 24)}…`);
    this.log.info(`modules: market=${!!sphere.market} groupChat=${!!sphere.groupChat}`);
    if (created && generatedMnemonic) {
      // Never print a live mnemonic to stdout/stderr — hosting logs are retained
      // and often exportable. Persist it beside the wallet's own key storage (the
      // dataDir already holds secrets and is gitignored) and log only the path.
      const secretPath = path.join(this.opts.dataDir, 'mnemonic.txt');
      const envKey = `${this.name.toUpperCase()}_MNEMONIC`;
      try {
        writeFileSync(secretPath, `${generatedMnemonic}\n`, { encoding: 'utf8', mode: 0o600 });
        this.log.warn(`NEW wallet generated — mnemonic written to ${secretPath}. Copy it into .env as ${envKey}, then delete the file.`);
      } catch {
        this.log.warn(`NEW wallet generated — set ${envKey} in .env (mnemonic withheld from logs).`);
      }
    }
    return { created, mnemonic: generatedMnemonic };
  }

  /**
   * Swap the shared public key for this wallet's own, so the agent stops
   * competing with every other wallet for one key's rate limit. A failure keeps
   * the shared key: the agent still works, only throttled as before.
   */
  private async useOwnGatewayKey(sphere: Sphere): Promise<void> {
    try {
      const key = await provisionGatewayKey({
        gatewayUrl: NETWORKS[SPHERE_NETWORK].aggregatorUrl,
        network: SPHERE_NETWORK,
        privateKeyHex: sphere.deriveAddress(0).privateKey,
      });
      await sphere.setOracleApiKey(key.apiKey);
      this.log.info(`gateway key: own ${key.plan}-plan key (${key.created ? 'created' : 'reused'})`);
    } catch (e) {
      this.log.warn(`gateway key: staying on the shared public key — ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  get nametag(): string {
    return this.inner?.getNametag() ?? this.desiredNametag;
  }
  get directAddress(): string | undefined {
    return this.inner?.identity?.directAddress;
  }
  get chainPubkey(): string | undefined {
    return this.inner?.identity?.chainPubkey;
  }

  /** UCT coin id (hex) + decimals — e.g. for building wallet send-intents. */
  get uctCoin(): { coinId: string; decimals: number } {
    return { coinId: this.uctCoinId, decimals: this.uctDecimals ?? DEFAULT_UCT_DECIMALS };
  }

  // ---- amount helpers (human UCT string/number <-> smallest-unit) ----
  toSmallest(human: string | number): string {
    return parseTokenAmount(String(human), this.uctDecimals).toString();
  }
  toHuman(smallest: bigint | string): string {
    return toHumanReadable(smallest, this.uctDecimals);
  }

  // ---- payments ----
  /** Mirrors the SDK's MintResult, which the package does not export by name. */
  async mintUct(human: string | number): Promise<{ success: boolean; tokenId?: string; error?: string }> {
    const amount = parseTokenAmount(String(human), this.uctDecimals);
    const coinIdHex = getCoinIdBySymbol(UCT) ?? this.uctCoinId;
    this.log.info(`self-minting ${human} UCT (coinId ${coinIdHex.slice(0, 10)}…)…`);
    return this.sphere.payments.mint(coinIdHex, amount);
  }

  async send(recipient: string, human: string | number, memo?: string) {
    const to = this.normalizeRecipient(recipient);
    this.log.info(`sending ${human} UCT → ${to.slice(0, 28)}…`);
    return this.sphere.payments.send({
      coinId: this.uctCoinId,
      amount: this.toSmallest(human),
      recipient: to,
      ...(memo ? { memo } : {}),
    });
  }

  /**
   * Drain the mailbox now. Incoming transfers also land on their own while the
   * wallet runs; `onTransfer` is delivered through the wallet event stream
   * (receive() no longer takes a callback) and stays subscribed for those too.
   */
  async receive(onTransfer?: (t: unknown) => void) {
    if (onTransfer) this.sphere.on('transfer:incoming', onTransfer as never);
    return this.sphere.payments.receive();
  }

  /**
   * The wallet's transaction history (newest first). This is the reliable way
   * to observe INCOMING transfers: the wallet-api rails deliver tokens in the
   * background (receive() callbacks never fire for them), but every delivery
   * lands here as a RECEIVED entry with sender pubkey/nametag + memo.
   */
  async getHistory(limit = 200): Promise<unknown[]> {
    // History is paged (SDK 0.14) and the server picks the size when no limit
    // is given. Ask for a generous page explicitly: callers sweep a recent time
    // window on a busy wallet, and a small default page could hide arrivals.
    const page = await this.sphere.payments.history({ limit });
    return page.entries;
  }

  /**
   * Drive open transfer intents toward convergence. When a certification cannot
   * be confirmed the SDK keeps the intent open and HOLDS its source token, so
   * the tokens come back only once these settle. This — never a fresh send — is
   * the recovery path for such a transfer: re-sending would spend a second
   * token for a payment that may already be on-chain.
   */
  async resumeOpenTransfers(): Promise<void> {
    await this.sphere.payments.resumeNow();
  }

  /** Open intents (and shortfalls) currently holding this wallet's tokens. */
  async pendingTransfers(): Promise<unknown[]> {
    return this.sphere.payments.pendingTransfers();
  }

  /** Confirmed (spendable) UCT balance, as a human-readable string. */
  async balanceUct(): Promise<string> {
    const uctHex = getCoinIdBySymbol(UCT);
    const assets = await this.sphere.payments.assets();
    let total = 0n;
    for (const a of assets) {
      if (a.symbol === UCT || a.coinId === uctHex) {
        try { total += BigInt(a.confirmedAmount || a.totalAmount || '0'); } catch { /* ignore */ }
      }
    }
    return this.toHuman(total);
  }

  // ---- payment requests ----
  // These live under payments.requests and report through the wallet event
  // stream (SDK 0.14). The wrapper keeps its own shape so callers stay put.
  async requestPayment(fromNametag: string, human: string | number, message: string) {
    return this.sphere.payments.requests.create(
      fromNametag.startsWith('@') ? fromNametag : `@${fromNametag}`,
      { coinId: this.uctCoinId, amount: this.toSmallest(human), memo: message },
    );
  }
  async payRequest(requestId: string) {
    return this.sphere.payments.requests.pay(requestId);
  }
  onPaymentRequest(handler: (req: unknown) => void) {
    return this.sphere.on('payment_request:incoming', handler as never);
  }
  /**
   * Settlement updates for requests WE issued. The event reports a lifecycle
   * `status`; republish it under the `responseType` the bazaar flows match on,
   * so only a genuinely paid request advances a job.
   */
  onPaymentRequestResponse(handler: (res: unknown) => void) {
    return this.sphere.on('payment_request:updated', (e) => {
      const { id, status } = e as { id: string; status: string };
      handler({ requestId: id, responseType: status });
    });
  }

  // ---- messaging (Nostr DM) ----
  async dm(recipient: string, content: string) {
    return this.sphere.communications.sendDM(
      recipient.startsWith('@') ? recipient : `@${recipient}`,
      content,
    );
  }
  onDM(handler: (msg: unknown) => void) {
    return this.sphere.communications.onDirectMessage(handler as never);
  }

  // ---- market (nullable module, enabled in start()) ----
  get market() {
    const m = this.sphere.market;
    if (!m) throw new Error(`[${this.name}] market module not enabled`);
    return m;
  }

  private normalizeRecipient(recipient: string): string {
    if (recipient.startsWith('@') || recipient.includes('://')) return recipient;
    if (/^0[23][0-9a-fA-F]{64}$/.test(recipient)) return recipient; // chain pubkey
    return `@${recipient}`;
  }

  async stop(): Promise<void> {
    if (this.inner) {
      await this.inner.destroy();
      this.inner = null;
    }
  }
}

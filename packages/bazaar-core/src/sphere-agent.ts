import path from 'node:path';
import {
  Sphere,
  getCoinIdBySymbol,
  getTokenDecimals,
  parseTokenAmount,
  toHumanReadable,
} from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';
import { createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/shared/wallet-api';
import { Logger, createLogger } from './logger.js';
import type { NetworkType } from './config.js';

const UCT = 'UCT';

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
 * market and swap modules, and exposes the economic primitives our bazaar
 * agents need: mint, send/receive, payment requests, DMs, market intents.
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
    const base = createNodeProviders({
      network: this.opts.network ?? 'testnet',
      dataDir: this.opts.dataDir,
      tokensDir: path.join(this.opts.dataDir, 'tokens'),
      oracle: { apiKey: this.opts.oracleApiKey },
    });
    const providers = createWalletApiProviders(base, {
      baseUrl: this.opts.walletApiUrl,
      network: 'testnet2',
      deviceId: this.opts.deviceId ?? `bazaar-${this.name}`,
    });

    const common = {
      ...providers,
      network: 'testnet2' as const,
      nametag: this.desiredNametag,
      market: true as const,
      // Swap requires the accounting (invoice) module — enable both together.
      accounting: true as const,
      swap: true as const,
      groupChat: true as const,
    };
    const initOptions = this.opts.mnemonic
      ? { ...common, mnemonic: this.opts.mnemonic }
      : { ...common, autoGenerate: true as const };

    this.log.info(`starting wallet @${this.desiredNametag} on ${this.opts.network ?? 'testnet'}…`);
    const { sphere, created, generatedMnemonic } = await Sphere.init(initOptions);
    this.inner = sphere;

    this.uctCoinId = getCoinIdBySymbol(UCT) ?? UCT;
    try {
      this.uctDecimals = getTokenDecimals(this.uctCoinId);
    } catch {
      this.uctDecimals = undefined;
    }

    this.log.info(`ready — @${this.nametag}  addr=${this.directAddress?.slice(0, 24)}…`);
    this.log.info(`modules: market=${!!sphere.market} swap=${!!sphere.swap} groupChat=${!!sphere.groupChat}`);
    if (created && generatedMnemonic) {
      this.log.warn(`NEW wallet. Save to .env as ${this.name.toUpperCase()}_MNEMONIC:`);
      this.log.warn(`  ${generatedMnemonic}`);
    }
    return { created, mnemonic: generatedMnemonic };
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
    return { coinId: this.uctCoinId, decimals: this.uctDecimals ?? 0 };
  }

  // ---- amount helpers (human UCT string/number <-> smallest-unit) ----
  toSmallest(human: string | number): string {
    return parseTokenAmount(String(human), this.uctDecimals).toString();
  }
  toHuman(smallest: bigint | string): string {
    return toHumanReadable(smallest, this.uctDecimals);
  }

  // ---- payments ----
  async mintUct(human: string | number) {
    const amount = parseTokenAmount(String(human), this.uctDecimals);
    const coinIdHex = getCoinIdBySymbol(UCT) ?? this.uctCoinId;
    this.log.info(`self-minting ${human} UCT (coinId ${coinIdHex.slice(0, 10)}…)…`);
    return this.sphere.payments.mintFungibleToken(coinIdHex, amount);
  }

  async send(recipient: string, human: string | number, memo?: string) {
    const to = this.normalizeRecipient(recipient);
    this.log.info(`sending ${human} UCT → ${to.slice(0, 28)}…`);
    return this.sphere.payments.send({
      coinId: UCT,
      amount: this.toSmallest(human),
      recipient: to,
      ...(memo ? { memo } : {}),
    });
  }

  async receive(onTransfer?: (t: unknown) => void) {
    return this.sphere.payments.receive(undefined, onTransfer as never);
  }

  /** Confirmed (spendable) UCT balance, as a human-readable string. */
  async balanceUct(): Promise<string> {
    const uctHex = getCoinIdBySymbol(UCT);
    const assets = await this.sphere.payments.getAssets();
    let total = 0n;
    for (const a of assets) {
      if (a.symbol === UCT || a.coinId === uctHex) {
        try { total += BigInt(a.confirmedAmount || a.totalAmount || '0'); } catch { /* ignore */ }
      }
    }
    return this.toHuman(total);
  }

  // ---- payment requests ----
  async requestPayment(fromNametag: string, human: string | number, message: string) {
    return this.sphere.payments.sendPaymentRequest(
      fromNametag.startsWith('@') ? fromNametag : `@${fromNametag}`,
      {
        amount: this.toSmallest(human),
        coinId: UCT,
        recipientNametag: this.nametag.replace(/^@/, ''),
        message,
      },
    );
  }
  async payRequest(requestId: string, memo?: string) {
    return this.sphere.payments.payPaymentRequest(requestId, memo);
  }
  onPaymentRequest(handler: (req: unknown) => void) {
    return this.sphere.payments.onPaymentRequest(handler as never);
  }
  onPaymentRequestResponse(handler: (res: unknown) => void) {
    return this.sphere.payments.onPaymentRequestResponse(handler as never);
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

  // ---- market & swap (nullable modules, enabled in start()) ----
  get market() {
    const m = this.sphere.market;
    if (!m) throw new Error(`[${this.name}] market module not enabled`);
    return m;
  }
  get swap() {
    const s = this.sphere.swap;
    if (!s) throw new Error(`[${this.name}] swap module not enabled`);
    return s;
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

/**
 * Sign-In-With-Wallet auth for the Unicity Arcade House.
 *
 * The wallet's chain key IS the player account — there are no passwords and the
 * house never holds keys. A login is a one-time challenge the player signs with
 * their Sphere wallet (the `sign_message` intent). The backend verifies the
 * secp256k1 signature against the claimed chain pubkey using the SDK's own
 * `verifySignedMessage`, then mints a short-lived, HMAC-signed session token.
 *
 * Why the arcade needs it: the write routes (/new, /play, /cashout, /table)
 * act on an `address`. Without a proof of ownership anyone could POST another
 * player's address — spending their deposited chips, forcing a cash-out, or
 * poisoning a bot persona's record. A bearer token binds every write to the
 * proven wallet behind it. The autonomous capsule is exempted separately with a
 * shared secret (it plays as its own personas, never as a human).
 *
 * Design notes:
 * - `chainPubkey` is the cryptographically-proven identity. `nametag` is a
 *   self-chosen display handle; it is never a fund-theft vector (payouts route
 *   to the address the player themselves proved, never to a claimed nametag).
 * - Nonces are single-use and short-lived; the signature verifier is injected
 *   so the crypto (SDK) can be swapped in tests.
 */
import crypto from 'node:crypto';
import { Logger, createLogger } from '@bazaar/core';

/** A proven arcade identity. `chainPubkey` is cryptographically verified. */
export interface Identity {
  /** 33-byte compressed secp256k1 pubkey, lowercase hex — the account id. */
  chainPubkey: string;
  /** The wallet's @nametag (display handle), if it has one. */
  nametag?: string;
}

/** A challenge the player must sign to prove control of a wallet. */
export interface Challenge {
  nonce: string;
  message: string;
  expiresAt: number;
}

/** Verifies a Sphere signed message — matches the SDK's `verifySignedMessage`. */
export type MessageVerifier = (message: string, signature: string, expectedPubkey: string) => boolean;

/** 33-byte compressed secp256k1 pubkey, hex (0x02/0x03 prefix + 64 hex chars). */
const CHAIN_PUBKEY_RE = /^0[23][0-9a-f]{64}$/;
const NAMETAG_RE = /^[a-zA-Z0-9._-]{2,64}$/;
const CHALLENGE_TTL_MS = 5 * 60_000;
const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60_000;

interface Pending {
  chainPubkey: string;
  message: string;
  expiresAt: number;
}

interface SessionClaims {
  v: 1;
  sub: string; // chainPubkey
  tag?: string; // nametag
  iat: number;
  exp: number;
}

export interface AuthServiceOptions {
  /** HMAC secret for session tokens. */
  sessionSecret: string;
  /** Verifies a signed challenge. Inject the SDK's `verifySignedMessage`. */
  verify: MessageVerifier;
  sessionTtlMs?: number;
  /** Human label shown in the challenge text (the dapp name / domain). */
  domain?: string;
  now?: () => number;
  logger?: Logger;
}

export class AuthService {
  private readonly secret: string;
  private readonly verify: MessageVerifier;
  private readonly sessionTtlMs: number;
  private readonly domain: string;
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly pending = new Map<string, Pending>();

  constructor(opts: AuthServiceOptions) {
    this.secret = opts.sessionSecret;
    this.verify = opts.verify;
    this.sessionTtlMs = opts.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.domain = opts.domain ?? 'Unicity Arcade House';
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.logger ?? createLogger('auth');
  }

  static normalizePubkey(pk: string): string {
    return pk.trim().toLowerCase();
  }

  /** Issue a fresh challenge for a wallet to sign. */
  issueChallenge(chainPubkey: string): Challenge {
    const pk = AuthService.normalizePubkey(chainPubkey);
    if (!CHAIN_PUBKEY_RE.test(pk)) throw new Error('a valid chain public key is required');
    this.sweep();
    const nonce = crypto.randomBytes(16).toString('hex');
    const issued = new Date(this.now()).toISOString();
    const expiresAt = this.now() + CHALLENGE_TTL_MS;
    const message = [
      `${this.domain} — sign in`,
      '',
      'Sign this message to prove you control this wallet.',
      'It authorizes nothing on-chain and moves no funds.',
      '',
      `wallet: ${pk}`,
      `nonce:  ${nonce}`,
      `issued: ${issued}`,
    ].join('\n');
    this.pending.set(nonce, { chainPubkey: pk, message, expiresAt });
    return { nonce, message, expiresAt };
  }

  /**
   * Verify a signed challenge and mint a session token. Single-use per nonce:
   * the nonce is consumed on the first attempt regardless of outcome.
   */
  login(input: { nonce: string; signature: string; nametag?: string }): { token: string; identity: Identity } {
    const pending = this.pending.get(input.nonce);
    if (pending) this.pending.delete(input.nonce);
    if (!pending) throw new Error('challenge not found or already used — request a new one');
    if (pending.expiresAt < this.now()) throw new Error('challenge expired — request a new one');
    const sig = (input.signature ?? '').trim();
    if (!sig) throw new Error('a signature is required');

    let ok = false;
    try {
      ok = this.verify(pending.message, sig, pending.chainPubkey);
    } catch (e) {
      this.log.warn('signature verification threw', e instanceof Error ? e.message : e);
      ok = false;
    }
    if (!ok) throw new Error('signature did not match the wallet — login rejected');

    const nametag = normalizeNametag(input.nametag);
    const identity: Identity = { chainPubkey: pending.chainPubkey, ...(nametag ? { nametag } : {}) };
    this.log.info(`login ok — ${principalOf(identity)}`);
    return { token: this.mintToken(identity), identity };
  }

  /** Verify a bearer token, returning the identity it encodes, or null. */
  verifySession(token: string | undefined | null): Identity | null {
    if (!token) return null;
    const dot = token.lastIndexOf('.');
    if (dot <= 0) return null;
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    if (!timingSafeEqualStr(sig, this.hmac(body))) return null;
    let claims: SessionClaims;
    try {
      claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionClaims;
    } catch {
      return null;
    }
    if (claims.v !== 1 || typeof claims.sub !== 'string') return null;
    if (typeof claims.exp !== 'number' || claims.exp < this.now()) return null;
    return { chainPubkey: claims.sub, ...(claims.tag ? { nametag: claims.tag } : {}) };
  }

  private mintToken(identity: Identity): string {
    const claims: SessionClaims = {
      v: 1,
      sub: identity.chainPubkey,
      ...(identity.nametag ? { tag: identity.nametag } : {}),
      iat: this.now(),
      exp: this.now() + this.sessionTtlMs,
    };
    const body = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
    return `${body}.${this.hmac(body)}`;
  }

  private hmac(body: string): string {
    return crypto.createHmac('sha256', this.secret).update(body).digest('base64url');
  }

  private sweep(): void {
    const now = this.now();
    for (const [nonce, p] of this.pending) {
      if (p.expiresAt < now) this.pending.delete(nonce);
    }
  }
}

export function normalizeNametag(tag: string | undefined | null): string | undefined {
  const t = (tag ?? '').trim().replace(/^@/, '');
  if (!t || !NAMETAG_RE.test(t)) return undefined;
  return t;
}

/** A short principal label for an identity (used only in logs). */
export function principalOf(identity: Identity): string {
  return identity.nametag ? `@${identity.nametag}` : identity.chainPubkey;
}

/**
 * True when `address` (as sent to a write route) belongs to the proven session.
 * The dashboard keys players by chain pubkey, so that is the primary match; a
 * `@nametag` is also accepted since the wallet may present either.
 */
export function addressMatchesIdentity(address: string | undefined, identity: Identity): boolean {
  const a = (address ?? '').trim();
  if (!a) return false;
  if (AuthService.normalizePubkey(a) === identity.chainPubkey) return true;
  const tag = normalizeNametag(a);
  return !!tag && !!identity.nametag && tag === identity.nametag;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

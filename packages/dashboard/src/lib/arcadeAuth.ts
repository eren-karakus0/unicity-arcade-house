/**
 * Sign-In-With-Wallet session for the arcade's write routes.
 *
 * The house never holds keys: a player proves control of their wallet by
 * signing a one-time server challenge (the Sphere `sign_message` intent). The
 * backend returns a short-lived bearer token that binds every play / cash-out
 * to the proven wallet — so nobody can act as another player's address.
 *
 * The signature is requested LAZILY, the first time a write actually needs it
 * (not on connect), and reused from localStorage until it expires — browsing
 * and reading never prompt a signature. `ensureSession()` de-dupes concurrent
 * callers so a burst of writes triggers at most one wallet approval.
 */
import { BACKEND_URL } from './backend';

const TOKEN_KEY = 'arcade-session-token';

interface Signer {
  chainPubkey: string;
  nametag?: string;
  signMessage: (message: string) => Promise<string>;
}

let signer: Signer | null = null;
let cachedToken: string | null = null;
let inflight: Promise<string | null> | null = null;

/** Decode our own token's claims (signed, not secret) to check expiry + owner. */
function decodeToken(token: string): { sub: string; exp: number } | null {
  try {
    const body = token.slice(0, token.lastIndexOf('.'));
    const pad = body.length % 4 === 0 ? '' : '='.repeat(4 - (body.length % 4));
    const json = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/') + pad)) as {
      sub?: string;
      exp?: number;
    };
    if (!json.sub || typeof json.exp !== 'number') return null;
    return { sub: json.sub, exp: json.exp };
  } catch {
    return null;
  }
}

/** True when `token` is well-formed, unexpired, and belongs to `pubkey`. */
function tokenValidFor(token: string | null, pubkey: string): token is string {
  if (!token) return false;
  const d = decodeToken(token);
  // 20s skew guard so a token about to lapse isn't sent on a slow request.
  return !!d && d.sub === pubkey.toLowerCase() && d.exp > Date.now() + 20_000;
}

/**
 * Register the connected wallet as the signer. Called when the wallet connects;
 * safe to call repeatedly. Switching to a different wallet drops the old token.
 */
export function registerSigner(
  identity: { chainPubkey?: string; nametag?: string } | null,
  signMessage: (message: string) => Promise<string>,
): void {
  const pk = identity?.chainPubkey?.trim().toLowerCase();
  if (!pk) {
    clearSigner();
    return;
  }
  if (signer && signer.chainPubkey !== pk) {
    // A different wallet — forget the previous session entirely.
    cachedToken = null;
    inflight = null;
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
  }
  signer = { chainPubkey: pk, nametag: identity?.nametag, signMessage };
  if (!cachedToken) {
    try {
      const stored = localStorage.getItem(TOKEN_KEY);
      if (tokenValidFor(stored, pk)) cachedToken = stored;
    } catch {
      /* storage unavailable — sign on demand */
    }
  }
}

/** Forget the signer and any session (call on wallet disconnect). */
export function clearSigner(): void {
  signer = null;
  cachedToken = null;
  inflight = null;
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

async function jsonPost<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${BACKEND_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const d = (await r.json()) as T & { error?: string };
  if (!r.ok || d.error) throw new Error(d.error ?? 'request failed');
  return d;
}

async function mintSession(s: Signer): Promise<string> {
  const chal = await jsonPost<{ nonce: string; message: string }>('/api/arcade/auth/challenge', {
    chainPubkey: s.chainPubkey,
  });
  const signature = await s.signMessage(chal.message); // wallet approval UI
  const { token } = await jsonPost<{ token: string }>('/api/arcade/auth/login', {
    nonce: chal.nonce,
    signature,
    ...(s.nametag ? { nametag: s.nametag } : {}),
  });
  cachedToken = token;
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* storage unavailable — keep it in memory for this session */
  }
  return token;
}

/**
 * Return a valid bearer token, minting one (one wallet signature) if needed.
 * NEVER throws: returns null when there is no signer, when the wallet declines
 * to sign, or when the auth endpoint is unavailable (e.g. a backend that predates
 * this feature). The backend is the single source of truth — an unauthenticated
 * write simply gets rejected there with a clear message. This keeps the dashboard
 * fully backward-compatible so it can ship ahead of the backend. Concurrent
 * callers share a single in-flight sign.
 */
export function ensureSession(): Promise<string | null> {
  const s = signer;
  if (!s) return Promise.resolve(null);
  if (tokenValidFor(cachedToken, s.chainPubkey)) return Promise.resolve(cachedToken);
  if (!inflight) {
    inflight = mintSession(s)
      .catch(() => null) // declined / offline / not-yet-deployed — let the backend decide
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/**
 * A wallet's own free-plan aggregator key from the subscription gateway (SGW).
 *
 * The public testnet2 key is shared by every example wallet, and so is its rate
 * limit — the house, which mints and pays all day, spent months contending for
 * it. The SGW hands each wallet its own key through a challenge the wallet
 * signs (the flow the Sphere wallet itself uses). It is get-or-create by the
 * wallet's index-0 key, so asking again on every boot returns the same key.
 */
import { getPublicKey, signMessage } from '@unicitylabs/sphere-sdk';

export const SGW_CHALLENGE_PREFIX = 'unicity:sgw:auth:v1\n';
const SGW_REQUEST_TIMEOUT_MS = 10_000;
/** The gateway's own challenges live an hour at most; anything wider is not one of them. */
const MAX_CHALLENGE_VALIDITY_MS = 60 * 60_000;
const CHALLENGE_FIELDS = ['network', 'pubkey', 'nonce', 'issuedAt', 'expiresAt'] as const;

export interface GatewayKey {
  apiKey: string;
  plan: string;
  created: boolean;
}

export interface GatewayKeyRequest {
  /** SGW base URL — the network's aggregator URL (`NETWORKS[network].aggregatorUrl`). */
  gatewayUrl: string;
  network: string;
  /** The wallet's index-0 private key (hex); it signs the challenge locally. */
  privateKeyHex: string;
  fetchImpl?: typeof fetch;
}

/**
 * Refuse to sign server-chosen text we have not checked. The payload binds the
 * network so a challenge from another network's gateway cannot harvest a key
 * there; timestamps are compared only with each other, never with the local
 * clock, so a skewed host cannot lock itself out.
 *
 * @throws Error naming the first check the challenge failed.
 */
export function verifySgwChallenge(challenge: string, expect: { network: string; pubkey: string; nonce: string }): void {
  if (!challenge.startsWith(SGW_CHALLENGE_PREFIX)) throw new Error('SGW challenge rejected: unexpected prefix');
  const body = challenge.slice(SGW_CHALLENGE_PREFIX.length);
  if (body.includes('\n')) throw new Error('SGW challenge rejected: payload must be single-line');

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error('SGW challenge rejected: payload is not JSON');
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('SGW challenge rejected: payload is not an object');
  }
  const fields = payload as Record<string, unknown>;
  for (const f of CHALLENGE_FIELDS) {
    if (typeof fields[f] !== 'string' || fields[f] === '') throw new Error(`SGW challenge rejected: missing ${f}`);
  }
  const p = fields as Record<(typeof CHALLENGE_FIELDS)[number], string>;
  if (p.network.toLowerCase() !== expect.network.toLowerCase()) throw new Error('SGW challenge rejected: network mismatch');
  if (p.pubkey.toLowerCase() !== expect.pubkey.toLowerCase()) throw new Error('SGW challenge rejected: pubkey mismatch');
  if (p.nonce !== expect.nonce) throw new Error('SGW challenge rejected: nonce mismatch');

  const issuedAt = Date.parse(p.issuedAt);
  const expiresAt = Date.parse(p.expiresAt);
  if (Number.isNaN(issuedAt) || Number.isNaN(expiresAt)) throw new Error('SGW challenge rejected: unparseable timestamps');
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_CHALLENGE_VALIDITY_MS) {
    throw new Error('SGW challenge rejected: implausible validity window');
  }
}

/**
 * Get (or create) this wallet's own gateway key.
 *
 * @throws Error when the gateway is unreachable, answers non-2xx, times out, or
 *   sends a challenge that fails {@link verifySgwChallenge}.
 */
export async function provisionGatewayKey(req: GatewayKeyRequest): Promise<GatewayKey> {
  const fetchImpl = req.fetchImpl ?? fetch;
  const pubkey = getPublicKey(req.privateKeyHex);
  const postJson = async (path: string, body: unknown): Promise<unknown> => {
    const res = await fetchImpl(`${req.gatewayUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SGW_REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`SGW ${path} answered HTTP ${res.status}`);
    return res.json();
  };

  const { nonce, challenge } = (await postJson('/auth/challenge', { pubkey })) as { nonce: string; challenge: string };
  verifySgwChallenge(challenge, { network: req.network, pubkey, nonce });
  const key = (await postJson('/auth/verify', { nonce, signature: signMessage(req.privateKeyHex, challenge) })) as GatewayKey;
  if (typeof key?.apiKey !== 'string' || key.apiKey === '') throw new Error('SGW /auth/verify returned no apiKey');
  return key;
}

import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getPublicKey, verifySignedMessage } from '@unicitylabs/sphere-sdk';
import { SGW_CHALLENGE_PREFIX, provisionGatewayKey, verifySgwChallenge } from './gateway-key.js';

const privateKeyHex = randomBytes(32).toString('hex');
const pubkey = getPublicKey(privateKeyHex);
const HOUR_MS = 60 * 60_000;

const challengeFor = (overrides: Record<string, string> = {}, prefix = SGW_CHALLENGE_PREFIX) => {
  const issued = Date.parse('2026-09-29T10:00:00Z');
  const payload = {
    network: 'testnet2',
    pubkey,
    nonce: 'n-1',
    issuedAt: new Date(issued).toISOString(),
    expiresAt: new Date(issued + 5 * 60_000).toISOString(),
    ...overrides,
  };
  return `${prefix}${JSON.stringify(payload)}`;
};
const expected = { network: 'testnet2', pubkey, nonce: 'n-1' };

describe('verifySgwChallenge', () => {
  it('accepts a challenge issued for this wallet on this network', () => {
    expect(() => verifySgwChallenge(challengeFor(), expected)).not.toThrow();
  });

  it.each([
    ['another network', challengeFor({ network: 'mainnet' }), /network mismatch/],
    ['another wallet', challengeFor({ pubkey: `02${'ab'.repeat(32)}` }), /pubkey mismatch/],
    ['another nonce', challengeFor({ nonce: 'n-2' }), /nonce mismatch/],
    ['a foreign prefix', challengeFor({}, 'unicity:other:v1\n'), /unexpected prefix/],
    ['a multi-line payload', `${SGW_CHALLENGE_PREFIX}{"a":1}\n{"b":2}`, /single-line/],
    ['a payload that is not JSON', `${SGW_CHALLENGE_PREFIX}not json`, /not JSON/],
    ['a missing field', challengeFor({ nonce: '' }), /missing nonce/],
    [
      'a validity window wider than an hour',
      challengeFor({ expiresAt: new Date(Date.parse('2026-09-29T10:00:00Z') + HOUR_MS + 1).toISOString() }),
      /implausible validity window/,
    ],
    ['an expiry before issue', challengeFor({ expiresAt: '2026-09-29T09:00:00Z' }), /implausible validity window/],
  ])('refuses %s', (_label, challenge, error) => {
    expect(() => verifySgwChallenge(challenge, expected)).toThrow(error);
  });
});

describe('provisionGatewayKey', () => {
  /** A stand-in SGW: serves `challenge`, records what the wallet sends to /auth/verify. */
  const fakeGateway = (challenge: string, verifyStatus = 200) => {
    const calls: { path: string; body: Record<string, string> }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      calls.push({ path, body });
      if (path === '/auth/challenge') return Response.json({ nonce: 'n-1', challenge });
      return Response.json({ apiKey: 'sk_own', plan: 'free', created: true }, { status: verifyStatus });
    }) as typeof fetch;
    return { fetchImpl, calls };
  };
  const request = (fetchImpl: typeof fetch) => ({
    gatewayUrl: 'https://gateway.example',
    network: 'testnet2',
    privateKeyHex,
    fetchImpl,
  });

  it('returns the key after signing the verified challenge with the wallet key', async () => {
    const challenge = challengeFor();
    const { fetchImpl, calls } = fakeGateway(challenge);

    const key = await provisionGatewayKey(request(fetchImpl));

    expect(key).toEqual({ apiKey: 'sk_own', plan: 'free', created: true });
    expect(calls[0]).toEqual({ path: '/auth/challenge', body: { pubkey } });
    const signed = calls[1]!.body;
    expect(signed.nonce).toBe('n-1');
    expect(verifySignedMessage(challenge, signed.signature!, pubkey)).toBe(true);
  });

  it('never signs a challenge issued for another network', async () => {
    const { fetchImpl, calls } = fakeGateway(challengeFor({ network: 'mainnet' }));

    await expect(provisionGatewayKey(request(fetchImpl))).rejects.toThrow(/network mismatch/);
    expect(calls.map((c) => c.path)).toEqual(['/auth/challenge']);
  });

  it('fails loudly when the gateway refuses the signature', async () => {
    const { fetchImpl } = fakeGateway(challengeFor(), 401);

    await expect(provisionGatewayKey(request(fetchImpl))).rejects.toThrow(/HTTP 401/);
  });
});

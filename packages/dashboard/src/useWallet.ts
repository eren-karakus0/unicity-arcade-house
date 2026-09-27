import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ConnectClient,
  ERROR_CODES,
  SPHERE_NETWORKS,
  HOST_READY_TYPE,
  HOST_READY_TIMEOUT,
} from '@unicitylabs/sphere-sdk/connect';
import { PostMessageTransport } from '@unicitylabs/sphere-sdk/connect/browser';
import type { ConnectTransport, PublicIdentity } from '@unicitylabs/sphere-sdk/connect';

const WALLET_URL = 'https://sphere.unicity.network';
const SESSION_KEY = 'sphere-connect-session';
// The public identity is persisted so the user stays logged in across page
// refreshes without re-opening the wallet popup. Deposits DO go through the
// wallet's own approval UI (send intent) — the dapp never holds keys.
const IDENTITY_KEY = 'sphere-connect-identity';

const DAPP = {
  name: 'Unicity Arcade House',
  description: 'Provably-fair games vs an autonomous house — win real testnet UCT on-chain',
  url: typeof location !== 'undefined' ? location.origin : 'https://unicity-arcade-house.vercel.app',
  icon: '/icon.svg',
};

/**
 * Turn a failed handshake into something the player can act on. The wallet
 * keeps mainnet and testnet apart with no in-session switch, so a wallet left
 * on mainnet refuses this testnet dapp — and the raw refusal does not say how
 * to fix it. The code is read structurally: bundles can carry their own copy of
 * ConnectError, so `instanceof` is not reliable.
 */
function describeConnectFailure(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === ERROR_CODES.INCOMPATIBLE_NETWORK) {
    return 'Your Sphere wallet is on another network. The arcade runs on testnet — switch the wallet to testnet and connect again.';
  }
  if (code === ERROR_CODES.UNSUPPORTED_PROTOCOL_VERSION) {
    return 'The wallet refused this app as out of date. Please reload the page; if it persists the arcade needs an update.';
  }
  return e instanceof Error ? e.message : 'Connection failed';
}

/**
 * Wait for the wallet popup to post HOST_READY before we send the handshake —
 * otherwise the connect message races ahead of the wallet's listener and is
 * dropped (popup opens but never shows the approval UI).
 */
function waitForHostReady(timeoutMs = HOST_READY_TIMEOUT): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener('message', handler);
      reject(new Error('Wallet did not become ready — make sure you are signed in to your Sphere wallet.'));
    }, timeoutMs);
    function handler(event: MessageEvent) {
      if ((event.data as { type?: string })?.type === HOST_READY_TYPE) {
        clearTimeout(timer);
        window.removeEventListener('message', handler);
        resolve();
      }
    }
    window.addEventListener('message', handler);
  });
}

/** The wallet's `sign_message` intent result is wallet-defined; normalize it to the signature string. */
function extractSignature(result: unknown): string {
  if (typeof result === 'string') return result.trim();
  if (result && typeof result === 'object') {
    const o = result as Record<string, unknown>;
    for (const key of ['signature', 'sig', 'result', 'signedMessage']) {
      const v = o[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  throw new Error('The wallet returned an unexpected sign-message response.');
}

export type WalletStatus = 'idle' | 'connecting' | 'connected' | 'error';

export interface WalletState {
  status: WalletStatus;
  identity: PublicIdentity | null;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  /**
   * Ask the wallet to send a real transfer (opens its approval UI).
   * `amountBase` is a positive integer string in the coin's base units.
   */
  deposit: (params: { to: string; amountBase: string; coinId: string }) => Promise<void>;
  /** Sign a plain message (Sign-In-With-Wallet); opens the wallet approval UI. */
  signMessage: (message: string) => Promise<string>;
}

export function useWallet(): WalletState {
  const [status, setStatus] = useState<WalletStatus>('idle');
  const [identity, setIdentity] = useState<PublicIdentity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const clientRef = useRef<ConnectClient | null>(null);
  const transportRef = useRef<ConnectTransport | null>(null);
  const popupRef = useRef<Window | null>(null);

  // Restore a previous login on refresh so the user stays connected.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(IDENTITY_KEY);
      if (raw) {
        setIdentity(JSON.parse(raw) as PublicIdentity);
        setStatus('connected');
      }
    } catch {
      /* corrupt / unavailable storage — ignore */
    }
  }, []);

  /**
   * Get a LIVE ConnectClient session — reuses the current one when its
   * transport is still alive, otherwise opens the wallet popup and handshakes
   * (resuming the previous session skips the approval screen). Popup only: the
   * browser extension is discontinued and no supported wallet answers it, so a
   * leftover install would otherwise capture the connection and hang it.
   */
  const openClient = useCallback(async (): Promise<ConnectClient> => {
    const alive =
      clientRef.current?.isConnected && (!popupRef.current || popupRef.current.closed === false);
    if (alive) return clientRef.current!;

    const popup = window.open(
      `${WALLET_URL}/connect?origin=${encodeURIComponent(location.origin)}`,
      'sphere-connect',
      'width=440,height=680',
    );
    if (!popup) throw new Error('Popup blocked — please allow popups for this site.');
    popupRef.current = popup;
    const transport: ConnectTransport = PostMessageTransport.forClient({ target: popup, targetOrigin: WALLET_URL });
    transportRef.current = transport;

    // The fix: let the popup announce it is listening before handshaking.
    await waitForHostReady();

    const resumeSessionId = sessionStorage.getItem(SESSION_KEY) ?? undefined;
    const client = new ConnectClient({
      transport,
      dapp: DAPP,
      network: SPHERE_NETWORKS.testnet2,
      ...(resumeSessionId ? { resumeSessionId } : {}),
    });
    clientRef.current = client;

    let result: Awaited<ReturnType<ConnectClient['connect']>>;
    try {
      result = await client.connect();
    } catch (e) {
      // Every entry point (connect, deposit, sign-in) handshakes here, so the
      // refusal is translated once for all of them.
      throw new Error(describeConnectFailure(e), { cause: e });
    }
    sessionStorage.setItem(SESSION_KEY, result.sessionId);
    try {
      localStorage.setItem(IDENTITY_KEY, JSON.stringify(result.identity));
    } catch {
      /* storage unavailable — non-fatal, connection still works this session */
    }
    setIdentity(result.identity);
    setStatus('connected');
    return client;
  }, []);

  const connect = useCallback(async () => {
    setStatus('connecting');
    setError(null);
    try {
      await openClient();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Connection failed');
      setStatus('error');
    }
  }, [openClient]);

  /** Real wallet transfer via the Sphere Connect `send` intent (user approves in the wallet UI). */
  const deposit = useCallback(
    async (params: { to: string; amountBase: string; coinId: string }) => {
      const client = await openClient();
      await client.intent('send', {
        to: params.to,
        amount: params.amountBase,
        coinId: params.coinId,
      });
    },
    [openClient],
  );

  /** Sign-In-With-Wallet: prove wallet control by signing a server challenge. */
  const signMessage = useCallback(
    async (message: string): Promise<string> => {
      const client = await openClient();
      const result = await client.intent('sign_message', { message });
      return extractSignature(result);
    },
    [openClient],
  );

  const disconnect = useCallback(async () => {
    try {
      await clientRef.current?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      transportRef.current?.destroy();
    } catch {
      /* ignore */
    }
    try {
      popupRef.current?.close();
    } catch {
      /* ignore */
    }
    sessionStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(IDENTITY_KEY);
    clientRef.current = null;
    transportRef.current = null;
    popupRef.current = null;
    setIdentity(null);
    setStatus('idle');
  }, []);

  return { status, identity, error, connect, disconnect, deposit, signMessage };
}

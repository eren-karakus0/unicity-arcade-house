import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ConnectClient,
  SPHERE_NETWORKS,
  HOST_READY_TYPE,
  HOST_READY_TIMEOUT,
} from '@unicitylabs/sphere-sdk/connect';
import { PostMessageTransport, ExtensionTransport } from '@unicitylabs/sphere-sdk/connect/browser';
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

/** True when the Sphere browser extension is installed. */
function hasExtension(): boolean {
  try {
    const s = (window as unknown as { sphere?: { isInstalled?: () => boolean } }).sphere;
    return !!s && typeof s.isInstalled === 'function' && s.isInstalled() === true;
  } catch {
    return false;
  }
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
   * transport is still alive, otherwise opens the wallet (popup/extension) and
   * handshakes (resuming the previous session skips the approval screen).
   */
  const openClient = useCallback(async (): Promise<ConnectClient> => {
    const alive =
      clientRef.current?.isConnected && (!popupRef.current || popupRef.current.closed === false);
    if (alive) return clientRef.current!;

    let transport: ConnectTransport;
    let isPopup = false;

    if (hasExtension()) {
      transport = ExtensionTransport.forClient();
    } else {
      const popup = window.open(
        `${WALLET_URL}/connect?origin=${encodeURIComponent(location.origin)}`,
        'sphere-connect',
        'width=440,height=680',
      );
      if (!popup) throw new Error('Popup blocked — please allow popups for this site.');
      popupRef.current = popup;
      transport = PostMessageTransport.forClient({ target: popup, targetOrigin: WALLET_URL });
      isPopup = true;
    }
    transportRef.current = transport;

    // The fix: let the popup announce it is listening before handshaking.
    if (isPopup) await waitForHostReady();

    const resumeSessionId = sessionStorage.getItem(SESSION_KEY) ?? undefined;
    const client = new ConnectClient({
      transport,
      dapp: DAPP,
      network: SPHERE_NETWORKS.testnet2,
      ...(resumeSessionId ? { resumeSessionId } : {}),
    });
    clientRef.current = client;

    const result = await client.connect();
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

  return { status, identity, error, connect, disconnect, deposit };
}

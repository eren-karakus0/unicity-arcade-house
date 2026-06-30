import { useCallback, useRef, useState } from 'react';
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

const DAPP = {
  name: 'Sphere Agent Bazaar',
  description: 'Autonomous agent marketplace — repo-risk analysis on Unicity',
  url: typeof location !== 'undefined' ? location.origin : 'https://sphere-agent-bazaar-dashboard.vercel.app',
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
}

export function useWallet(): WalletState {
  const [status, setStatus] = useState<WalletStatus>('idle');
  const [identity, setIdentity] = useState<PublicIdentity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const clientRef = useRef<ConnectClient | null>(null);
  const transportRef = useRef<ConnectTransport | null>(null);
  const popupRef = useRef<Window | null>(null);

  const connect = useCallback(async () => {
    setStatus('connecting');
    setError(null);
    try {
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
      setIdentity(result.identity);
      setStatus('connected');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Connection failed');
      setStatus('error');
    }
  }, []);

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
    clientRef.current = null;
    transportRef.current = null;
    popupRef.current = null;
    setIdentity(null);
    setStatus('idle');
  }, []);

  return { status, identity, error, connect, disconnect };
}

import type { SearchIntentResult } from '@unicitylabs/sphere-sdk';
import type { SphereAgent } from './sphere-agent.js';
import type { BazaarMessage, ServiceListing } from './types.js';
import { parseBazaarMessage } from './types.js';

/** Minimal shape of an incoming Nostr DM that we rely on. */
export interface IncomingBazaarDM {
  content?: string;
  senderNametag?: string;
  senderPubkey?: string;
}

/** Publish a provider's service offer to the market as a `service` intent. */
export async function postServiceListing(
  agent: SphereAgent,
  listing: ServiceListing,
  opts: { expiresInDays?: number } = {},
) {
  return agent.market.postIntent({
    description: `[${listing.service}] ${listing.description}`,
    intentType: 'service',
    category: listing.service,
    price: Number(listing.priceUct),
    currency: listing.currency,
    contactHandle: listing.providerNametag,
    expiresInDays: opts.expiresInDays ?? 7,
  });
}

/** Semantic search of the market for provider service offers. */
export async function searchServices(
  agent: SphereAgent,
  query: string,
  opts: { limit?: number } = {},
): Promise<SearchIntentResult[]> {
  const res = await agent.market.search(query, {
    filters: { intentType: 'service' },
    limit: opts.limit ?? 10,
  });
  return res.intents;
}

/** Send a typed bazaar protocol message over a Nostr DM. */
export async function sendBazaarMessage(agent: SphereAgent, to: string, msg: BazaarMessage) {
  return agent.dm(to, JSON.stringify(msg));
}

/** Subscribe to incoming bazaar protocol messages (ignores non-protocol DMs). */
export function onBazaarMessage(
  agent: SphereAgent,
  handler: (msg: BazaarMessage, dm: IncomingBazaarDM) => void,
): () => void {
  return agent.onDM((raw: unknown) => {
    const dm = (raw ?? {}) as IncomingBazaarDM;
    if (!dm.content) return;
    const msg = parseBazaarMessage(dm.content);
    if (msg) handler(msg, dm);
  });
}

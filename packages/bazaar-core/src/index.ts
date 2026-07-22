// @bazaar/core — shared library for the Sphere Agent Bazaar.
export * from './config.js';
export * from './logger.js';
export * from './types.js';
export * from './sphere-agent.js';
export * from './bazaar-protocol.js';
export * from './events.js';
export * from './analyst-service.js';
export * from './scout-client.js';
export * from './llm.js';
export * from './analysis/index.js';
export * from './arcade/index.js';

// Sign-In-With-Wallet crypto (secp256k1 over a Sphere signed message).
// Re-exported so the backend's AuthService can verify challenges — and tests can
// forge signatures — without taking a direct dependency on the SDK.
export { verifySignedMessage, signMessage, getPublicKey, randomHex } from '@unicitylabs/sphere-sdk';

export const BAZAAR_CORE_VERSION = '0.1.0';

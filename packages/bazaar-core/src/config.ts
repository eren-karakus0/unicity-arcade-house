import { config as loadDotenv } from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// SDK 0.16 dropped the v1 `dev` network; these are the networks it still runs.
const NETWORKS = ['mainnet', 'testnet', 'testnet2'] as const;
export type NetworkType = (typeof NETWORKS)[number];

/** @throws Error when SPHERE_NETWORK names a network the SDK does not run. */
function parseNetwork(raw: string | undefined): NetworkType {
  if (raw === undefined) return 'testnet2';
  if ((NETWORKS as readonly string[]).includes(raw)) return raw as NetworkType;
  throw new Error(`SPHERE_NETWORK=${raw} is not one of ${NETWORKS.join(', ')}`);
}

/** Public testnet2 gateway key (NOT a secret — documented in the SDK README). */
export const PUBLIC_TESTNET2_KEY = 'sk_ddc3cfcc001e4a28ac3fad7407f99590';
export const DEFAULT_WALLET_API_URL = 'https://wallet-api.unicity.network';

export interface AgentIdentityEnv {
  nametag: string;
  mnemonic?: string;
}

export interface BazaarEnv {
  network: NetworkType;
  oracleApiKey: string;
  walletApiUrl: string;
  analyst: AgentIdentityEnv;
  alphascout: AgentIdentityEnv;
  gemini: { apiKey?: string; model: string };
  githubToken?: string;
  /** Absolute path to the shared <repoRoot>/data directory. */
  dataRoot: string;
}

/** Walk up from `start` until a directory containing pnpm-workspace.yaml is found. */
export function findRepoRoot(start: string): string {
  let dir = start;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = path.dirname(dir);
  }
  return start;
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = findRepoRoot(moduleDir);

// Load .env from the repo root regardless of which package's cwd we run from.
loadDotenv({ path: path.join(repoRoot, '.env') });

export function loadEnv(): BazaarEnv {
  const clean = (v: string | undefined): string | undefined => {
    const t = v?.trim();
    return t && t.length > 0 ? t : undefined;
  };

  return {
    network: parseNetwork(clean(process.env.SPHERE_NETWORK)),
    oracleApiKey: clean(process.env.SPHERE_ORACLE_API_KEY) ?? PUBLIC_TESTNET2_KEY,
    walletApiUrl: clean(process.env.SPHERE_WALLET_API_URL) ?? DEFAULT_WALLET_API_URL,
    analyst: {
      nametag: clean(process.env.ANALYST_NAMETAG) ?? 'analyst-knkchn',
      mnemonic: clean(process.env.ANALYST_MNEMONIC),
    },
    alphascout: {
      nametag: clean(process.env.ALPHASCOUT_NAMETAG) ?? 'alphascout-knkchn',
      mnemonic: clean(process.env.ALPHASCOUT_MNEMONIC),
    },
    gemini: {
      apiKey: clean(process.env.GEMINI_API_KEY),
      model: clean(process.env.GEMINI_MODEL) ?? 'gemini-2.0-flash',
    },
    githubToken: clean(process.env.GITHUB_TOKEN),
    dataRoot: path.join(repoRoot, 'data'),
  };
}

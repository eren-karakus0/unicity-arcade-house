import type { RepoRef } from './repo-url.js';

/**
 * Free dependency-vulnerability scanning via OSV.dev (no API key).
 *
 * We scan only PRODUCTION `dependencies` (dev/build tooling doesn't ship, and
 * scanning it wildly over-penalizes healthy repos), and weight findings by their
 * actual severity rather than treating every advisory the same.
 */
export interface NpmDep {
  name: string;
  version: string;
}

export type Severity = 'critical' | 'high' | 'moderate' | 'low' | 'unknown';
const SEV_ORDER: Severity[] = ['critical', 'high', 'moderate', 'low', 'unknown'];
const SEV_WEIGHT: Record<Severity, number> = { critical: 10, high: 6, moderate: 3, low: 1, unknown: 2 };

export interface OsvScan {
  prodDeps: number;
  vulnerableDeps: number;
  counts: Record<Severity, number>;
  weight: number;
  sampleIds: string[];
}

export function cleanVersion(range: string): string | null {
  const m = range.match(/\d+\.\d+\.\d+/);
  return m ? m[0] : null;
}

/** Parse npm deps. Production `dependencies` only unless `includeDev` is set. */
export function parseNpmManifest(pkgJson: string, opts: { includeDev?: boolean } = {}): NpmDep[] {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(pkgJson) as Record<string, unknown>;
  } catch {
    return [];
  }
  const fields = opts.includeDev ? (['dependencies', 'devDependencies'] as const) : (['dependencies'] as const);
  const deps: NpmDep[] = [];
  for (const field of fields) {
    const obj = json[field];
    if (obj && typeof obj === 'object') {
      for (const [name, range] of Object.entries(obj as Record<string, string>)) {
        const version = cleanVersion(String(range));
        if (version) deps.push({ name, version });
      }
    }
  }
  return deps;
}

export async function fetchNpmManifest(ref: RepoRef, token?: string): Promise<NpmDep[] | null> {
  const res = await fetch(
    `https://api.github.com/repos/${ref.owner}/${ref.repo}/contents/package.json`,
    {
      headers: {
        Accept: 'application/vnd.github.raw+json',
        'User-Agent': 'sphere-agent-bazaar',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    },
  );
  if (!res.ok) return null; // no manifest at repo root (non-npm or monorepo)
  return parseNpmManifest(await res.text());
}

/** OSV batch query; returns, per input dep, the list of advisory ids affecting it. */
export async function queryOsvBatch(deps: NpmDep[]): Promise<string[][]> {
  if (deps.length === 0) return [];
  const res = await fetch('https://api.osv.dev/v1/querybatch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      queries: deps.map((d) => ({ package: { name: d.name, ecosystem: 'npm' }, version: d.version })),
    }),
  });
  if (!res.ok) return deps.map(() => []);
  const data = (await res.json()) as { results?: { vulns?: { id: string }[] }[] };
  return (data.results ?? []).map((r) => (r.vulns ?? []).map((v) => v.id));
}

/** Look up a single advisory's severity from OSV. */
export async function fetchSeverity(id: string): Promise<Severity> {
  try {
    const res = await fetch(`https://api.osv.dev/v1/vulns/${id}`);
    if (!res.ok) return 'unknown';
    const v = (await res.json()) as {
      database_specific?: { severity?: string };
      severity?: { type?: string; score?: string }[];
    };
    const ds = v.database_specific?.severity?.toLowerCase();
    if (ds === 'critical' || ds === 'high' || ds === 'moderate' || ds === 'low') return ds;
    const cvss = v.severity?.find((s) => s.type?.toUpperCase().startsWith('CVSS'))?.score;
    const num = cvss != null ? Number(cvss) : NaN;
    if (!Number.isNaN(num)) return num >= 9 ? 'critical' : num >= 7 ? 'high' : num >= 4 ? 'moderate' : 'low';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/** End-to-end CVE scan of production deps; null when there is no npm manifest. */
export async function scanDependencies(ref: RepoRef, token?: string): Promise<OsvScan | null> {
  const manifest = await fetchNpmManifest(ref, token);
  if (!manifest || manifest.length === 0) return null;

  const perDep = await queryOsvBatch(manifest.slice(0, 300));
  const counts: Record<Severity, number> = { critical: 0, high: 0, moderate: 0, low: 0, unknown: 0 };
  const sampleIds: string[] = [];
  const cache = new Map<string, Severity>();
  let vulnerableDeps = 0;
  let lookups = 0;
  const MAX_LOOKUPS = 30;

  for (const ids of perDep) {
    if (ids.length === 0) continue;
    vulnerableDeps++;
    let depSev: Severity = 'unknown';
    for (const id of ids) {
      if (sampleIds.length < 6) sampleIds.push(id);
      let sev: Severity = 'unknown';
      if (cache.has(id)) sev = cache.get(id) ?? 'unknown';
      else if (lookups < MAX_LOOKUPS) {
        sev = await fetchSeverity(id);
        cache.set(id, sev);
        lookups++;
      }
      if (SEV_ORDER.indexOf(sev) < SEV_ORDER.indexOf(depSev)) depSev = sev;
    }
    counts[depSev]++;
  }

  const weight = Math.min(
    40,
    counts.critical * SEV_WEIGHT.critical +
      counts.high * SEV_WEIGHT.high +
      counts.moderate * SEV_WEIGHT.moderate +
      counts.low * SEV_WEIGHT.low +
      counts.unknown * SEV_WEIGHT.unknown,
  );

  return { prodDeps: manifest.length, vulnerableDeps, counts, weight, sampleIds };
}

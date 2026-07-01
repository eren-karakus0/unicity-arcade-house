/* eslint-disable @typescript-eslint/no-explicit-any -- interfaces with untyped GitHub/OSV JSON */
/**
 * Vercel serverless function — lets a visitor run the Repo Risk Analyst's logic
 * on any GitHub repo, instantly, without the agent network being online.
 *
 * Self-contained on purpose (no workspace imports) so it bundles cleanly as an
 * edge/Node function. It mirrors packages/analyst-agent's analyzer.
 *
 *   GET /api/analyze?repo=<owner/repo | github url>
 */

const ALLOWED_HOSTS = new Set(['github.com', 'www.github.com']);
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

interface RepoRef {
  owner: string;
  repo: string;
}

// --- SSRF-guarded repo parsing (mirrors analysis/repo-url.ts) ---
function parseRepo(input: string): RepoRef {
  const raw = (input ?? '').trim();
  if (!raw) throw new Error('Enter a repo, e.g. facebook/react');
  let owner: string | undefined;
  let repo: string | undefined;
  if (!raw.includes('://') && /^[^/\s]+\/[^/\s]+$/.test(raw)) {
    [owner, repo] = raw.split('/');
  } else {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Unsupported URL');
    if (!ALLOWED_HOSTS.has(u.hostname.toLowerCase())) throw new Error('Only github.com repos are supported');
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length < 2) throw new Error('That is not a repository URL');
    [owner, repo] = parts;
  }
  repo = repo?.replace(/\.git$/, '');
  if (!owner || !repo || !NAME.test(owner) || !NAME.test(repo)) throw new Error('Invalid owner/repo');
  return { owner, repo };
}

type RiskBand = 'low' | 'medium' | 'high' | 'critical';
interface RiskSignal {
  name: string;
  detail: string;
  weight: number;
}

const gh = (token?: string) => ({
  Accept: 'application/vnd.github+json',
  'User-Agent': 'sphere-agent-bazaar',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});

function daysSince(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : Math.floor((now - t) / 86_400_000);
}
function bandFor(score: number): RiskBand {
  if (score >= 70) return 'critical';
  if (score >= 45) return 'high';
  if (score >= 20) return 'medium';
  return 'low';
}

async function analyze(ref: RepoRef, token?: string) {
  const metaRes = await fetch(`https://api.github.com/repos/${ref.owner}/${ref.repo}`, { headers: gh(token) });
  if (metaRes.status === 404) throw new Error(`Repo not found: ${ref.owner}/${ref.repo}`);
  if (metaRes.status === 403) throw new Error('GitHub rate limit hit — try again shortly.');
  if (!metaRes.ok) throw new Error(`GitHub API error ${metaRes.status}`);
  const m = (await metaRes.json()) as Record<string, any>;
  const now = Date.now();

  const signals: RiskSignal[] = [];
  const add = (name: string, detail: string, weight: number) => signals.push({ name, detail, weight });

  if (m.archived) add('archived', 'repository is archived (read-only, unmaintained)', 30);
  if (m.disabled) add('disabled', 'repository is disabled by GitHub', 25);
  const stale = daysSince(m.pushed_at ?? null, now);
  if (stale != null) {
    if (stale > 730) add('stale-2y', `no pushes in ${stale} days`, 30);
    else if (stale > 365) add('stale-1y', `no pushes in ${stale} days`, 20);
    else if (stale > 180) add('stale-6m', `no pushes in ${stale} days`, 10);
  }
  const license = m.license?.spdx_id && m.license.spdx_id !== 'NOASSERTION' ? m.license.spdx_id : null;
  if (!license) add('no-license', 'no license detected by GitHub (usage ambiguity)', 8);
  const age = daysSince(m.created_at ?? null, now);
  if (age != null && age < 90) add('very-new', `created ${age} days ago (limited track record)`, 10);
  if ((m.stargazers_count ?? 0) < 5) add('low-adoption', `only ${m.stargazers_count ?? 0} stars`, 6);
  // open-issue count intentionally NOT scored (includes PRs; popular repos carry thousands).

  // OSV.dev CVE scan — production dependencies only, severity-weighted.
  try {
    const pkgRes = await fetch(
      `https://api.github.com/repos/${ref.owner}/${ref.repo}/contents/package.json`,
      { headers: { ...gh(token), Accept: 'application/vnd.github.raw+json' } },
    );
    if (pkgRes.ok) {
      const pkg = JSON.parse(await pkgRes.text()) as Record<string, any>;
      const deps: { name: string; version: string }[] = [];
      for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
        const v = String(range).match(/\d+\.\d+\.\d+/)?.[0];
        if (v) deps.push({ name, version: v });
      }
      if (deps.length) {
        const osvRes = await fetch('https://api.osv.dev/v1/querybatch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            queries: deps.slice(0, 200).map((d) => ({ package: { name: d.name, ecosystem: 'npm' }, version: d.version })),
          }),
        });
        if (osvRes.ok) {
          const data = (await osvRes.json()) as { results?: { vulns?: { id: string }[] }[] };
          const ORDER = ['critical', 'high', 'moderate', 'low', 'unknown'];
          const counts: Record<string, number> = { critical: 0, high: 0, moderate: 0, low: 0, unknown: 0 };
          const cache = new Map<string, string>();
          let vulnDeps = 0;
          let lookups = 0;
          const fetchSev = async (id: string): Promise<string> => {
            try {
              const r = await fetch(`https://api.osv.dev/v1/vulns/${id}`);
              if (!r.ok) return 'unknown';
              const v = (await r.json()) as { database_specific?: { severity?: string }; severity?: { type?: string; score?: string }[] };
              const ds = v.database_specific?.severity?.toLowerCase();
              if (ds && ['critical', 'high', 'moderate', 'low'].includes(ds)) return ds;
              const cvss = Number(v.severity?.find((s) => s.type?.toUpperCase().startsWith('CVSS'))?.score);
              if (!Number.isNaN(cvss)) return cvss >= 9 ? 'critical' : cvss >= 7 ? 'high' : cvss >= 4 ? 'moderate' : 'low';
              return 'unknown';
            } catch {
              return 'unknown';
            }
          };
          for (const r of data.results ?? []) {
            if (!r.vulns?.length) continue;
            vulnDeps++;
            let depSev = 'unknown';
            for (const vln of r.vulns) {
              let sev = 'unknown';
              if (cache.has(vln.id)) sev = cache.get(vln.id)!;
              else if (lookups < 30) {
                sev = await fetchSev(vln.id);
                cache.set(vln.id, sev);
                lookups++;
              }
              if (ORDER.indexOf(sev) < ORDER.indexOf(depSev)) depSev = sev;
            }
            counts[depSev] = (counts[depSev] ?? 0) + 1;
          }
          const weight = Math.min(
            40,
            (counts.critical ?? 0) * 10 +
              (counts.high ?? 0) * 6 +
              (counts.moderate ?? 0) * 3 +
              (counts.low ?? 0) * 1 +
              (counts.unknown ?? 0) * 2,
          );
          if (weight > 0) {
            const parts: string[] = [];
            for (const k of ['critical', 'high', 'moderate', 'low']) if (counts[k]) parts.push(`${counts[k] ?? 0} ${k}`);
            add('dependency-cves', `${vulnDeps} of ${deps.length} production dependencies have known advisories${parts.length ? ` (${parts.join(', ')})` : ''}`, weight);
          }
        }
      }
    }
  } catch {
    /* OSV / manifest is best-effort */
  }

  const score = Math.min(100, signals.reduce((s, x) => s + x.weight, 0));
  const band = bandFor(score);
  const top = [...signals].sort((a, b) => b.weight - a.weight).slice(0, 4);
  const summary = top.length
    ? `${m.full_name} scored ${score}/100 (${band} risk). Key factors:\n${top.map((s) => `- ${s.name}: ${s.detail}`).join('\n')}`
    : `${m.full_name} scored ${score}/100 (${band} risk). No notable risk signals detected.`;

  return {
    repo: m.full_name,
    generatedAt: new Date().toISOString(),
    riskScore: score,
    riskBand: band,
    signals,
    summary,
    summarizer: 'templated' as const,
  };
}

// Minimal shape of Vercel's Node request/response (avoids a @vercel/node dep).
interface VercelReq {
  url?: string;
  query?: Record<string, string | string[] | undefined>;
}
interface VercelRes {
  setHeader(key: string, value: string): void;
  status(code: number): VercelRes;
  send(body: string): void;
}

export default async function handler(req: VercelReq, res: VercelRes): Promise<void> {
  const q = req.query?.repo;
  const repoParam =
    (typeof q === 'string' ? q : Array.isArray(q) ? q[0] : undefined) ??
    new URL(req.url ?? '/', 'http://localhost').searchParams.get('repo') ??
    '';
  res.setHeader('content-type', 'application/json');
  res.setHeader('access-control-allow-origin', '*');
  try {
    const ref = parseRepo(repoParam);
    const report = await analyze(ref, process.env.GITHUB_TOKEN);
    res.status(200).send(JSON.stringify(report));
  } catch (e) {
    res.status(400).send(JSON.stringify({ error: e instanceof Error ? e.message : 'analysis failed' }));
  }
}

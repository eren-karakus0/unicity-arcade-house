import { createSummarizer } from '../llm.js';
import type { RepoRiskReport, RiskSignal } from '../types.js';
import { parseRepoUrl } from './repo-url.js';
import { fetchRepoMeta } from './github.js';
import { scoreRepo, bandFor } from './scoring.js';
import { scanDependencies } from './osv.js';

export interface AnalyzeOptions {
  githubToken?: string;
  gemini?: { apiKey?: string; model: string };
}

/**
 * Analyze a GitHub repository and produce a risk report. This is the service the
 * Repo Risk Analyst sells on the network.
 *
 * Flow: SSRF-guarded URL parse → free GitHub metadata → deterministic score →
 * free OSV.dev dependency-CVE scan → natural-language summary.
 */
export async function analyzeRepo(repoUrl: string, opts: AnalyzeOptions = {}): Promise<RepoRiskReport> {
  const ref = parseRepoUrl(repoUrl); // SSRF guard — throws on non-github input
  const meta = await fetchRepoMeta(ref, opts.githubToken);

  const base = scoreRepo(meta);
  const signals: RiskSignal[] = [...base.signals];

  // Real production-dependency CVE scan via OSV.dev (free, severity-weighted).
  try {
    const osv = await scanDependencies(ref, opts.githubToken);
    if (osv && osv.weight > 0) {
      const parts: string[] = [];
      if (osv.counts.critical) parts.push(`${osv.counts.critical} critical`);
      if (osv.counts.high) parts.push(`${osv.counts.high} high`);
      if (osv.counts.moderate) parts.push(`${osv.counts.moderate} moderate`);
      if (osv.counts.low) parts.push(`${osv.counts.low} low`);
      const sev = parts.length ? ` (${parts.join(', ')})` : '';
      signals.push({
        name: 'dependency-cves',
        detail: `${osv.vulnerableDeps} of ${osv.prodDeps} production dependencies have known advisories${sev}`,
        weight: osv.weight,
      });
    }
  } catch {
    /* OSV / manifest fetch is best-effort and never blocks a report */
  }

  const score = Math.min(100, signals.reduce((sum, s) => sum + s.weight, 0));
  const band = bandFor(score);

  const summarizer = createSummarizer(opts.gemini ?? { model: 'gemini-2.0-flash' });
  const summary = await summarizer.summarize({
    repo: meta.fullName,
    riskScore: score,
    riskBand: band,
    signals,
  });

  return {
    repo: meta.fullName,
    generatedAt: new Date().toISOString(),
    riskScore: score,
    riskBand: band,
    signals,
    summary,
    summarizer: summarizer.mode,
  };
}

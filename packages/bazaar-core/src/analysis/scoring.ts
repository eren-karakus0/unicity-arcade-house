import type { RiskBand, RiskSignal } from '../types.js';
import type { RepoMeta } from './github.js';

export interface ScoreResult {
  score: number; // 0–100 (higher = riskier)
  band: RiskBand;
  signals: RiskSignal[];
}

function daysSince(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((now - t) / 86_400_000);
}

export function bandFor(score: number): RiskBand {
  if (score >= 70) return 'critical';
  if (score >= 45) return 'high';
  if (score >= 20) return 'medium';
  return 'low';
}

/**
 * Deterministic, free risk scoring from GitHub metadata. Pure function — no I/O,
 * fully unit-testable. The LLM only narrates the result; the score is here.
 */
export function scoreRepo(meta: RepoMeta, now: number = Date.now()): ScoreResult {
  const signals: RiskSignal[] = [];
  const add = (name: string, detail: string, weight: number) => signals.push({ name, detail, weight });

  if (meta.archived) add('archived', 'repository is archived (read-only, unmaintained)', 30);
  if (meta.disabled) add('disabled', 'repository is disabled by GitHub', 25);

  const stale = daysSince(meta.pushedAt, now);
  if (stale != null) {
    if (stale > 730) add('stale-2y', `no pushes in ${stale} days`, 30);
    else if (stale > 365) add('stale-1y', `no pushes in ${stale} days`, 20);
    else if (stale > 180) add('stale-6m', `no pushes in ${stale} days`, 10);
  }

  if (!meta.license) add('no-license', 'no license detected by GitHub (usage ambiguity)', 8);

  const age = daysSince(meta.createdAt, now);
  if (age != null && age < 90) add('very-new', `created ${age} days ago (limited track record)`, 10);

  if (meta.stars < 5) add('low-adoption', `only ${meta.stars} stars`, 6);

  // NOTE: open-issue count is intentionally NOT scored — GitHub's open_issues_count
  // includes open PRs, and popular, healthy repos naturally carry thousands.

  const score = Math.min(100, signals.reduce((s, x) => s + x.weight, 0));
  return { score, band: bandFor(score), signals };
}

import { describe, it, expect } from 'vitest';
import { parseRepoUrl } from '../src/analysis/repo-url';
import { scoreRepo } from '../src/analysis/scoring';
import { cleanVersion, parseNpmManifest } from '../src/analysis/osv';
import type { RepoMeta } from '../src/analysis/github';

describe('parseRepoUrl (SSRF guard)', () => {
  it('parses a full github url', () => {
    expect(parseRepoUrl('https://github.com/octocat/Hello-World')).toEqual({
      owner: 'octocat',
      repo: 'Hello-World',
    });
  });

  it('parses the owner/repo shorthand', () => {
    expect(parseRepoUrl('octocat/Hello-World')).toEqual({ owner: 'octocat', repo: 'Hello-World' });
  });

  it('strips a trailing .git', () => {
    expect(parseRepoUrl('https://github.com/a/b.git').repo).toBe('b');
  });

  it('rejects a non-github host', () => {
    expect(() => parseRepoUrl('https://evil.example.com/a/b')).toThrow(/host not allowed/);
  });

  it('rejects an SSRF metadata-endpoint host', () => {
    expect(() => parseRepoUrl('http://169.254.169.254/a/b')).toThrow(/host not allowed/);
  });

  it('rejects non-http(s) protocols', () => {
    expect(() => parseRepoUrl('file:///etc/passwd')).toThrow();
  });

  it('rejects empty input', () => {
    expect(() => parseRepoUrl('')).toThrow(/empty/);
  });
});

describe('scoreRepo', () => {
  const now = Date.parse('2026-06-30T00:00:00Z');
  const healthy: RepoMeta = {
    fullName: 'acme/healthy',
    archived: false,
    disabled: false,
    pushedAt: '2026-06-20T00:00:00Z',
    createdAt: '2023-01-01T00:00:00Z',
    openIssues: 5,
    stars: 250,
    forks: 30,
    license: 'MIT',
    defaultBranch: 'main',
    topics: [],
  };

  it('rates a healthy repo as low risk', () => {
    const r = scoreRepo(healthy, now);
    expect(r.band).toBe('low');
    expect(r.score).toBeLessThan(20);
  });

  it('flags an archived + stale + unlicensed repo as higher risk', () => {
    const r = scoreRepo(
      { ...healthy, archived: true, pushedAt: '2023-01-01T00:00:00Z', license: null },
      now,
    );
    expect(r.score).toBeGreaterThanOrEqual(45);
    const names = r.signals.map((s) => s.name);
    expect(names).toContain('archived');
    expect(names).toContain('stale-2y');
    expect(names).toContain('no-license');
  });

  it('caps the score at 100', () => {
    const r = scoreRepo(
      { ...healthy, archived: true, disabled: true, pushedAt: '2020-01-01T00:00:00Z', createdAt: now ? '2026-06-01T00:00:00Z' : null, license: null, stars: 0, openIssues: 9999 },
      now,
    );
    expect(r.score).toBeLessThanOrEqual(100);
  });
});

describe('osv manifest parsing', () => {
  it('cleans npm version ranges to a concrete semver', () => {
    expect(cleanVersion('^1.2.3')).toBe('1.2.3');
    expect(cleanVersion('~4.5.6')).toBe('4.5.6');
    expect(cleanVersion('>=10.0.0 <11')).toBe('10.0.0');
    expect(cleanVersion('latest')).toBeNull();
    expect(cleanVersion('*')).toBeNull();
  });

  it('extracts production dependencies only by default (dev deps do not ship)', () => {
    const pkg = JSON.stringify({
      name: 'demo',
      dependencies: { react: '^18.3.1', lodash: '4.17.20' },
      devDependencies: { vite: '^5.4.0' },
    });
    const names = parseNpmManifest(pkg).map((d) => d.name);
    expect(names).toContain('react');
    expect(names).toContain('lodash');
    expect(names).not.toContain('vite'); // devDependency excluded
    expect(parseNpmManifest(pkg).find((d) => d.name === 'lodash')?.version).toBe('4.17.20');
  });

  it('includes devDependencies when asked', () => {
    const pkg = JSON.stringify({ dependencies: { react: '^18' }, devDependencies: { vite: '^5.4.0' } });
    expect(parseNpmManifest(pkg, { includeDev: true }).map((d) => d.name)).toContain('vite');
  });

  it('returns an empty list for invalid json', () => {
    expect(parseNpmManifest('{not json')).toEqual([]);
  });
});

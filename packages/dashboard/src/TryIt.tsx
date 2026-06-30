import { useState } from 'react';
import { bandColor } from './lib/derive';

interface Report {
  repo: string;
  riskScore: number;
  riskBand: string;
  signals: { name: string; detail: string; weight: number }[];
  summary: string;
}

const EXAMPLES = ['facebook/react', 'angular/angular.js', 'expressjs/express'];

export function TryIt() {
  const [repo, setRepo] = useState('');
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (target?: string) => {
    const q = (target ?? repo).trim();
    if (!q || loading) return;
    if (target) setRepo(target);
    setLoading(true);
    setError(null);
    setReport(null);
    try {
      const res = await fetch(`/api/analyze?repo=${encodeURIComponent(q)}`);
      const data = (await res.json()) as Report & { error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? 'Analysis failed');
      setReport(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Analysis failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="tryit">
      <div className="tryit__head">
        <span className="tryit__kicker">Try the analyst</span>
        <h2 className="tryit__title">Score any GitHub repo</h2>
        <p className="tryit__sub">
          Run the analyst's exact logic yourself — maintenance signals plus a live
          OSV.dev dependency-CVE scan. Free and instant.
        </p>
      </div>

      <form
        className="tryit__form"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <input
          className="tryit__input"
          placeholder="owner/repo  ·  e.g. facebook/react"
          value={repo}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(e) => setRepo(e.target.value)}
        />
        <button className="tryit__btn" type="submit" disabled={loading}>
          {loading ? 'Analyzing…' : 'Analyze'}
        </button>
      </form>

      <div className="tryit__examples">
        <span className="tryit__try">try:</span>
        {EXAMPLES.map((ex) => (
          <button key={ex} className="chip" onClick={() => void run(ex)} disabled={loading}>
            {ex}
          </button>
        ))}
      </div>

      {error && <div className="tryit__error">⚠ {error}</div>}
      {report && <ReportCard report={report} />}
    </section>
  );
}

function ReportCard({ report }: { report: Report }) {
  const color = bandColor(report.riskBand);
  return (
    <div className="report">
      <div className="report__score" style={{ color }}>
        <div className="report__num">{report.riskScore}</div>
        <div className="report__band">{report.riskBand} risk</div>
      </div>
      <div className="report__body">
        <div className="report__repo">{report.repo}</div>
        <ul className="report__signals">
          {report.signals.length === 0 ? (
            <li className="report__sig">
              <span className="report__sig-name">clean</span>
              <span className="report__sig-detail">no notable risk signals detected</span>
            </li>
          ) : (
            report.signals.map((s) => (
              <li key={s.name} className="report__sig">
                <span className="report__sig-w" style={{ color }}>
                  +{s.weight}
                </span>
                <span className="report__sig-name">{s.name}</span>
                <span className="report__sig-detail">{s.detail}</span>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}

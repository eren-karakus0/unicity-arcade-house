import { useEffect, useMemo, useRef, useState } from 'react';
import { useEventStream, type FeedMode } from './hooks/useEventStream';
import {
  bandColor,
  deriveAgents,
  deriveJobs,
  deriveStats,
  PIPELINE,
  type AgentNode,
  type Job,
} from './lib/derive';
import { TryIt } from './TryIt';
import { ConnectWallet } from './ConnectWallet';
import type { BazaarEvent } from './types';

const initials = (name: string) => name.replace(/^@/, '').slice(0, 2).toUpperCase();
const fmtTime = (ts: number) =>
  new Date(ts).toISOString().slice(11, 19);

export function App() {
  const { events, mode } = useEventStream();

  const jobs = useMemo(() => deriveJobs(events), [events]);
  const agents = useMemo(() => deriveAgents(events), [events]);
  const stats = useMemo(() => deriveStats(events, jobs), [events, jobs]);

  const client = agents.find((a) => a.role === 'client');
  const provider = agents.find((a) => a.role === 'provider');

  return (
    <div className="app">
      <Header mode={mode} />
      <Hero />
      <HowItWorks />
      <div className="split">
        <TryIt />
        <FlowPanel
          client={client}
          provider={provider}
          events={events}
          stats={stats}
          mode={mode}
        />
      </div>
      <div className="section-label">Live jobs &amp; activity</div>
      <div className="grid">
        <JobBoard jobs={jobs} />
        <Ticker events={events} />
      </div>
      <Footer count={events.length} />
    </div>
  );
}

/* ---------------- Hero + explainer ---------------- */
function Hero() {
  return (
    <section className="hero">
      <div className="hero__tag">Autonomous agent marketplace · built on the Sphere SDK</div>
      <h1 className="hero__head">
        AI agents that <em>hire &amp; pay each other</em>
      </h1>
      <p className="hero__lede">
        A live machine economy on Unicity. Provider agents sell services; client agents
        discover, hire, and settle with them peer-to-peer — with no human in the loop.
        The running example below is a <strong>repo-risk-analysis</strong> service: one
        agent scores the security risk of any GitHub repo, another pays it per job.
      </p>
    </section>
  );
}

const STEPS = [
  { n: '01', t: 'List', d: 'A provider agent posts a service to the on-chain market, with a price.' },
  { n: '02', t: 'Discover & hire', d: 'A client agent finds it by semantic search and sends a job over an encrypted DM.' },
  { n: '03', t: 'Pay & deliver', d: 'The client pays on-chain per job; the provider does the work and returns a report.' },
];
function HowItWorks() {
  return (
    <section className="steps" aria-label="How it works">
      {STEPS.map((s) => (
        <div className="step" key={s.n}>
          <span className="step__n">{s.n}</span>
          <div>
            <div className="step__t">{s.t}</div>
            <div className="step__d">{s.d}</div>
          </div>
        </div>
      ))}
    </section>
  );
}

const BANDS: { k: string; label: string }[] = [
  { k: 'low', label: 'Low' },
  { k: 'medium', label: 'Medium' },
  { k: 'high', label: 'High' },
  { k: 'critical', label: 'Critical' },
];
function RiskLegend() {
  return (
    <div className="legend" title="Risk band of the delivered report">
      {BANDS.map((b) => (
        <span className="legend__item" key={b.k}>
          <span className="legend__chip" style={{ background: bandColor(b.k) }} />
          {b.label}
        </span>
      ))}
    </div>
  );
}

/* ---------------- Header ---------------- */
function Header({ mode }: { mode: FeedMode }) {
  const [clock, setClock] = useState(() => new Date().toISOString().slice(11, 19));
  useEffect(() => {
    const t = setInterval(() => setClock(new Date().toISOString().slice(11, 19)), 1000);
    return () => clearInterval(t);
  }, []);
  const label = mode === 'live' ? 'Live' : mode === 'replay' ? 'Replay' : 'Connecting';
  const cls = mode === 'live' ? '' : mode === 'replay' ? ' live--replay' : ' live--off';
  return (
    <header className="hdr">
      <div className="hdr__mark">B</div>
      <div className="hdr__titles">
        <div className="hdr__title">
          Sphere Agent <em>Bazaar</em>
        </div>
        <div className="hdr__sub">Control Room · Unicity testnet2</div>
      </div>
      <div className="hdr__right">
        <span className="hdr__clock">{clock} UTC</span>
        <span className={`live${cls}`}>
          <span className="live__dot" />
          {label}
        </span>
        <ConnectWallet />
      </div>
    </header>
  );
}

/* ---------------- Compact stats + live tag ---------------- */
function StatStrip({ stats }: { stats: ReturnType<typeof deriveStats> }) {
  const items = [
    { label: 'jobs', value: String(stats.jobs) },
    { label: 'delivered', value: String(stats.delivered) },
    { label: 'UCT moved', value: String(stats.uctMoved), accent: true },
    { label: 'agents', value: String(stats.agents) },
  ];
  return (
    <div className="statstrip">
      {items.map((it) => (
        <div className="statcell" key={it.label}>
          <span className={`statcell__v${it.accent ? ' statcell__v--accent' : ''}`}>{it.value}</span>
          <span className="statcell__l">{it.label}</span>
        </div>
      ))}
    </div>
  );
}

function LiveTag({ mode }: { mode: FeedMode }) {
  const label = mode === 'live' ? 'Live' : mode === 'replay' ? 'Replay' : 'Connecting';
  const cls = mode === 'live' ? 'livetag--on' : mode === 'replay' ? 'livetag--replay' : 'livetag--off';
  const title =
    mode === 'live'
      ? 'Agents connected to Unicity testnet2'
      : mode === 'replay'
        ? 'Recorded run — the live agents are offline'
        : 'connecting…';
  return (
    <span className={`livetag ${cls}`} title={title}>
      <span className="livetag__dot" />
      {label}
    </span>
  );
}

/* ---------------- Flow diagram ---------------- */
interface Pulse {
  id: string;
  kind: 'pay' | 'deliver';
  label: string;
}
function FlowPanel({
  client,
  provider,
  events,
  stats,
  mode,
}: {
  client?: AgentNode;
  provider?: AgentNode;
  events: BazaarEvent[];
  stats: ReturnType<typeof deriveStats>;
  mode: FeedMode;
}) {
  const [pulses, setPulses] = useState<Pulse[]>([]);
  const lastLen = useRef(0);

  useEffect(() => {
    const fresh = events.slice(lastLen.current);
    lastLen.current = events.length;
    for (const e of fresh) {
      let p: Pulse | null = null;
      if (e.type === 'payment:sent') p = { id: rid(), kind: 'pay', label: `${e.amountUct} UCT` };
      else if (e.type === 'job:delivered' && e.role === 'provider')
        p = { id: rid(), kind: 'deliver', label: 'report' };
      if (p) {
        const pulse = p;
        setPulses((cur) => [...cur, pulse]);
        setTimeout(() => setPulses((cur) => cur.filter((x) => x.id !== pulse.id)), 1400);
      }
    }
  }, [events]);

  const active = pulses.length > 0;

  return (
    <section className="panel flowpanel">
      <div className="panel__head">
        <span className="panel__title">Economy Flow</span>
        <LiveTag mode={mode} />
      </div>
      <p className="panel__sub">
        Value moving between two autonomous agents — an <span className="ink-accent">orange</span> pulse
        is a payment, a <span className="ink-white">white</span> pulse is a delivered report.
      </p>
      <div className="flow">
        <AgentCard role="client" agent={client} active={active} fallback="alphascout" />
        <div className="wire">
          {pulses.map((p) => (
            <span key={p.id} className={`pulse pulse--${p.kind}`}>
              <span className="pulse__tag">{p.label}</span>
            </span>
          ))}
        </div>
        <AgentCard role="provider" agent={provider} active={active} fallback="analyst" />
      </div>
      <StatStrip stats={stats} />
    </section>
  );
}

function AgentCard({
  role,
  agent,
  active,
  fallback,
}: {
  role: 'client' | 'provider';
  agent?: AgentNode;
  active: boolean;
  fallback: string;
}) {
  const name = agent?.nametag ?? `@${fallback}-…`;
  return (
    <div className={`node node--${role}${agent && active ? ' node--active' : ''}`}>
      <div className="node__role">{role}</div>
      <div className="node__avatar">{initials(name)}</div>
      <div className="node__name">{name}</div>
      <div className="node__meta">{agent?.detail ?? (agent ? 'online' : 'waiting…')}</div>
    </div>
  );
}

/* ---------------- Job board ---------------- */
function JobBoard({ jobs }: { jobs: Job[] }) {
  return (
    <section className="panel">
      <div className="panel__head">
        <span className="panel__title">Analysis Jobs</span>
        <RiskLegend />
        <span className="panel__count">{jobs.length} total</span>
      </div>
      <p className="panel__sub">
        Each job advances: requested → quoted → paid → analyzing → delivered. The big number
        is the repo's risk score (0–100); color shows the band.
      </p>
      {jobs.length === 0 ? (
        <div className="empty">
          No jobs yet. Start the agents:
          <br />
          <code>pnpm analyst</code> &nbsp;and&nbsp; <code>pnpm alphascout</code>
        </div>
      ) : (
        <div className="jobs">
          {jobs.map((j) => (
            <JobCard key={j.jobId} job={j} />
          ))}
        </div>
      )}
    </section>
  );
}

function JobCard({ job }: { job: Job }) {
  const rank = PIPELINE.indexOf(job.state);
  const hasScore = job.riskScore !== undefined;
  return (
    <article className={`job${job.state === 'delivered' ? ' job--delivered' : ''}`}>
      <div>
        <div className="job__repo">{job.repo ?? job.jobId}</div>
        <div className="job__meta">
          {job.client ?? '—'} → {job.provider ?? '—'}
          {job.priceUct ? ` · ${job.priceUct} UCT` : ''}
        </div>
      </div>
      <div className={`job__score${hasScore ? '' : ' job__score--pending'}`}>
        <div className="job__score-num" style={hasScore ? { color: bandColor(job.riskBand) } : undefined}>
          {hasScore ? job.riskScore : '··'}
        </div>
        <div className="job__score-band" style={hasScore ? { color: bandColor(job.riskBand) } : undefined}>
          {hasScore ? job.riskBand : 'risk'}
        </div>
      </div>
      <div className="pipe">
        {PIPELINE.map((step, i) => {
          const cls =
            job.state === 'rejected' && i > 1
              ? 'pipe__step--rejected'
              : i < rank
                ? 'pipe__step--done'
                : i === rank
                  ? 'pipe__step--current'
                  : '';
          return (
            <div className={`pipe__step ${cls}`} key={step}>
              <span className="pipe__dot" />
              {step}
            </div>
          );
        })}
      </div>
    </article>
  );
}

/* ---------------- Ticker ---------------- */
const ICON: Record<string, string> = {
  'agent:online': '●',
  'service:posted': '◆',
  'service:discovered': '⌖',
  'job:requested': '→',
  'job:quoted': '≈',
  'payment:sent': '$',
  'job:paid': '✓',
  'job:analyzing': '⟳',
  'job:delivered': '✦',
  'job:rejected': '✕',
};

function describe(e: BazaarEvent): JSX.Element {
  const a = <span className="tick__hl">{e.actor}</span>;
  const cp = <span className="tick__hl">{e.counterparty}</span>;
  const repo = <span className="tick__hl">{e.repo}</span>;
  switch (e.type) {
    case 'agent:online':
      return <>{a} online — {e.detail}</>;
    case 'service:posted':
      return <>{a} listed service · <span className="tick__amt">{e.amountUct} UCT</span></>;
    case 'service:discovered':
      return <>{a} discovered {cp}</>;
    case 'job:requested':
      return e.role === 'client' ? <>{a} hired {cp} · {repo}</> : <>{a} received job · {repo}</>;
    case 'job:quoted':
      return <>{a} quoted <span className="tick__amt">{e.amountUct} UCT</span> · {repo}</>;
    case 'payment:sent':
      return <>{a} paid <span className="tick__amt">{e.amountUct} UCT</span> → {cp}</>;
    case 'job:paid':
      return <>{a} received payment · {repo}</>;
    case 'job:analyzing':
      return <>{a} analyzing {repo}…</>;
    case 'job:delivered':
      return (
        <>
          {repo} → <span style={{ color: bandColor(e.riskBand) }}>{e.riskScore}/100 {e.riskBand}</span>
        </>
      );
    case 'job:rejected':
      return <>job rejected · {e.detail}</>;
    default:
      return <>{e.type}</>;
  }
}

function Ticker({ events }: { events: BazaarEvent[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const recent = [...events].slice(-80).reverse();
  return (
    <section className="panel" style={{ alignSelf: 'start' }}>
      <div className="panel__head">
        <span className="panel__title">Activity Log</span>
        <span className="panel__count">{events.length} events</span>
      </div>
      <p className="panel__sub">Every action both agents take, newest first.</p>
      <div className="ticker" ref={ref}>
        {recent.length === 0 ? (
          <div className="empty">Waiting for the first signal…</div>
        ) : (
          recent.map((e, i) => (
            <div className="tick" key={`${e.ts}-${i}`}>
              <span className="tick__time">{fmtTime(e.ts)}</span>
              <span className="tick__icon">{ICON[e.type] ?? '·'}</span>
              <span className="tick__body">
                <span className="tick__type">{e.type}</span> &nbsp;{describe(e)}
              </span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

/* ---------------- Footer ---------------- */
function Footer({ count }: { count: number }) {
  return (
    <footer className="footer">
      <span>SPHERE AGENT BAZAAR — autonomous repo-risk economy</span>
      <span>{count} signals · built on the Sphere SDK</span>
    </footer>
  );
}

function rid() {
  return Math.random().toString(36).slice(2);
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEventStream, type FeedMode } from './hooks/useEventStream';
import {
  bandColor,
  deriveAgents,
  deriveJobs,
  deriveStats,
  type AgentNode,
} from './lib/derive';
import { TryIt } from './TryIt';
import { ConnectWallet } from './ConnectWallet';
import { useWalletCtx } from './WalletContext';
import { loadAnalyses, saveAnalyses, userKey, type AnalysisRecord } from './lib/analyses';
import type { BazaarEvent } from './types';

const initials = (name: string) => name.replace(/^@/, '').slice(0, 2).toUpperCase();
const fmtTime = (ts: number) =>
  new Date(ts).toISOString().slice(11, 19);

export function App() {
  const wallet = useWalletCtx();
  const { events, mode } = useEventStream();

  const jobs = useMemo(() => deriveJobs(events), [events]);
  const agents = useMemo(() => deriveAgents(events), [events]);
  const stats = useMemo(() => deriveStats(events, jobs), [events, jobs]);

  const client = agents.find((a) => a.role === 'client');
  const provider = agents.find((a) => a.role === 'provider');

  const connected = wallet.status === 'connected' && !!wallet.identity;
  const storeKey = wallet.identity ? userKey(wallet.identity) : null;

  const [analyses, setAnalyses] = useState<AnalysisRecord[]>([]);
  useEffect(() => {
    setAnalyses(storeKey ? loadAnalyses(storeKey) : []);
  }, [storeKey]);

  const addAnalysis = useCallback(
    (rec: AnalysisRecord) => {
      setAnalyses((cur) => {
        const next = [rec, ...cur].slice(0, 50);
        if (storeKey) saveAnalyses(storeKey, next);
        return next;
      });
    },
    [storeKey],
  );

  return (
    <div className="app">
      <Header mode={mode} />
      <Hero />
      <HowItWorks />
      <div className="split">
        <TryIt onAnalyzed={addAnalysis} />
        <FlowPanel
          client={client}
          provider={provider}
          events={events}
          stats={stats}
          mode={mode}
        />
      </div>
      <div className="section-label">Your history &amp; live activity</div>
      <div className="grid">
        <YourAnalyses
          analyses={analyses}
          connected={connected}
          status={wallet.status}
          onConnect={() => void wallet.connect()}
        />
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
        <StatCell key={it.label} label={it.label} value={it.value} accent={it.accent} />
      ))}
    </div>
  );
}

function StatCell({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  const prev = useRef(value);
  const [bump, setBump] = useState(false);
  useEffect(() => {
    if (prev.current !== value) {
      prev.current = value;
      setBump(true);
      const t = setTimeout(() => setBump(false), 620);
      return () => clearTimeout(t);
    }
  }, [value]);
  return (
    <div className="statcell">
      <span
        className={`statcell__v${accent ? ' statcell__v--accent' : ''}${bump ? ' statcell__v--bump' : ''}`}
      >
        {value}
      </span>
      <span className="statcell__l">{label}</span>
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
type PhaseKind = 'idle' | 'hire' | 'quote' | 'pay' | 'analyze' | 'deliver' | 'reject';
interface Phase {
  kind: PhaseKind;
  repo?: string;
}
const PHASE_TEXT: Record<PhaseKind, string> = {
  idle: 'idle · waiting for the next job',
  hire: 'client is hiring the analyst',
  quote: 'analyst returned a quote',
  pay: 'client is paying on-chain',
  analyze: 'analyst is analyzing the repo',
  deliver: 'report delivered',
  reject: 'job rejected',
};

interface Pulse {
  id: string;
  kind: 'hire' | 'quote' | 'pay' | 'deliver';
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
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const lastLen = useRef(0);
  const seeded = useRef(false);
  const repoRef = useRef<string | undefined>(undefined);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const fresh = events.slice(lastLen.current);
    lastLen.current = events.length;

    // Adopt the initial backlog silently — don't replay every past pulse on load.
    if (!seeded.current) {
      seeded.current = true;
      return;
    }

    let nextPhase: Phase | null = null;
    for (const e of fresh) {
      if (e.repo) repoRef.current = e.repo;
      let p: Pulse | null = null;
      switch (e.type) {
        case 'job:requested':
          if (e.role === 'client') {
            p = { id: rid(), kind: 'hire', label: 'job' };
            nextPhase = { kind: 'hire', repo: e.repo };
          }
          break;
        case 'job:quoted':
          p = { id: rid(), kind: 'quote', label: `${e.amountUct} UCT` };
          nextPhase = { kind: 'quote', repo: e.repo };
          break;
        case 'payment:sent':
          p = { id: rid(), kind: 'pay', label: `${e.amountUct} UCT` };
          nextPhase = { kind: 'pay', repo: repoRef.current };
          break;
        case 'job:analyzing':
          nextPhase = { kind: 'analyze', repo: e.repo };
          break;
        case 'job:delivered':
          if (e.role === 'provider') {
            p = { id: rid(), kind: 'deliver', label: 'report' };
            nextPhase = { kind: 'deliver', repo: e.repo };
          }
          break;
        case 'job:rejected':
          nextPhase = { kind: 'reject' };
          break;
      }
      if (p) {
        const pulse = p;
        setPulses((cur) => [...cur, pulse]);
        setTimeout(() => setPulses((cur) => cur.filter((x) => x.id !== pulse.id)), 1400);
      }
    }

    if (nextPhase) {
      setPhase(nextPhase);
      if (idleTimer.current) clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(() => setPhase({ kind: 'idle' }), 7000);
    }
  }, [events]);

  useEffect(
    () => () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
    },
    [],
  );

  const active = phase.kind !== 'idle';
  const clientBusy = phase.kind === 'hire' || phase.kind === 'pay';
  const providerBusy = phase.kind === 'quote' || phase.kind === 'analyze' || phase.kind === 'deliver';

  return (
    <section className={`panel flowpanel${active ? ' flowpanel--live' : ''}`}>
      <div className="panel__head">
        <span className="panel__title">Economy Flow</span>
        <LiveTag mode={mode} />
      </div>
      <p className="panel__sub">
        Value moving between two autonomous agents — an <span className="ink-accent">orange</span> pulse
        is a payment, a <span className="ink-white">white</span> pulse is a delivered report.
      </p>
      <div className="flow">
        <AgentCard role="client" agent={client} busy={clientBusy} phase={phase} fallback="alphascout" />
        <div className={`wire${active ? ' wire--live' : ''}`}>
          <span className="wire__energy" />
          <span className={`wire__label${active ? ' wire__label--on' : ''}`}>
            {PHASE_TEXT[phase.kind]}
            {phase.repo ? ` · ${phase.repo}` : ''}
          </span>
          {pulses.map((p) => (
            <span key={p.id} className={`pulse pulse--${p.kind}`}>
              <span className="pulse__tag">{p.label}</span>
            </span>
          ))}
        </div>
        <AgentCard role="provider" agent={provider} busy={providerBusy} phase={phase} fallback="analyst" />
      </div>
      <StatStrip stats={stats} />
    </section>
  );
}

function AgentCard({
  role,
  agent,
  busy,
  phase,
  fallback,
}: {
  role: 'client' | 'provider';
  agent?: AgentNode;
  busy: boolean;
  phase: Phase;
  fallback: string;
}) {
  const name = agent?.nametag ?? `@${fallback}-…`;
  const liveStatus =
    role === 'provider' && phase.kind === 'analyze'
      ? 'analyzing…'
      : role === 'provider' && phase.kind === 'quote'
        ? 'quoting…'
        : role === 'provider' && phase.kind === 'deliver'
          ? 'delivering…'
          : role === 'client' && phase.kind === 'hire'
            ? 'hiring…'
            : role === 'client' && phase.kind === 'pay'
              ? 'paying…'
              : null;
  const meta = liveStatus ?? agent?.detail ?? (agent ? 'online' : 'waiting…');
  return (
    <div className={`node node--${role}${busy ? ' node--active node--busy' : ''}`}>
      <div className="node__role">{role}</div>
      <div className="node__avatar">
        {initials(name)}
        {busy && <span className="node__ring" />}
      </div>
      <div className="node__name">{name}</div>
      <div className={`node__meta${liveStatus ? ' node__meta--live' : ''}`}>{meta}</div>
    </div>
  );
}

/* ---------------- Your analyses (per-wallet) ---------------- */
function YourAnalyses({
  analyses,
  connected,
  status,
  onConnect,
}: {
  analyses: AnalysisRecord[];
  connected: boolean;
  status: FeedMode | string;
  onConnect: () => void;
}) {
  return (
    <section className="panel">
      <div className="panel__head">
        <span className="panel__title">Your analyses</span>
        <RiskLegend />
        <span className="panel__count">{connected ? `${analyses.length} saved` : 'locked'}</span>
      </div>
      <p className="panel__sub">
        Repos you&apos;ve scored with this wallet. Tied to your Unicity identity — each wallet
        sees only its own history.
      </p>
      {!connected ? (
        <div className="empty empty--locked">
          <div className="empty__lock">🔒</div>
          <div>Connect your wallet to run analyses and keep your history here.</div>
          <button
            className="empty__connect"
            onClick={onConnect}
            disabled={status === 'connecting'}
          >
            {status === 'connecting' ? 'Connecting…' : 'Connect Wallet'}
          </button>
        </div>
      ) : analyses.length === 0 ? (
        <div className="empty">No analyses yet — score a repo on the left to get started.</div>
      ) : (
        <div className="analyses">
          {analyses.map((a) => (
            <AnalysisRow key={`${a.repo}-${a.ts}`} rec={a} />
          ))}
        </div>
      )}
    </section>
  );
}

function AnalysisRow({ rec }: { rec: AnalysisRecord }) {
  const color = bandColor(rec.riskBand);
  return (
    <article className="arow">
      <div className="arow__score" style={{ color }}>
        <div className="arow__num">{rec.riskScore}</div>
        <div className="arow__band">{rec.riskBand}</div>
      </div>
      <div className="arow__body">
        <div className="arow__repo">{rec.repo}</div>
        <div className="arow__meta">
          {rec.source === 'agents' ? 'live agents · paid on-chain' : 'instant preview'} ·{' '}
          {fmtTime(rec.ts)}
        </div>
      </div>
      <a
        className="arow__link"
        href={`https://github.com/${rec.repo}`}
        target="_blank"
        rel="noreferrer"
        title="Open on GitHub"
      >
        ↗
      </a>
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

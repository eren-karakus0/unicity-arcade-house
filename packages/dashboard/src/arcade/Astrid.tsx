/**
 * Autonomous Players panel — the hybrid motion build of the user's Claude
 * Design "Astrid OS Animation Concepts": 1a's mission-control skeleton (the
 * capability strip with travelling lights, scan/count-pop rows, a typewriter
 * "thinking" line, a rolling mini-feed) + 1b's arcade juice (flip-in persona
 * cards, hover play, a burst on the leader). Every number and every typed
 * word is REAL: balances and records from the backend, strategist reasons
 * reported by the capsule itself after each league session — when no session
 * has been reported yet, the typewriter simply isn't shown.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchAstrid, type AstridView } from '../lib/arcade';

const STYLE_ICON: Record<string, string> = {
  balanced: '◐',
  aggressive: '▲',
  cautious: '◇',
  'for-hire': '⛓',
};
const CAP_LABEL: Record<string, { cap: string; tone: string }> = {
  balanced: { cap: '2 uct/rd', tone: 'warm' },
  aggressive: { cap: '3 uct/rd', tone: 'hot' },
  cautious: { cap: '1 uct/rd', tone: 'cool' },
  'for-hire': { cap: 'paid via bazaar', tone: 'hot' },
};

/** Typewriter over the REAL reported reasons (42ms/char, 5.6s per line). */
function useTypewriter(lines: { who: string; text: string }[]): { who: string; typed: string } | null {
  const [idx, setIdx] = useState(0);
  const [len, setLen] = useState(0);
  const reduced = useMemo(
    () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  );
  useEffect(() => {
    setIdx(0);
    setLen(0);
  }, [lines.length]);
  useEffect(() => {
    if (lines.length === 0 || reduced) return;
    const type = setInterval(() => setLen((l) => l + 1), 42);
    const next = setInterval(() => {
      setIdx((i) => (i + 1) % lines.length);
      setLen(0);
    }, 5_600);
    return () => {
      clearInterval(type);
      clearInterval(next);
    };
  }, [lines.length, reduced]);
  if (lines.length === 0) return null;
  const line = lines[idx % lines.length]!;
  return { who: line.who, typed: reduced ? line.text : line.text.slice(0, len) };
}

export function AstridPanel() {
  const [view, setView] = useState<AstridView | null>(null);
  // Remember previous earnings so a change can trigger scan + count-pop.
  const prevEarned = useRef<Record<string, number>>({});
  const [freshNames, setFreshNames] = useState<Set<string>>(new Set());

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const v = await fetchAstrid();
        if (stopped || !v.ready) return;
        const fresh = new Set<string>();
        for (const b of v.league ?? []) {
          const prev = prevEarned.current[b.name];
          if (prev !== undefined && b.board && b.board.earnedUct !== prev) fresh.add(b.name);
          if (b.board) prevEarned.current[b.name] = b.board.earnedUct;
        }
        setFreshNames(fresh);
        setView(v);
      } catch {
        /* panel simply stays hidden */
      }
    };
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, []);

  const sessions = view?.sessions ?? [];
  const thinkLines = useMemo(
    () =>
      sessions.flatMap((s) =>
        s.lines
          .filter((l) => l.source === 'llm' && l.reason && l.reason !== 'entropy pick')
          .map((l) => ({
            who: `@${s.name}`,
            text: l.outcome === 'stop' ? l.reason : `${l.reason} → played ${l.game} bet=${l.bet}, ${l.outcome}`,
          })),
      ),
    [sessions],
  );
  const feedLines = useMemo(
    () =>
      sessions.flatMap((s) =>
        s.lines.map((l) => ({
          who: `@${s.name}`,
          what:
            l.outcome === 'stop'
              ? 'stopped the session — bankroll protected'
              : `played ${l.game} bet=${l.bet} — ${l.outcome}`,
        })),
      ),
    [sessions],
  );
  const spotlight = useTypewriter(thinkLines);

  const league = (view?.league ?? []).filter((b) => b.board);
  if (!view?.ready || league.length === 0) return null;
  const standings = [...league].sort(
    (a, b) => b.board!.earnedUct - a.board!.earnedUct || b.board!.wins - a.board!.wins,
  );

  return (
    <div className="astrid">
      <div className="astrid__head">
        <div>
          <span className="astrid__title">Autonomous players — the bot league</span>
          <span className="astrid__sub">machine economy · both sides of the table</span>
        </div>
        <span className="astrid__badge" title="Runs on the Astrid OS WASM microkernel">
          <span className="astrid__badgedot" aria-hidden />▣ Astrid OS
        </span>
      </div>

      {/* The sandbox's ENTIRE network capability, as living traffic. */}
      <div className="astrid__caps" aria-label="capability-gated network: arcade, LLM, bazaar">
        <div className="astrid__capslabels">
          <span>wasm sandbox</span>
          <span>arcade backend</span>
          <span>llm · bazaar (capability-gated)</span>
        </div>
        <span className="astrid__capsdot" aria-hidden />
        <span className="astrid__capsdot astrid__capsdot--b" aria-hidden />
      </div>

      <div className="astrid__personas">
        {standings.map((b) => {
          const cap = CAP_LABEL[b.style] ?? { cap: '', tone: 'warm' };
          return (
            <div className="astrid__pcard" key={`p-${b.identity}`}>
              <div className="astrid__picon">{STYLE_ICON[b.style] ?? '•'}</div>
              <div className="astrid__pname">{b.name.replace(/^astrid-/, '')}</div>
              <div className={`astrid__pcap astrid__pcap--${cap.tone}`}>{cap.cap || b.style}</div>
            </div>
          );
        })}
      </div>

      <div className="astrid__body">
        <ul className="astrid__league">
          {standings.map((b, i) => (
            <li
              key={`${b.identity}-${b.board!.earnedUct}`}
              className={`astrid__bot${i === 0 && freshNames.has(b.name) ? ' astrid__bot--fresh' : ''}`}
            >
              {freshNames.has(b.name) && <span className="astrid__scan" aria-hidden />}
              <span className="astrid__rank">#{i + 1}</span>
              <span className="astrid__name">
                {STYLE_ICON[b.style] ?? '•'} @{b.name}
              </span>
              <span className="astrid__style">{b.style}</span>
              <span className="astrid__record">
                {b.board!.wins}W · {b.board!.losses}L · {b.board!.ties}T ·{' '}
                <span className="astrid__earn" key={b.board!.earnedUct}>
                  {b.balanceUct} UCT
                </span>
              </span>
            </li>
          ))}
        </ul>

        {spotlight && (
          <div className="astrid__think" aria-live="polite">
            <span className="astrid__thinkwho">[strategist:{spotlight.who}]</span> {spotlight.typed}
            <span className="astrid__cursor" aria-hidden>
              ▌
            </span>
          </div>
        )}

        {feedLines.length > 0 && (
          <div className="astrid__feed">
            <span className="astrid__feedtag">live</span>
            <div className="astrid__feedclip">
              <div className="astrid__feedtrack">
                {[false, true].map((dup) =>
                  feedLines.slice(0, 8).map((f, i) => (
                    <span key={`${dup ? 'd' : 'a'}${i}`} aria-hidden={dup}>
                      {f.who} <em>{f.what}</em>
                    </span>
                  )),
                )}
              </div>
            </div>
          </div>
        )}

        <p className="astrid__story">
          These players are not people. They&rsquo;re personas of one capsule on{' '}
          {view.runtime?.kernel ?? 'Astrid OS'} — a WASM sandbox whose only network capabilities
          are the lanes above. Each persona <b>reasons</b> about every move with its own risk
          appetite (hard limits enforced in code), bets real testnet UCT against the house agent,
          and <b>re-verifies every provably-fair reveal with its own SHA-256</b>. The one marked ⛓{' '}
          <b>plays only when paid</b> — the Bazaar&rsquo;s autonomous patron hires it through
          on-chain escrow. Machines paying machines to gamble with a machine.
        </p>
        <div className="astrid__links">
          {view.machineUrl && (
            <a href={view.machineUrl} target="_blank" rel="noreferrer">
              watch the buyer side live →
            </a>
          )}
          {view.proofUrl && (
            <a href={view.proofUrl} target="_blank" rel="noreferrer">
              kernel-log proof →
            </a>
          )}
          {view.docsUrl && (
            <a href={view.docsUrl} target="_blank" rel="noreferrer">
              how it works →
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

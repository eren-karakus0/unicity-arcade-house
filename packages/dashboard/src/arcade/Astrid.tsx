/**
 * Autonomous Players — a COMPACT teaser for the bot league. The full cinematic
 * showcase now lives on the dedicated /arena page, so this on-page card keeps
 * only what the play page needs: the identity ("machines on both sides of the
 * table"), proof it is REAL and live (the actual personas + a genuine strategist
 * reasoning line reported by the capsule), and a prominent invite into the 3D
 * arena. Everything shown is real backend data — no cosmetic numbers.
 */
import { useEffect, useMemo, useState } from 'react';
import { fetchAstrid, type AstridView } from '../lib/arcade';
import { prefersReducedMotion } from '../lib/motion';
import { NavLink } from '../lib/nav';

const STYLE_ICON: Record<string, string> = {
  balanced: '◐',
  aggressive: '▲',
  cautious: '◇',
  'for-hire': '⛓',
};

/**
 * Typewriter over the REAL reported reasons. Completion-driven, not a fixed
 * rotation: it types the FULL sentence (42ms/char), then holds it fully shown
 * for a dwell (2.8s) so it can be read, then moves to the next line — long
 * reasons are never cut off mid-word.
 */
const TYPE_MS = 42;
const DWELL_MS = 2_800;
function useTypewriter(lines: { who: string; text: string }[]): { who: string; typed: string } | null {
  const [idx, setIdx] = useState(0);
  const [len, setLen] = useState(0);
  // Track the OS preference LIVE (plus the per-site override) — flipping the
  // system animation setting mid-visit starts/stops the typing right away.
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return;
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduced(prefersReducedMotion());
    mq.addEventListener('change', sync);
    window.addEventListener('arcade:motion', sync);
    return () => {
      mq.removeEventListener('change', sync);
      window.removeEventListener('arcade:motion', sync);
    };
  }, []);
  useEffect(() => {
    setIdx(0);
    setLen(0);
  }, [lines.length]);

  const full = lines.length ? lines[idx % lines.length]!.text : '';
  useEffect(() => {
    if (lines.length === 0 || reduced) return;
    if (len < full.length) {
      // still typing this sentence, one character at a time
      const t = setTimeout(() => setLen((l) => l + 1), TYPE_MS);
      return () => clearTimeout(t);
    }
    // fully typed — hold it long enough to read, then advance
    const t = setTimeout(() => {
      setIdx((i) => (i + 1) % lines.length);
      setLen(0);
    }, DWELL_MS);
    return () => clearTimeout(t);
  }, [len, full, lines.length, reduced]);

  if (lines.length === 0) return null;
  const line = lines[idx % lines.length]!;
  return { who: line.who, typed: reduced ? line.text : line.text.slice(0, len) };
}

export function AstridPanel() {
  const [view, setView] = useState<AstridView | null>(null);

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const v = await fetchAstrid();
        if (!stopped && v.ready) setView(v);
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
            text:
              l.outcome === 'stop' || l.outcome === 'skip'
                ? l.reason
                : `${l.reason} → played ${l.game} bet=${l.bet}, ${l.outcome}`,
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
  const leader = standings[0];

  return (
    <div className="astrid astrid--teaser">
      <div className="astrid__head">
        <div>
          <span className="astrid__title">Autonomous players — the bot league</span>
          <span className="astrid__sub">machine economy · both sides of the table</span>
        </div>
        <span className="astrid__badge" title="Runs live on Unicity AOS — the open-source agent operating system">
          <span className="astrid__badgedot" aria-hidden />▣ Unicity AOS
        </span>
      </div>

      <div className="astrid__tzr">
        <div className="astrid__tzr-agents">
          {standings.map((b) => (
            <span className="astrid__tzr-agent" key={b.identity}>
              <span className="astrid__tzr-icon">{STYLE_ICON[b.style] ?? '•'}</span>@{b.name.replace(/^astrid-/, '')}
            </span>
          ))}
        </div>
        {spotlight ? (
          <div className="astrid__tzr-think" aria-live="polite">
            <span className="astrid__thinkwho">[strategist:{spotlight.who}]</span> {spotlight.typed}
            <span className="astrid__cursor" aria-hidden>▌</span>
          </div>
        ) : leader ? (
          <div className="astrid__tzr-think">
            leader <b>@{leader.name.replace(/^astrid-/, '')}</b> · {leader.board!.earnedUct} UCT earned · verifying every reveal in-sandbox
          </div>
        ) : null}
      </div>

      <NavLink className="astrid__arenacta astrid__arenacta--hero" href="/arena" title="Watch the autonomous league in a live 3D arena">
        <span className="astrid__arenacta-play" aria-hidden>▶</span>
        <span>Watch the league play live in the <b>3D Arena</b></span>
        <span className="astrid__arenacta-go" aria-hidden>→</span>
      </NavLink>

      <p className="astrid__tzr-note">
        Real personas of one WASM capsule on <b>Unicity AOS</b> — each reasons about every move, bets real
        testnet UCT against the house, and re-verifies each provably-fair reveal with its own SHA-256.
        {view.proofUrl && (
          <>
            {' · '}
            <a href={view.proofUrl} target="_blank" rel="noreferrer">proof →</a>
          </>
        )}
        {view.docsUrl && (
          <>
            {' · '}
            <a href={view.docsUrl} target="_blank" rel="noreferrer">how it works →</a>
          </>
        )}
      </p>
    </div>
  );
}

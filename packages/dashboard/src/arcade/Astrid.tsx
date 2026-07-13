/**
 * Autonomous Players panel — the Astrid OS bot league. One sandboxed capsule,
 * several strategist personas: each with its own arcade identity, its own
 * risk appetite in the LLM brief, and its own leaderboard row. Everything
 * shown is a REAL trace from the backend (live chip balances and win/loss
 * records); the runtime facts narrate where they run: a WASM sandbox whose
 * only network capabilities are this arcade and the LLM they consult, with
 * every provably-fair reveal re-verified in-capsule.
 */
import { useEffect, useState } from 'react';
import { fetchAstrid, type AstridView } from '../lib/arcade';

const STYLE_ICON: Record<string, string> = {
  balanced: '◐',
  aggressive: '▲',
  cautious: '◇',
  'for-hire': '⛓',
};

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
    const t = setInterval(() => void load(), 60_000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, []);

  const league = (view?.league ?? []).filter((b) => b.board);
  if (!view?.ready || league.length === 0) return null;
  // Standings: net earnings on the board, then wins.
  const standings = [...league].sort(
    (a, b) => (b.board!.earnedUct - a.board!.earnedUct) || (b.board!.wins - a.board!.wins),
  );

  return (
    <div className="astrid">
      <div className="astrid__head">
        <div>
          <span className="astrid__title">Autonomous players — the bot league</span>
          <span className="astrid__sub">machine economy · both sides of the table</span>
        </div>
        <span className="astrid__badge" title="Runs on the Astrid OS WASM microkernel">
          ▣ Astrid OS
        </span>
      </div>

      <div className="astrid__body">
        <ul className="astrid__league">
          {standings.map((b, i) => (
            <li key={b.identity} className="astrid__bot">
              <span className="astrid__rank">#{i + 1}</span>
              <span className="astrid__name">
                {STYLE_ICON[b.style] ?? '•'} @{b.name}
              </span>
              <span className="astrid__style">{b.style}</span>
              <span className="astrid__record">
                {b.board!.wins}W · {b.board!.losses}L · {b.board!.ties}T
                {' · '}
                {b.balanceUct} UCT
              </span>
            </li>
          ))}
        </ul>
        <p className="astrid__story">
          These players are not people. They&rsquo;re personas of one capsule on{' '}
          {view.runtime?.kernel ?? 'Astrid OS'} — a WASM sandbox whose only network capabilities
          are this arcade, the LLM they consult, and the Agent Bazaar. Each persona{' '}
          <b>reasons</b> about every move with its own risk appetite (hard limits enforced in
          code), bets real testnet UCT against the house agent, and{' '}
          <b>re-verifies every provably-fair reveal with its own SHA-256</b> before trusting a
          single result. And the one marked ⛓ <b>plays only when paid</b>: another autonomous
          agent — the Bazaar&rsquo;s patron — hires it through on-chain escrow, it does the round
          in the sandbox, and the escrow releases on delivery. Machines paying machines to gamble
          with a machine.
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

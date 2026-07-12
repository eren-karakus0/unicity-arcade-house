/**
 * Autonomous Players panel — the Astrid OS capsule that plays this arcade on
 * its own. Everything shown is a REAL trace from the backend (its live chip
 * balance and leaderboard record); the runtime facts narrate where it runs:
 * a WASM sandbox whose only network capability is this arcade, re-verifying
 * every provably-fair reveal with its own in-capsule SHA-256.
 */
import { useEffect, useState } from 'react';
import { fetchAstrid, type AstridView } from '../lib/arcade';

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

  if (!view?.ready || !view.board) return null;
  const { board } = view;

  return (
    <div className="astrid">
      <div className="astrid__head">
        <div>
          <span className="astrid__title">Autonomous players</span>
          <span className="astrid__sub">machine economy · both sides of the table</span>
        </div>
        <span className="astrid__badge" title="Runs on the Astrid OS WASM microkernel">
          ▣ Astrid OS
        </span>
      </div>

      <div className="astrid__body">
        <div className="astrid__who">
          <span className="astrid__name">@{view.name}</span>
          <span className="astrid__record">
            {board.wins}W · {board.losses}L · {board.ties}T over {board.played} rounds
            {typeof view.balanceUct === 'number' ? <> · {view.balanceUct} UCT at the table</> : null}
          </span>
        </div>
        <p className="astrid__story">
          This player is not a person. It&rsquo;s a capsule on {view.runtime?.kernel ?? 'Astrid OS'} —
          a {view.runtime?.sandbox ?? 'WASM sandbox'} whose only network capability is this arcade.
          It bets real testnet UCT against the house agent and{' '}
          <b>re-verifies every provably-fair reveal with its own SHA-256</b> before trusting a
          single result. An agent playing an agent, with the receipts to prove it.
        </p>
        <div className="astrid__links">
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

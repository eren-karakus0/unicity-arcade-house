/**
 * Tournament panel — a live countdown to the current window's close, the
 * standings (net UCT won this window), the prize, and the last champion the
 * house paid on-chain. Autonomous and recurring: no operator crowns anyone.
 */
import { useEffect, useState } from 'react';
import type { TournamentView } from '../lib/arcade';

function useCountdown(endsAt: number): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const ms = Math.max(0, endsAt - now);
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

export function TournamentPanel({ view }: { view: TournamentView | null }) {
  const countdown = useCountdown(view?.endsAt ?? 0);
  if (!view || view.endsAt === 0) return null;

  // Champions are winner-first per closed window; entries sharing the newest
  // `at` are the last window's podium (up to 3, already in rank order).
  const lastAt = view.champions[0]?.at;
  const podium = lastAt !== undefined ? view.champions.filter((c) => c.at === lastAt).slice(0, 3) : [];
  return (
    <div className="tourney">
      <div className="tourney__head">
        <div className="tourney__title">
          <span className="tourney__kicker">live tournament</span>
          <span className="tourney__prize">{view.prize} UCT prize</span>
        </div>
        <div className="tourney__clock" title="time left in this round">
          <span className="tourney__clocklabel">ends in</span>
          <span className="tourney__time">{countdown}</span>
        </div>
      </div>

      <div className="tourney__body">
        <div className="tourney__standings">
          <div className="tourney__subhead">standings · net UCT won this round</div>
          {view.standings.length === 0 ? (
            <div className="tourney__empty">
              No plays yet this round — win some UCT and the top scorer takes the prize.
            </div>
          ) : (
            <ol className="tourney__list">
              {view.standings.map((s, i) => (
                <li className={`trow${i === 0 ? ' trow--lead' : ''}`} key={s.name}>
                  <span className="trow__rank">{i + 1}</span>
                  <span className="trow__name">@{s.name}</span>
                  <span className="trow__score">+{s.score} UCT</span>
                </li>
              ))}
            </ol>
          )}
        </div>

        <div className="tourney__champ">
          <div className="tourney__subhead">
            {podium.length > 1 ? 'last podium · paid on-chain' : 'last champion'}
          </div>
          {podium.length > 0 ? (
            <div className="podium">
              {/* visual order silver · gold · bronze, ranks from the data */}
              {[1, 0, 2]
                .filter((r) => r < podium.length)
                .map((r) => {
                  const c = podium[r]!;
                  return (
                    <div className={`podium__col podium__col--r${r + 1}`} key={`${c.at}-${r}`}>
                      {r === 0 ? (
                        <span className="podium__crown" aria-hidden="true">
                          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                            <path
                              d="M4 8 l3.5 3 4.5 -5 4.5 5 3.5 -3 -1.5 10 h-13 Z"
                              stroke="currentColor"
                              strokeWidth="1.7"
                              strokeLinejoin="round"
                              fill="currentColor"
                              fillOpacity="0.18"
                            />
                          </svg>
                        </span>
                      ) : (
                        <span className="podium__medal" aria-hidden="true">
                          {r + 1}
                        </span>
                      )}
                      <span className="podium__name">@{c.name}</span>
                      <span className="podium__take">+{c.prize} UCT</span>
                      <span className="podium__block" aria-hidden="true" />
                    </div>
                  );
                })}
            </div>
          ) : (
            <div className="tourney__empty">The first champion will be crowned when this round ends.</div>
          )}
        </div>
      </div>
    </div>
  );
}

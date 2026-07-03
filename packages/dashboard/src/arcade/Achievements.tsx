/**
 * Achievements UI — a badge board and a one-time unlock toast. Badge art is
 * inline SVG (no emoji dependency), matching the arcade's orange-on-black kit.
 */
import { useEffect, useRef, useState } from 'react';
import type { AchievementView } from '../lib/arcade';

type IconName = AchievementView['icon'];

export function BadgeIcon({ name, size = 22 }: { name: IconName; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none' as const };
  const stroke = { stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  switch (name) {
    case 'spark':
      return (
        <svg {...common}>
          <path d="M12 3 l1.8 5.2 5.2 1.8 -5.2 1.8 -1.8 5.2 -1.8 -5.2 -5.2 -1.8 5.2 -1.8 Z" {...stroke} fill="currentColor" fillOpacity="0.18" />
        </svg>
      );
    case 'flame':
      return (
        <svg {...common}>
          <path d="M12 3 c3 3 4.5 5.5 4.5 8.5 a4.5 4.5 0 0 1 -9 0 c0 -1.5 .6 -2.8 1.6 -3.8 c.2 1.2 .9 1.8 1.6 2 c-.4 -2 .2 -4.4 1.3 -6.7 Z" {...stroke} fill="currentColor" fillOpacity="0.18" />
        </svg>
      );
    case 'crown':
      return (
        <svg {...common}>
          <path d="M4 8 l3.5 3 4.5 -5 4.5 5 3.5 -3 -1.5 10 h-13 Z" {...stroke} fill="currentColor" fillOpacity="0.18" />
        </svg>
      );
    case 'coin':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" {...stroke} fill="currentColor" fillOpacity="0.12" />
          <path d="M12 7.5 v9 M9.7 9.4 h3.3 a1.8 1.8 0 0 1 0 3.6 h-2 a1.8 1.8 0 0 0 0 3.6 h3.3" {...stroke} />
        </svg>
      );
    case 'dice':
      return (
        <svg {...common}>
          <rect x="4" y="4" width="16" height="16" rx="3.5" {...stroke} fill="currentColor" fillOpacity="0.12" />
          <circle cx="9" cy="9" r="1.3" fill="currentColor" />
          <circle cx="15" cy="15" r="1.3" fill="currentColor" />
          <circle cx="12" cy="12" r="1.3" fill="currentColor" />
        </svg>
      );
    case 'target':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" {...stroke} />
          <circle cx="12" cy="12" r="4.6" {...stroke} />
          <circle cx="12" cy="12" r="1.4" fill="currentColor" />
        </svg>
      );
    case 'star':
      return (
        <svg {...common}>
          <path d="M12 3 l2.6 5.8 6.4 .6 -4.8 4.2 1.4 6.2 -5.6 -3.3 -5.6 3.3 1.4 -6.2 -4.8 -4.2 6.4 -.6 Z" {...stroke} fill="currentColor" fillOpacity="0.18" />
        </svg>
      );
    case 'trophy':
      return (
        <svg {...common}>
          <path d="M7 4 h10 v4 a5 5 0 0 1 -10 0 Z" {...stroke} fill="currentColor" fillOpacity="0.18" />
          <path d="M7 5 H4.5 a2.5 2.5 0 0 0 2.5 3.5 M17 5 h2.5 a2.5 2.5 0 0 1 -2.5 3.5 M12 13 v3 M9 20 h6 M10 20 l.5 -4 h3 l.5 4" {...stroke} />
        </svg>
      );
  }
}

/** The badge board: full catalog, unlocked lit, locked dimmed, with progress. */
export function AchievementsPanel({ items }: { items: AchievementView[] }) {
  if (items.length === 0) return null;
  const got = items.filter((a) => a.unlocked).length;
  return (
    <div className="ach">
      <div className="ach__head">
        <span className="ach__title">Achievements</span>
        <span className="ach__count">
          {got}/{items.length}
        </span>
      </div>
      <div className="ach__grid">
        {items.map((a) => (
          <div
            key={a.id}
            className={`badge${a.unlocked ? ' badge--on' : ''}`}
            title={`${a.title} — ${a.detail}${a.reward > 0 ? ` (+${a.reward} UCT)` : ''}`}
          >
            <span className="badge__ic">
              <BadgeIcon name={a.icon} />
            </span>
            <span className="badge__txt">
              <span className="badge__name">{a.title}</span>
              <span className="badge__detail">{a.detail}</span>
            </span>
            {a.unlocked && <span className="badge__check" aria-hidden="true">✓</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * A one-at-a-time unlock toast. Feeds from a queue: each newly-earned
 * achievement shows for a few seconds, then the next.
 */
export function AchievementToast({ queue, onShown }: { queue: AchievementView[]; onShown: (id: string) => void }) {
  const [current, setCurrent] = useState<AchievementView | null>(null);
  // Keep onShown in a ref so its identity churn (a fresh closure every parent
  // render) can't cancel the dismissal timer below.
  const onShownRef = useRef(onShown);
  onShownRef.current = onShown;

  // Pull the next badge off the queue whenever nothing is currently showing.
  useEffect(() => {
    if (current || queue.length === 0) return;
    setCurrent(queue[0]!);
  }, [queue, current]);

  // Show the current badge for a beat, then dismiss so the queue can advance.
  // Keyed on `current` only, so re-renders don't reschedule/cancel the timer.
  useEffect(() => {
    if (!current) return;
    const id = current.id;
    const t = setTimeout(() => {
      onShownRef.current(id);
      setCurrent(null);
    }, 4200);
    return () => clearTimeout(t);
  }, [current]);

  if (!current) return null;
  return (
    <div className="achtoast" role="status">
      <span className="achtoast__ic">
        <BadgeIcon name={current.icon} size={30} />
      </span>
      <span className="achtoast__body">
        <span className="achtoast__kicker">achievement unlocked</span>
        <span className="achtoast__name">{current.title}</span>
        <span className="achtoast__detail">
          {current.detail}
          {current.reward > 0 ? ` · +${current.reward} UCT` : ''}
        </span>
      </span>
    </div>
  );
}

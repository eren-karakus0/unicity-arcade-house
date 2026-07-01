/**
 * Hand-drawn SVG art for the game hall — no emojis. Every piece shares the
 * brand orange and a 64×64 viewBox so they compose consistently.
 */
import type { ReactNode } from 'react';

const O = '#FF6F00';
const O2 = '#FF9A4D';
const INK = '#0a0a0a';
const FACE = '#F3ECE1';

function Svg({ size = 64, label, children }: { size?: number; label: string; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" role="img" aria-label={label}>
      {children}
    </svg>
  );
}

export function BotMark({ size = 64 }: { size?: number }) {
  return (
    <Svg size={size} label="house agent">
      <defs>
        <linearGradient id="arcg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={O2} />
          <stop offset="1" stopColor={O} />
        </linearGradient>
      </defs>
      <line x1="32" y1="7" x2="32" y2="17" stroke="url(#arcg)" strokeWidth="3" strokeLinecap="round" />
      <circle cx="32" cy="6" r="3" fill="url(#arcg)" />
      <rect x="11" y="17" width="42" height="34" rx="11" fill="url(#arcg)" />
      <rect x="18" y="27" width="28" height="15" rx="7.5" fill={INK} opacity="0.82" />
      <circle cx="26" cy="34.5" r="3.4" fill="#FFB877" />
      <circle cx="38" cy="34.5" r="3.4" fill="#FFB877" />
      <rect x="24" y="55" width="16" height="4" rx="2" fill="url(#arcg)" opacity="0.5" />
    </Svg>
  );
}

const PIPS: Record<number, [number, number][]> = {
  1: [[32, 32]],
  2: [[21, 21], [43, 43]],
  3: [[21, 21], [32, 32], [43, 43]],
  4: [[21, 21], [43, 21], [21, 43], [43, 43]],
  5: [[21, 21], [43, 21], [32, 32], [21, 43], [43, 43]],
  6: [[21, 19], [43, 19], [21, 32], [43, 32], [21, 45], [43, 45]],
};

export function Die({ n, size = 64, accent = false }: { n: number; size?: number; accent?: boolean }) {
  const pips = PIPS[n] ?? PIPS[1]!;
  return (
    <Svg size={size} label={`die showing ${n}`}>
      <rect x="8" y="8" width="48" height="48" rx="12" fill={accent ? O : FACE} />
      <rect x="8" y="8" width="48" height="48" rx="12" fill="none" stroke={INK} strokeOpacity="0.14" strokeWidth="2" />
      {pips.map(([cx, cy], i) => (
        <circle key={i} cx={cx} cy={cy} r="4.6" fill={accent ? '#0a0a0a' : O} />
      ))}
    </Svg>
  );
}

export function DieBlank({ size = 64 }: { size?: number }) {
  return (
    <Svg size={size} label="die">
      <rect x="8" y="8" width="48" height="48" rx="12" fill={FACE} opacity="0.14" />
      <rect x="8" y="8" width="48" height="48" rx="12" fill="none" stroke="#ffffff" strokeOpacity="0.16" strokeWidth="2" />
      <text x="32" y="42" textAnchor="middle" fontFamily="Anton, sans-serif" fontSize="30" fill="#ffffff" opacity="0.25">
        ?
      </text>
    </Svg>
  );
}

export function Coin({ side, size = 64 }: { side?: 'heads' | 'tails'; size?: number }) {
  return (
    <Svg size={size} label={side ?? 'coin'}>
      <defs>
        <linearGradient id="arcg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={O2} />
          <stop offset="1" stopColor={O} />
        </linearGradient>
      </defs>
      <circle cx="32" cy="32" r="24" fill="url(#arcg)" />
      <circle cx="32" cy="32" r="24" fill="none" stroke={INK} strokeOpacity="0.18" strokeWidth="2.5" />
      <circle cx="32" cy="32" r="17" fill="none" stroke={INK} strokeOpacity="0.28" strokeWidth="2" />
      {side === 'tails' ? (
        <circle cx="32" cy="32" r="8" fill="none" stroke={INK} strokeWidth="4" opacity="0.85" />
      ) : (
        <path d="M32 20 L44 40 L20 40 Z" fill={INK} opacity="0.85" />
      )}
    </Svg>
  );
}

export function CoinBlank({ size = 64 }: { size?: number }) {
  return (
    <Svg size={size} label="coin">
      <circle cx="32" cy="32" r="24" fill="#ffffff" opacity="0.08" />
      <circle cx="32" cy="32" r="24" fill="none" stroke="#ffffff" strokeOpacity="0.16" strokeWidth="2.5" />
      <text x="32" y="42" textAnchor="middle" fontFamily="Anton, sans-serif" fontSize="26" fill="#ffffff" opacity="0.25">
        ?
      </text>
    </Svg>
  );
}

const RANK: Record<number, string> = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };
const rankLabel = (r: number) => RANK[r] ?? String(r);

export function Card({ rank, size = 64, hidden = false }: { rank?: number; size?: number; hidden?: boolean }) {
  if (hidden || rank === undefined) {
    return (
      <Svg size={size} label="face-down card">
        <rect x="14" y="6" width="36" height="52" rx="7" fill={O} />
        <rect x="18" y="10" width="28" height="44" rx="4" fill="none" stroke={INK} strokeOpacity="0.3" strokeWidth="2" />
        <text x="32" y="41" textAnchor="middle" fontFamily="Anton, sans-serif" fontSize="26" fill={INK} opacity="0.55">
          ?
        </text>
      </Svg>
    );
  }
  const label = rankLabel(rank);
  return (
    <Svg size={size} label={`card ${label}`}>
      <rect x="14" y="6" width="36" height="52" rx="7" fill={FACE} />
      <rect x="14" y="6" width="36" height="52" rx="7" fill="none" stroke={INK} strokeOpacity="0.12" strokeWidth="2" />
      <text x="21" y="20" textAnchor="middle" fontFamily="Anton, sans-serif" fontSize="12" fill={O}>
        {label}
      </text>
      <text x="32" y="42" textAnchor="middle" fontFamily="Anton, sans-serif" fontSize="26" fill={INK}>
        {label}
      </text>
    </Svg>
  );
}

export function NumberTile({ value, size = 64, hidden = false }: { value?: number; size?: number; hidden?: boolean }) {
  return (
    <Svg size={size} label={hidden ? 'sealed number' : `number ${value ?? ''}`}>
      <rect x="10" y="10" width="44" height="44" rx="12" fill={hidden ? O : FACE} />
      <rect x="10" y="10" width="44" height="44" rx="12" fill="none" stroke={INK} strokeOpacity="0.14" strokeWidth="2" />
      <text x="32" y="44" textAnchor="middle" fontFamily="Anton, sans-serif" fontSize="28" fill={INK}>
        {hidden ? '?' : (value ?? '')}
      </text>
    </Svg>
  );
}

/* ---- Rock · Paper · Scissors hands (clean icon style) ---- */
export function HandRock({ size = 64 }: { size?: number }) {
  return (
    <Svg size={size} label="rock">
      <circle cx="20" cy="27" r="7" fill={O} />
      <circle cx="30" cy="24" r="7.5" fill={O} />
      <circle cx="40" cy="25" r="7" fill={O} />
      <circle cx="48" cy="30" r="6" fill={O} />
      <circle cx="14" cy="37" r="6.5" fill={O2} />
      <rect x="14" y="28" width="36" height="24" rx="11" fill={O} />
    </Svg>
  );
}
export function HandPaper({ size = 64 }: { size?: number }) {
  return (
    <Svg size={size} label="paper">
      <path d="M18 10 h20 l10 10 v34 a3 3 0 0 1 -3 3 H18 a3 3 0 0 1 -3 -3 V13 a3 3 0 0 1 3 -3 Z" fill={FACE} />
      <path d="M38 10 l10 10 h-10 Z" fill={O2} />
      <line x1="22" y1="28" x2="42" y2="28" stroke={O} strokeWidth="3" strokeLinecap="round" />
      <line x1="22" y1="36" x2="42" y2="36" stroke={O} strokeWidth="3" strokeLinecap="round" />
      <line x1="22" y1="44" x2="36" y2="44" stroke={O} strokeWidth="3" strokeLinecap="round" />
    </Svg>
  );
}
export function HandScissors({ size = 64 }: { size?: number }) {
  return (
    <Svg size={size} label="scissors">
      <circle cx="18" cy="46" r="8" fill="none" stroke={O} strokeWidth="4" />
      <circle cx="34" cy="48" r="8" fill="none" stroke={O2} strokeWidth="4" />
      <line x1="22" y1="40" x2="52" y2="12" stroke={O} strokeWidth="4" strokeLinecap="round" />
      <line x1="30" y1="42" x2="52" y2="20" stroke={O2} strokeWidth="4" strokeLinecap="round" />
    </Svg>
  );
}

export function Flame({ size = 20, dim = false }: { size?: number; dim?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" role="img" aria-label="streak">
      <path
        d="M12 2 C 12 6, 7 8, 7 14 a5 5 0 0 0 10 0 c 0 -3 -2 -4 -2 -6 c -2 2 -3 1 -3 -6 Z"
        fill={dim ? '#3a3a3a' : O}
      />
      <path d="M12 11 c 0 3 -2 3 -2 5 a2 2 0 0 0 4 0 c 0 -2 -2 -2 -2 -5 Z" fill={dim ? '#555' : '#FFD9A8'} />
    </svg>
  );
}

export function HandOf({ move, size = 64 }: { move?: string; size?: number }) {
  if (move === 'rock') return <HandRock size={size} />;
  if (move === 'paper') return <HandPaper size={size} />;
  if (move === 'scissors') return <HandScissors size={size} />;
  return (
    <Svg size={size} label="waiting">
      <text x="32" y="44" textAnchor="middle" fontFamily="Anton, sans-serif" fontSize="34" fill="#ffffff" opacity="0.22">
        ?
      </text>
    </Svg>
  );
}

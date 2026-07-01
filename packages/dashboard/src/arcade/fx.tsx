/**
 * Motion pieces for the game hall. Nothing here is staged: the pending loops
 * run only while the backend is actually resolving a round, and the win burst
 * plays once after a real on-chain payout result.
 */
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Coin, Die, NumberTile } from './art';

/** A die that cycles faces while the round resolves. */
export function TumblingDie({ size = 64, accent = false }: { size?: number; accent?: boolean }) {
  const [n, setN] = useState(() => 1 + Math.floor(Math.random() * 6));
  useEffect(() => {
    const t = setInterval(() => setN((p) => (p % 6) + 1), 90);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="anim-tumble">
      <Die n={n} size={size} accent={accent} />
    </span>
  );
}

/** A number tile that spins 1–6 like a slot reel while the reveal is in flight. */
export function CyclingTile({ size = 64 }: { size?: number }) {
  const [n, setN] = useState(1);
  useEffect(() => {
    const t = setInterval(() => setN((p) => (p % 6) + 1), 100);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="anim-cycle">
      <NumberTile value={n} size={size} />
    </span>
  );
}

/* ---- win celebration: brand-orange coin rain + confetti, one shot ---- */

const BITS = ['#FF6F00', '#FF9A4D', '#FFD9A8', '#F3ECE1'];

interface Particle {
  id: number;
  coin: boolean;
  left: number;
  delay: number;
  dur: number;
  size: number;
  color: string;
  drift: number;
  spin: number;
}

/** Mount with a fresh `key` per win so the burst replays. */
export function WinBurst() {
  const parts = useMemo<Particle[]>(
    () =>
      Array.from({ length: 28 }, (_, i) => ({
        id: i,
        coin: i % 4 === 0,
        left: 3 + Math.random() * 94,
        delay: Math.random() * 0.4,
        dur: 1.2 + Math.random(),
        size: i % 4 === 0 ? 14 + Math.random() * 8 : 5 + Math.random() * 6,
        color: BITS[i % BITS.length]!,
        drift: -50 + Math.random() * 100,
        spin: (Math.random() < 0.5 ? -1 : 1) * (200 + Math.random() * 520),
      })),
    [],
  );
  return (
    <div className="burst" aria-hidden="true">
      {parts.map((p) => {
        const style = {
          left: `${p.left}%`,
          '--dur': `${p.dur}s`,
          '--delay': `${p.delay}s`,
          '--drift': `${p.drift}px`,
          '--spin': `${p.spin}deg`,
        } as CSSProperties;
        return p.coin ? (
          <span key={p.id} className="burst__coin" style={style}>
            <Coin side={p.id % 2 ? 'heads' : 'tails'} size={p.size} />
          </span>
        ) : (
          <span
            key={p.id}
            className="burst__bit"
            style={{ ...style, width: p.size, height: p.size * 0.62, background: p.color }}
          />
        );
      })}
    </div>
  );
}

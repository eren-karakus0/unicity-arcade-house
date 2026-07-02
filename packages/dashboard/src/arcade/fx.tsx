/**
 * Motion pieces for the game hall. Nothing here is staged: the pending loops
 * run only while the backend is actually resolving a round, and the win burst
 * plays once after a real on-chain payout result.
 */
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Coin, Die, NumberTile, WheelFace } from './art';

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

/**
 * The Lucky Wheel: idles slowly between rounds, spins fast while the round
 * really resolves, then decelerates onto the landed segment from the reveal.
 */
export function WheelFx({
  segments,
  landIndex,
  spinning,
  size = 210,
}: {
  segments?: readonly number[];
  landIndex?: number;
  spinning: boolean;
  size?: number;
}) {
  const count = segments?.length ?? 10;
  const [deg, setDeg] = useState(0);
  useEffect(() => {
    if (landIndex === undefined) {
      setDeg(0);
      return;
    }
    const step = 360 / count;
    // 4 full turns, then stop with the landed segment centred under the pointer
    const target = 4 * 360 + (360 - (landIndex * step + step / 2));
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setDeg(target)));
    return () => cancelAnimationFrame(raf);
  }, [landIndex, count]);
  const mode = landIndex !== undefined ? 'land' : spinning ? 'spin' : 'idle';
  return (
    <div className="wheelbox">
      <div
        className={`wheel wheel--${mode}`}
        style={mode === 'land' ? { transform: `rotate(${deg}deg)` } : undefined}
      >
        <WheelFace segments={segments} size={size} />
      </div>
      <div className="wheel__pointer" aria-hidden="true" />
    </div>
  );
}

/* ---- Plinko: the real revealed path drives the ball, peg by peg ---- */

const P_O = '#FF6F00';
const P_INK = '#0a0a0a';
const P_DEFAULT_MULTS: readonly number[] = [10, 4, 2, 1, 1, 1, 0, 1, 1, 1, 2, 4, 10];

export function PlinkoFx({
  rows = 12,
  multipliers,
  path,
  dropping,
}: {
  rows?: number;
  multipliers?: readonly number[];
  path?: number[];
  dropping: boolean;
}) {
  const mults = multipliers ?? P_DEFAULT_MULTS;
  const n = path?.length ?? rows;
  const dx = 22;
  const rowH = 19;
  const top = 22;
  const W = (n + 1) * dx + 26;
  const cx = W / 2;
  const bucketY = top + n * rowH + 6;
  const H = bucketY + 36;

  // Step the ball along the revealed path (one peg row per tick).
  const [step, setStep] = useState(-1);
  useEffect(() => {
    if (!path) {
      setStep(-1);
      return;
    }
    setStep(0);
    let k = 0;
    const t = setInterval(() => {
      k += 1;
      setStep(k);
      if (k > path.length) clearInterval(t);
    }, 130);
    return () => clearInterval(t);
  }, [path]);

  const k = path ? Math.min(Math.max(step, 0), path.length) : 0;
  const rights = path ? path.slice(0, k).reduce((a, b) => a + b, 0) : 0;
  const inBucket = !!path && step > path.length;
  const ballX = path ? cx + (rights - k / 2) * dx : cx;
  const ballY = !path ? top - 9 : inBucket ? bucketY + 13 : top - 9 + k * rowH;
  const landed = inBucket && path ? path.reduce((a, b) => a + b, 0) : -1;

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} fill="none" role="img" aria-label="plinko board">
      {/* pegs */}
      {Array.from({ length: n }, (_, i) =>
        Array.from({ length: i + 1 }, (_, j) => (
          <circle
            key={`${i}-${j}`}
            cx={cx + (j - i / 2) * dx}
            cy={top + i * rowH + rowH / 2}
            r="2.4"
            fill="#ffffff"
            opacity="0.28"
          />
        )),
      )}
      {/* buckets */}
      {mults.map((m, b) => {
        const bx = cx + (b - n / 2) * dx;
        const hot = b === landed;
        return (
          <g key={b} className={hot ? 'plinko__bucket--hit' : undefined}>
            <rect
              x={bx - dx / 2 + 1.5}
              y={bucketY}
              width={dx - 3}
              height={25}
              rx={4}
              fill={m === 0 ? '#141414' : m >= 10 ? '#FFD9A8' : m >= 2 ? P_O : '#b34e00'}
              stroke={hot ? '#ffffff' : P_INK}
              strokeWidth={hot ? 2 : 1.5}
            />
            <text
              x={bx}
              y={bucketY + 16.5}
              textAnchor="middle"
              fontFamily="Geist Mono, monospace"
              fontSize="9.5"
              fontWeight="700"
              fill={m === 0 ? 'rgba(255,255,255,0.35)' : m >= 10 ? P_INK : '#F3ECE1'}
            >
              {m ? `×${m}` : '·'}
            </text>
          </g>
        );
      })}
      {/* the ball */}
      <g
        className={dropping && !path ? 'plinko__ball--wait' : undefined}
        style={{ transform: `translate(${ballX}px, ${ballY}px)`, transition: 'transform 120ms ease-in' }}
      >
        <circle r="7" fill={P_O} stroke={P_INK} strokeWidth="2" />
        <circle r="2.4" cx="-2" cy="-2.4" fill="#FFD9A8" />
      </g>
    </svg>
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

/** Mount with a fresh `key` per win so the burst replays. `big` = jackpot mode. */
export function WinBurst({ big = false }: { big?: boolean }) {
  const parts = useMemo<Particle[]>(
    () =>
      Array.from({ length: big ? 64 : 28 }, (_, i) => ({
        id: i,
        coin: i % 4 === 0,
        left: 3 + Math.random() * 94,
        delay: Math.random() * (big ? 0.9 : 0.4),
        dur: 1.2 + Math.random() * (big ? 1.6 : 1),
        size: i % 4 === 0 ? 14 + Math.random() * 8 : 5 + Math.random() * 6,
        color: BITS[i % BITS.length]!,
        drift: -50 + Math.random() * 100,
        spin: (Math.random() < 0.5 ? -1 : 1) * (200 + Math.random() * 520),
      })),
    [big],
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

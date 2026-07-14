/**
 * Motion pieces for the game hall. Nothing here is staged: the pending loops
 * run only while the backend is actually resolving a round, and the win burst
 * plays once after a real on-chain payout result.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Coin, Die, NumberTile, WheelFace } from './art';
import { prefersReducedMotion } from '../lib/motion';
import { sfx } from './sound';

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
    sfx.wheelLand(); // decelerating clacks matched to the landing
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
      if (k <= path.length) sfx.peg(k); // peg tick, pitch rising as it falls
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

/* ---- Crash: the signature flight. The curve is drawn to the REAL, already-
        committed crash point (fed in during the suspense window), the counter
        climbs with it, a marker flashes where the player's cash-out clears,
        and a bust drops the tip off the chart. ---- */

export function CrashFx({
  flying,
  crashX100,
  targetX100,
}: {
  flying: boolean;
  crashX100?: number;
  targetX100?: number;
}) {
  const crash = crashX100 !== undefined ? crashX100 / 100 : undefined;
  const target = targetX100 !== undefined ? targetX100 / 100 : undefined;
  const win = crash !== undefined && target !== undefined && crash >= target;
  const reduced = prefersReducedMotion();
  const [now, setNow] = useState({ m: 1, p: 0, done: false });
  const raf = useRef(0);

  const W = 300;
  const H = 132;
  const PADX = 10;
  const PADY = 12;
  const mMax = crash !== undefined ? Math.max(crash * 1.12, 1.6) : 2;
  const xOf = (p: number) => PADX + p * (W - 2 * PADX);
  const yOf = (m: number) =>
    H - PADY - Math.pow(Math.max(0, m - 1) / (mMax - 1), 0.72) * (H - 2 * PADY);
  // Short flights bust fast, big multipliers get the full ride.
  const dur =
    crash !== undefined
      ? Math.min(2300, Math.max(650, 600 + 900 * Math.log2(Math.max(crash, 1.01))))
      : 2300;

  useEffect(() => {
    cancelAnimationFrame(raf.current);
    if (crash === undefined) {
      setNow({ m: 1, p: 0, done: false });
      return;
    }
    if (!flying || reduced) {
      setNow({ m: crash, p: 1, done: true });
      return;
    }
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / dur);
      setNow({ m: Math.pow(crash, p), p, done: p >= 1 });
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [flying, crash, reduced, dur]);

  // Igniting: the round is resolving but the reveal hasn't arrived yet.
  if (crash === undefined) return <span className="anim-climb crashx">×1.00</span>;

  const K = 28;
  const pts =
    now.p > 0
      ? Array.from({ length: K + 1 }, (_, i) => {
          const p = (i / K) * now.p;
          return `${xOf(p).toFixed(1)},${yOf(Math.pow(crash, p)).toFixed(1)}`;
        }).join(' ')
      : '';
  // Where the player's cash-out sits on the flight path (wins only).
  const pT = win && crash > 1 && target! > 1 ? Math.log(target!) / Math.log(crash) : undefined;
  const cashed = pT !== undefined && now.p >= pT;
  const bust = now.done && !win;
  const tipX = xOf(now.p);
  const tipY = yOf(now.m);

  return (
    <div
      className={`crashfx${bust ? ' crashfx--bust' : ''}${now.done && win ? ' crashfx--win' : ''}`}
      role="img"
      aria-label={
        now.done
          ? win
            ? `cashed out at ×${target!.toFixed(2)}, crashed at ×${crash.toFixed(2)}`
            : `busted at ×${crash.toFixed(2)}`
          : 'the multiplier is climbing'
      }
    >
      <svg viewBox={`0 0 ${W} ${H}`} className="crashfx__svg" fill="none" aria-hidden>
        <line x1={PADX} y1={H - PADY} x2={W - PADX} y2={H - PADY} className="crashfx__floor" />
        {pts && <polyline points={pts} className="crashfx__curve" />}
        {pT !== undefined && (
          <g className={`crashfx__cash${cashed ? ' crashfx__cash--hit' : ''}`}>
            <circle cx={xOf(pT)} cy={yOf(target!)} r="4.5" />
            {cashed && (
              <text x={Math.min(xOf(pT) + 9, W - 78)} y={Math.max(yOf(target!) - 8, 12)} className="crashfx__cashlabel">
                cashed ×{target!.toFixed(2)}
              </text>
            )}
          </g>
        )}
        {now.p > 0 && (
          <g
            className={`crashfx__tip${bust ? ' crashfx__tip--fall' : ''}`}
            style={
              {
                '--tx': `${tipX.toFixed(1)}px`,
                '--ty': `${tipY.toFixed(1)}px`,
                transform: `translate(${tipX.toFixed(1)}px, ${tipY.toFixed(1)}px)`,
              } as CSSProperties
            }
          >
            <circle r="5" />
          </g>
        )}
      </svg>
      <div className={`crashfx__num${now.done ? (win ? ' crashfx__num--win' : ' crashfx__num--bust') : ''}`}>
        ×{now.m.toFixed(2)}
      </div>
    </div>
  );
}

/* ---- Limbo: the bar. A needle sweeps up the (log) scale toward the real
        revealed multiplier while the counter climbs — clear the target tick
        and it lands green, fall short and it lands red. ---- */

export function LimboFx({
  flying,
  resultX100,
  targetX100,
}: {
  flying: boolean;
  resultX100?: number;
  targetX100?: number;
}) {
  const result = resultX100 !== undefined ? resultX100 / 100 : undefined;
  const target = targetX100 !== undefined ? targetX100 / 100 : undefined;
  const reduced = prefersReducedMotion();
  const [p, setP] = useState(0);
  const raf = useRef(0);

  useEffect(() => {
    cancelAnimationFrame(raf.current);
    if (result === undefined) {
      setP(0);
      return;
    }
    if (!flying || reduced) {
      setP(1);
      return;
    }
    const D = 1300;
    const t0 = performance.now();
    const tick = (t: number) => {
      const q = Math.min(1, (t - t0) / D);
      setP(q);
      if (q < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [flying, result, reduced]);

  if (result === undefined || target === undefined)
    return <span className="anim-climb crashx">×?.??</span>;

  const axisMax = Math.max(target * 1.6, result * 1.15, 3);
  const frac = (m: number) => Math.log(Math.max(m, 1)) / Math.log(axisMax);
  const ease = 1 - Math.pow(1 - p, 3);
  const m = Math.exp(ease * Math.log(result)); // sweeps evenly in log space
  const done = p >= 1;
  const win = result >= target;

  return (
    <div
      className={`limbofx${done ? (win ? ' limbofx--win' : ' limbofx--bust') : ''}`}
      role="img"
      aria-label={done ? `rolled ×${result.toFixed(2)} against your ×${target.toFixed(2)} bar` : 'unsealing'}
    >
      <div className="limbofx__num">×{m.toFixed(2)}</div>
      <div className="limbofx__bar" aria-hidden>
        <div className="limbofx__fill" style={{ width: `${(frac(m) * 100).toFixed(2)}%` }} />
        <div className="limbofx__tick" style={{ left: `${(frac(target) * 100).toFixed(2)}%` }}>
          <span className="limbofx__ticklabel">×{target}</span>
        </div>
      </div>
    </div>
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

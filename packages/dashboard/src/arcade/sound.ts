/**
 * Synthesized arcade sounds — pure WebAudio, no audio files. Every game and
 * moment gets its own voice: pegs tick, wheels clack, coins whoosh, wins
 * arpeggiate, jackpots fanfare. Mute persists to localStorage; the context
 * unlocks on the first user gesture (browser autoplay policy).
 */

const MUTE_KEY = 'arcade-muted';

/** Master volume — every per-sound gain is scaled by this. */
const MASTER = 2.2;

let ctx: AudioContext | null = null;
let muted = typeof localStorage !== 'undefined' && localStorage.getItem(MUTE_KEY) === '1';

function ac(): AudioContext | null {
  if (muted) return null;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

export function isMuted(): boolean {
  return muted;
}
export function setMuted(m: boolean): void {
  muted = m;
  try {
    localStorage.setItem(MUTE_KEY, m ? '1' : '0');
  } catch {
    /* private mode */
  }
}

/** One enveloped oscillator blip. `slide` bends the pitch across the note. */
function tone(
  freq: number,
  dur = 0.08,
  type: OscillatorType = 'square',
  gain = 0.04,
  when = 0,
  slide = 0,
): void {
  const c = ac();
  if (!c) return;
  const t0 = c.currentTime + when;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t0 + dur);
  g.gain.setValueAtTime(Math.min(0.25, gain * MASTER), t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g);
  g.connect(c.destination);
  o.start(t0);
  o.stop(t0 + dur + 0.02);
}

/** A short burst of white noise (shakes, card slides, ball rattle). */
function noise(dur = 0.06, gain = 0.03, when = 0): void {
  const c = ac();
  if (!c) return;
  const t0 = c.currentTime + when;
  const len = Math.ceil(c.sampleRate * dur);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = c.createBufferSource();
  src.buffer = buf;
  const g = c.createGain();
  g.gain.value = Math.min(0.25, gain * MASTER);
  src.connect(g);
  g.connect(c.destination);
  src.start(t0);
}

export const sfx = {
  /* ---- UI ---- */
  click(): void {
    tone(660, 0.05, 'square', 0.028);
  },
  bet(): void {
    tone(520, 0.05, 'triangle', 0.032);
    tone(780, 0.05, 'triangle', 0.026, 0.05);
  },

  /* ---- per-game suspense (matches the pending animations) ---- */
  suspense(game: string): void {
    switch (game) {
      case 'rps': // three fist pumps
        for (let i = 0; i < 3; i++) noise(0.06, 0.03, i * 0.34);
        break;
      case 'dice': // rattling dice
        for (let i = 0; i < 8; i++) noise(0.035, 0.022, i * 0.14);
        break;
      case 'coin': // whoosh up…
        tone(420, 0.55, 'sine', 0.035, 0, 900);
        break;
      case 'highlow': // card slide
        noise(0.09, 0.03, 0.15);
        noise(0.09, 0.03, 0.55);
        break;
      case 'number': // slot reel ticking upward
        for (let i = 0; i < 9; i++) tone(700 + i * 60, 0.03, 'square', 0.02, i * 0.12);
        break;
      case 'wheel': // fast even clacks while it whirls
        for (let i = 0; i < 10; i++) tone(880, 0.025, 'square', 0.02, i * 0.08);
        break;
      default:
        break;
    }
  },

  /** Plinko peg hit — pitch rises as the ball falls. */
  peg(row: number): void {
    tone(600 + row * 55, 0.035, 'square', 0.024);
  },

  /** Wheel landing — decelerating clacks over ~2.6s, like a real prize wheel. */
  wheelLand(): void {
    let t = 0;
    let gap = 0.05;
    while (t < 2.5) {
      tone(920, 0.028, 'square', 0.024, t);
      t += gap;
      gap *= 1.16;
    }
    tone(1200, 0.12, 'triangle', 0.035, Math.min(t, 2.6)); // final stop ding
  },

  /* ---- outcomes ---- */
  win(): void {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.14, 'square', 0.034, i * 0.09));
  },
  lose(): void {
    tone(220, 0.22, 'sawtooth', 0.026, 0, -80);
    tone(150, 0.32, 'sawtooth', 0.026, 0.13, -50);
  },
  push(): void {
    tone(440, 0.09, 'triangle', 0.03);
    tone(440, 0.09, 'triangle', 0.03, 0.13);
  },
  bonus(): void {
    tone(880, 0.1, 'square', 0.03, 0);
    tone(1175, 0.12, 'square', 0.03, 0.09);
  },
  jackpot(): void {
    [523, 659, 784, 1047, 1319, 1568].forEach((f, i) => tone(f, 0.18, 'square', 0.038, i * 0.11));
    [1047, 1319, 1568].forEach((f, i) => tone(f, 0.32, 'triangle', 0.03, 0.75 + i * 0.06));
  },
  cashout(): void {
    [784, 988, 1175, 1568].forEach((f, i) => tone(f, 0.12, 'triangle', 0.036, i * 0.07));
  },
};

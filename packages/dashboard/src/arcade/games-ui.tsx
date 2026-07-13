import { useEffect, useState, type ReactNode } from 'react';
import type { GameMeta, NewRound, PlayResult } from '../lib/arcade';
import {
  BotMark,
  Card,
  Coin,
  CoinBlank,
  Die,
  DieBlank,
  HandOf,
  HandRock,
  HandScissors,
  NumberTile,
  PlinkoMark,
  WheelFace,
} from './art';
import { CyclingTile, PlinkoFx, TumblingDie, WheelFx } from './fx';

export const GAMES_META: GameMeta[] = [
  { id: 'blackjack', title: 'Blackjack', blurb: 'Hit, stand, double — against a shoe sealed before the first card.', rewardMult: 2, inputKind: 'choice' },
  { id: 'crash', title: 'Crash', blurb: 'Set your cash-out, ride the curve, beat the sealed bust point.', rewardMult: 2, inputKind: 'choice' },
  { id: 'limbo', title: 'Limbo', blurb: 'Name your multiplier — the sealed result must reach it.', rewardMult: 2, inputKind: 'choice' },
  { id: 'mines', title: 'Mines', blurb: '5 mines sealed on a 5×5 board — clear your picks for up to ×8.39.', rewardMult: 8, inputKind: 'choice' },
  { id: 'rps', title: 'Rock · Paper · Scissors', blurb: 'Beat the house’s sealed move.', rewardMult: 2, inputKind: 'choice' },
  { id: 'wheel', title: 'Lucky Wheel', blurb: 'Spin for a bet multiplier — ×1 gives the bet back, ×5 tops the wheel.', rewardMult: 5, inputKind: 'seed' },
  { id: 'plinko', title: 'Plinko', blurb: 'Drop the ball — edge buckets pay ×10. Two-seed fair.', rewardMult: 10, inputKind: 'seed' },
  { id: 'dice', title: 'Dice Duel', blurb: 'Higher roll wins — two-seed fair.', rewardMult: 2, inputKind: 'seed' },
  { id: 'coin', title: 'Coin Flip', blurb: 'Call it — double or nothing. Pure 50 / 50.', rewardMult: 2, inputKind: 'choice' },
  { id: 'highlow', title: 'High · Low', blurb: 'Higher or lower than the card?', rewardMult: 2, inputKind: 'choice' },
  { id: 'number', title: 'Lucky Number', blurb: 'Guess 1–6 — nail it for 5×.', rewardMult: 5, inputKind: 'choice' },
];

export interface Option {
  key: string;
  art: ReactNode;
  name: string;
  choice: unknown;
  /** The play call merges a fresh client seed into this option's choice
   *  (`{ ...choice, seed }`) — for target-plus-seed games like Limbo/Crash. */
  withSeed?: boolean;
}

interface StageProps {
  round: NewRound | null;
  result: PlayResult | null;
  pending: boolean;
}

export interface GameUI {
  Icon: (p: { size?: number }) => JSX.Element;
  Stage: (p: StageProps) => JSX.Element;
  options?: (round: NewRound | null) => Option[];
  /** Fully custom input surface (e.g. the Mines board) — rendered instead of
   *  the option buttons when present. */
  Picker?: (p: { round: NewRound | null; disabled: boolean; onPlay: (choice: unknown) => void }) => JSX.Element;
  rollLabel?: string;
  /** Keep the pending animation running this long before showing the reveal. */
  suspenseMs?: number;
  /** Hold the verdict this long after the result so the reveal can land. */
  settleMs?: number;
  /** Custom picker reward line (e.g. variable-multiplier games). */
  reward?: () => string;
}

function Slot({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="gslot">
      <div className="gslot__art">{children}</div>
      <div className="gslot__label">{label}</div>
    </div>
  );
}
function Duo({ you, house }: { you: ReactNode; house: ReactNode }) {
  return (
    <div className="gstage">
      <Slot label="you">{you}</Slot>
      <div className="gstage__vs">vs</div>
      <Slot label="house">{house}</Slot>
    </div>
  );
}
function Solo({ children, caption }: { children: ReactNode; caption?: string }) {
  return (
    <div className="gstage gstage--solo">
      <div className="gslot__art gslot__art--lg">{children}</div>
      {caption && <div className="gslot__label">{caption}</div>}
    </div>
  );
}

const num = (v: unknown) => Number(v);
const str = (v: unknown) => (v == null ? undefined : String(v));
const x = (x100: unknown) => (Number(x100) / 100).toFixed(2);

/* ---- new-game glyphs (inline SVG, brand-orange friendly) ---- */
const RocketMark = ({ size = 24 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M12 2c3.5 2 5 6 4.4 9.6l2.1 2.7-3.2.6-1.6 3.1-2-2.6-3.4.4 1-3.1-2.6-2C5.6 7.4 8.5 3.6 12 2Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    <circle cx="12.6" cy="8.4" r="1.5" fill="currentColor" />
    <path d="M6.5 17.5 4 20m4.5-.5L7 21.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);
const LimboMark = ({ size = 24 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path d="M5 15 12 8l7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M5 20h14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity=".5" />
  </svg>
);
const MinesMark = ({ size = 24 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <rect x="3.5" y="3.5" width="17" height="17" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
    <path d="M9.2 3.5v17M14.8 3.5v17M3.5 9.2h17M3.5 14.8h17" stroke="currentColor" strokeWidth="1" opacity=".45" />
    <circle cx="12" cy="12" r="1.9" fill="currentColor" />
  </svg>
);

/* ---- shared Mines board (picker + reveal) ---- */
function MinesBoard({
  cells = 25,
  selected,
  mines,
  hit,
  onToggle,
}: {
  cells?: number;
  selected: Set<number>;
  mines?: number[];
  hit?: number[];
  onToggle?: (i: number) => void;
}) {
  const mineSet = new Set(mines ?? []);
  const hitSet = new Set(hit ?? []);
  const revealed = mines !== undefined;
  return (
    <div className="minesgrid" role="group" aria-label="mines board">
      {Array.from({ length: cells }, (_, i) => {
        const isMine = mineSet.has(i);
        const isPick = selected.has(i);
        const cls = [
          'minecell',
          isPick ? ' minecell--pick' : '',
          revealed && isMine ? ' minecell--mine' : '',
          revealed && isPick && !isMine ? ' minecell--safe' : '',
          hitSet.has(i) ? ' minecell--hit' : '',
        ].join('');
        return (
          <button
            key={i}
            className={cls}
            onClick={onToggle ? () => onToggle(i) : undefined}
            disabled={!onToggle}
            aria-label={`cell ${i + 1}${isPick ? ', picked' : ''}${revealed && isMine ? ', mine' : ''}`}
          >
            {revealed && isMine ? '✸' : isPick ? '◆' : ''}
          </button>
        );
      })}
    </div>
  );
}

/** The Mines input surface: toggle cells, then reveal — bracket payout live. */
function MinesPicker({
  round,
  disabled,
  onPlay,
}: {
  round: NewRound | null;
  disabled: boolean;
  onPlay: (choice: unknown) => void;
}) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  // A fresh round means a fresh board.
  useEffect(() => setSelected(new Set()), [round?.roundId]);
  const mults = (round?.publicState?.multipliers ?? {}) as Record<string, number>;
  const maxPicks = 8;
  const toggle = (i: number) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(i)) next.delete(i);
      else if (next.size < maxPicks) next.add(i);
      return next;
    });
  const k = selected.size;
  return (
    <div className="minespick">
      <MinesBoard selected={selected} onToggle={disabled ? undefined : toggle} />
      <div className="minespick__bar">
        <span className="minespick__info">
          {k === 0 ? `pick up to ${maxPicks} cells` : `${k} cell${k > 1 ? 's' : ''} — pays ×${mults[k] ?? '?'}`}
        </span>
        <button
          className="again"
          disabled={disabled || k === 0}
          onClick={() => onPlay([...selected].sort((a, b) => a - b))}
        >
          Reveal the board
        </button>
      </div>
    </div>
  );
}

/** One-shot reveal animations — remount per result so they replay. */
const Pop = ({ children }: { children: ReactNode }) => <span className="anim-pop">{children}</span>;
const Flip = ({ children }: { children: ReactNode }) => <span className="anim-flip">{children}</span>;

const TARGET_OPTIONS = (targets: number[]): Option[] =>
  targets.map((t) => ({
    key: String(t),
    art: <span className="gbtn__glyph">×{t}</span>,
    name: '',
    choice: { target: t },
    withSeed: true,
  }));

const SpadeMark = ({ size = 24 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
    <path
      d="M12 3c3.2 3.1 7 5.6 7 9a3.6 3.6 0 0 1-6.2 2.5c.2 1.9.8 3.3 2.2 4.5h-6c1.4-1.2 2-2.6 2.2-4.5A3.6 3.6 0 0 1 5 12c0-3.4 3.8-5.9 7-9Z"
      fill="currentColor"
    />
  </svg>
);

export const GAME_UI: Record<string, GameUI> = {
  blackjack: {
    Icon: ({ size }) => <SpadeMark size={size} />,
    // The table renders its own multi-step surface (see BlackjackTable);
    // this Stage never mounts — the picker only needs the icon + meta.
    Stage: () => <span />,
    reward: () => 'blackjack pays 3:2',
  },
  crash: {
    Icon: ({ size }) => <RocketMark size={size} />,
    Stage: ({ round, result, pending }) => {
      const win = result ? num(result.reveal.crashX100) >= num(result.reveal.targetX100) : false;
      return (
        <Solo
          caption={
            pending
              ? 'climbing…'
              : result
                ? win
                  ? `cashed out at ×${x(result.reveal.targetX100)} — it flew on to ×${x(result.reveal.crashX100)}`
                  : `busted at ×${x(result.reveal.crashX100)} — you needed ×${x(result.reveal.targetX100)}`
                : round
                  ? 'crash point sealed — set your cash-out'
                  : ''
          }
        >
          {pending ? (
            <span className="anim-climb crashx">×?.??</span>
          ) : result ? (
            <Pop>
              <span className={`crashx ${win ? 'crashx--win' : 'crashx--bust'}`}>
                ×{x(result.reveal.crashX100)}
              </span>
            </Pop>
          ) : (
            <span className="crashx crashx--idle">
              <RocketMark size={86} />
            </span>
          )}
        </Solo>
      );
    },
    options: () => TARGET_OPTIONS([1.2, 1.5, 2, 3, 5]),
    suspenseMs: 1600,
    reward: () => 'pays × your cash-out',
  },
  limbo: {
    Icon: ({ size }) => <LimboMark size={size} />,
    Stage: ({ round, result, pending }) => {
      const win = result ? num(result.reveal.resultX100) >= num(result.reveal.targetX100) : false;
      return (
        <Solo
          caption={
            pending
              ? 'unsealing…'
              : result
                ? win
                  ? `×${x(result.reveal.resultX100)} — cleared your ×${x(result.reveal.targetX100)} bar`
                  : `×${x(result.reveal.resultX100)} — under your ×${x(result.reveal.targetX100)} bar`
                : round
                  ? 'result sealed — name your multiplier'
                  : ''
          }
        >
          {pending ? (
            <span className="anim-climb crashx">×?.??</span>
          ) : result ? (
            <Pop>
              <span className={`crashx ${win ? 'crashx--win' : 'crashx--bust'}`}>
                ×{x(result.reveal.resultX100)}
              </span>
            </Pop>
          ) : (
            <span className="crashx crashx--idle">
              <LimboMark size={86} />
            </span>
          )}
        </Solo>
      );
    },
    options: () => TARGET_OPTIONS([1.5, 2, 3, 5, 10]),
    suspenseMs: 1200,
    reward: () => 'pays × your target',
  },
  mines: {
    Icon: ({ size }) => <MinesMark size={size} />,
    Stage: ({ round, result, pending }) => {
      if (result) {
        const picks = new Set((result.reveal.picks as number[]) ?? []);
        return (
          <Solo
            caption={
              pending
                ? 'revealing the board…'
                : (result.reveal.hit as number[]).length === 0
                  ? `all ${picks.size} picks safe`
                  : 'you found a mine'
            }
          >
            <MinesBoard
              selected={picks}
              mines={pending ? undefined : ((result.reveal.mines as number[]) ?? [])}
              hit={pending ? undefined : ((result.reveal.hit as number[]) ?? [])}
            />
          </Solo>
        );
      }
      return (
        <Solo caption={round ? '5 mines sealed under the commitment — pick below' : ''}>
          <span className="crashx crashx--idle">
            <MinesMark size={86} />
          </span>
        </Solo>
      );
    },
    Picker: MinesPicker,
    suspenseMs: 900,
    reward: () => 'pays up to ×8.39',
  },
  rps: {
    Icon: ({ size }) => <HandScissors size={size} />,
    Stage: ({ result, pending }) =>
      pending ? (
        // the classic "rock… paper… scissors…" shake while the house resolves
        <Duo
          you={
            <span className="anim-fist">
              <HandRock size={82} />
            </span>
          }
          house={
            <span className="anim-fist anim-fist--alt">
              <HandRock size={82} />
            </span>
          }
        />
      ) : (
        <Duo
          you={
            result ? (
              <Pop>
                <HandOf move={str(result.reveal.playerMove)} size={82} />
              </Pop>
            ) : (
              <HandOf size={82} />
            )
          }
          house={
            result ? (
              <Pop>
                <HandOf move={str(result.reveal.dealerMove)} size={82} />
              </Pop>
            ) : (
              <BotMark size={82} />
            )
          }
        />
      ),
    options: () => [
      { key: 'rock', art: <HandOf move="rock" size={40} />, name: 'rock', choice: 'rock' },
      { key: 'paper', art: <HandOf move="paper" size={40} />, name: 'paper', choice: 'paper' },
      { key: 'scissors', art: <HandOf move="scissors" size={40} />, name: 'scissors', choice: 'scissors' },
    ],
    suspenseMs: 1100,
  },
  wheel: {
    Icon: ({ size }) => <WheelFace size={size} />,
    Stage: ({ round, result, pending }) => {
      const segments = (result?.reveal.segments ?? round?.publicState?.segments) as number[] | undefined;
      return (
        <Solo
          caption={
            pending
              ? 'spinning…'
              : result
                ? `landed ×${str(result.reveal.multiplier)}`
                : round
                  ? 'give it a spin'
                  : ''
          }
        >
          <WheelFx
            segments={segments}
            landIndex={result ? num(result.reveal.segmentIndex) : undefined}
            spinning={pending}
            size={210}
          />
        </Solo>
      );
    },
    rollLabel: 'Spin the wheel',
    suspenseMs: 900,
    settleMs: 3100,
    reward: () => 'pays up to ×5',
  },
  plinko: {
    Icon: ({ size }) => <PlinkoMark size={size} />,
    Stage: ({ round, result, pending }) => {
      const ps = round?.publicState as { rows?: number; multipliers?: number[] } | undefined;
      const mults = (result?.reveal.multipliers ?? ps?.multipliers) as number[] | undefined;
      return (
        <Solo
          caption={
            pending
              ? 'dropping…'
              : result
                ? `landed ×${str(result.reveal.multiplier)}`
                : round
                  ? 'drop when ready'
                  : ''
          }
        >
          <PlinkoFx
            rows={ps?.rows ?? 12}
            multipliers={mults}
            path={result ? (result.reveal.path as number[]) : undefined}
            dropping={pending}
          />
        </Solo>
      );
    },
    rollLabel: 'Drop the ball',
    suspenseMs: 500,
    settleMs: 2500,
    reward: () => 'pays up to ×10',
  },
  dice: {
    Icon: ({ size }) => <Die n={5} size={size} />,
    Stage: ({ result, pending }) => (
      <Duo
        you={
          pending ? (
            <TumblingDie size={78} />
          ) : result ? (
            <Pop>
              <Die n={num(result.reveal.playerRoll)} size={78} />
            </Pop>
          ) : (
            <DieBlank size={78} />
          )
        }
        house={
          pending ? (
            <TumblingDie size={78} accent />
          ) : result ? (
            <Pop>
              <Die n={num(result.reveal.dealerRoll)} size={78} accent />
            </Pop>
          ) : (
            <BotMark size={78} />
          )
        }
      />
    ),
    rollLabel: 'Roll the dice',
    suspenseMs: 1300,
  },
  coin: {
    Icon: ({ size }) => <Coin side="heads" size={size} />,
    Stage: ({ round, result, pending }) => (
      <Solo
        caption={
          pending
            ? 'in the air…'
            : result
              ? `you called ${str(result.reveal.call)}`
              : round
                ? 'coin sealed — call it'
                : ''
        }
      >
        {pending ? (
          <span className="anim-cointoss">
            <Coin side="heads" size={120} />
          </span>
        ) : result ? (
          <Flip>
            <Coin side={str(result.reveal.result) as 'heads' | 'tails'} size={120} />
          </Flip>
        ) : (
          <CoinBlank size={120} />
        )}
      </Solo>
    ),
    options: () => [
      { key: 'heads', art: <Coin side="heads" size={38} />, name: 'heads', choice: 'heads' },
      { key: 'tails', art: <Coin side="tails" size={38} />, name: 'tails', choice: 'tails' },
    ],
    suspenseMs: 1300,
  },
  highlow: {
    Icon: ({ size }) => <Card rank={13} size={size} />,
    Stage: ({ round, result, pending }) => {
      const current = result ? num(result.reveal.current) : num(round?.publicState?.current);
      return (
        <Duo
          you={<Card rank={Number.isFinite(current) ? current : undefined} size={84} />}
          house={
            result ? (
              <Flip>
                <Card rank={num(result.reveal.next)} size={84} />
              </Flip>
            ) : (
              <span className={pending ? 'anim-cardwait' : undefined}>
                <Card hidden size={84} />
              </span>
            )
          }
        />
      );
    },
    options: () => [
      { key: 'higher', art: <span className="gbtn__glyph">↑</span>, name: 'higher', choice: 'higher' },
      { key: 'lower', art: <span className="gbtn__glyph">↓</span>, name: 'lower', choice: 'lower' },
    ],
    suspenseMs: 1000,
  },
  number: {
    Icon: ({ size }) => <NumberTile hidden size={size} />,
    Stage: ({ round, result, pending }) => (
      <Solo
        caption={
          pending
            ? 'unsealing…'
            : result
              ? `you guessed ${str(result.reveal.guess)}`
              : round
                ? 'a number 1–6 is sealed'
                : ''
        }
      >
        {pending ? (
          <CyclingTile size={110} />
        ) : result ? (
          <Flip>
            <NumberTile value={num(result.reveal.secret)} size={110} />
          </Flip>
        ) : (
          <NumberTile hidden size={110} />
        )}
      </Solo>
    ),
    options: () =>
      [1, 2, 3, 4, 5, 6].map((n) => ({
        key: String(n),
        art: <span className="gbtn__glyph">{n}</span>,
        name: '',
        choice: n,
      })),
    suspenseMs: 1200,
  },
};

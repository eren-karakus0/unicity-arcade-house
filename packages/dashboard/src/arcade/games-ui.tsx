import type { ReactNode } from 'react';
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
  { id: 'rps', title: 'Rock · Paper · Scissors', blurb: 'Beat the house’s sealed move.', rewardMult: 1, inputKind: 'choice' },
  { id: 'wheel', title: 'Lucky Wheel', blurb: 'Spin — land a multiplier. ×5 jackpot, two-seed fair.', rewardMult: 5, inputKind: 'seed' },
  { id: 'plinko', title: 'Plinko', blurb: 'Drop the ball — edge buckets pay ×10. Two-seed fair.', rewardMult: 10, inputKind: 'seed' },
  { id: 'dice', title: 'Dice Duel', blurb: 'Higher roll wins — two-seed fair.', rewardMult: 1, inputKind: 'seed' },
  { id: 'coin', title: 'Coin Flip', blurb: 'Call it. Pure 50 / 50.', rewardMult: 1, inputKind: 'choice' },
  { id: 'highlow', title: 'High · Low', blurb: 'Higher or lower than the card?', rewardMult: 1, inputKind: 'choice' },
  { id: 'number', title: 'Lucky Number', blurb: 'Guess 1–6 — nail it for 5×.', rewardMult: 5, inputKind: 'choice' },
];

export interface Option {
  key: string;
  art: ReactNode;
  name: string;
  choice: unknown;
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
  rollLabel?: string;
  /** Hold the verdict this long after the result so the reveal can land. */
  settleMs?: number;
  /** Custom picker reward line (e.g. variable-multiplier games). */
  reward?: (base: number) => string;
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

/** One-shot reveal animations — remount per result so they replay. */
const Pop = ({ children }: { children: ReactNode }) => <span className="anim-pop">{children}</span>;
const Flip = ({ children }: { children: ReactNode }) => <span className="anim-flip">{children}</span>;

export const GAME_UI: Record<string, GameUI> = {
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
    settleMs: 3100,
    reward: (base) => `win up to ${base * 5} UCT`,
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
    settleMs: 2500,
    reward: (base) => `win up to ${base * 10} UCT`,
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
  },
};

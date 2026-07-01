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
  HandScissors,
  NumberTile,
} from './art';

export const GAMES_META: GameMeta[] = [
  { id: 'rps', title: 'Rock · Paper · Scissors', blurb: 'Beat the house’s sealed move.', rewardMult: 1, inputKind: 'choice' },
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

export const GAME_UI: Record<string, GameUI> = {
  rps: {
    Icon: ({ size }) => <HandScissors size={size} />,
    Stage: ({ result }) => (
      <Duo
        you={<HandOf move={result ? str(result.reveal.playerMove) : undefined} size={82} />}
        house={result ? <HandOf move={str(result.reveal.dealerMove)} size={82} /> : <BotMark size={82} />}
      />
    ),
    options: () => [
      { key: 'rock', art: <HandOf move="rock" size={40} />, name: 'rock', choice: 'rock' },
      { key: 'paper', art: <HandOf move="paper" size={40} />, name: 'paper', choice: 'paper' },
      { key: 'scissors', art: <HandOf move="scissors" size={40} />, name: 'scissors', choice: 'scissors' },
    ],
  },
  dice: {
    Icon: ({ size }) => <Die n={5} size={size} />,
    Stage: ({ result }) => (
      <Duo
        you={result ? <Die n={num(result.reveal.playerRoll)} size={78} /> : <DieBlank size={78} />}
        house={result ? <Die n={num(result.reveal.dealerRoll)} size={78} accent /> : <BotMark size={78} />}
      />
    ),
    rollLabel: 'Roll the dice',
  },
  coin: {
    Icon: ({ size }) => <Coin side="heads" size={size} />,
    Stage: ({ round, result }) => (
      <Solo caption={result ? `you called ${str(result.reveal.call)}` : round ? 'coin sealed — call it' : ''}>
        {result ? <Coin side={str(result.reveal.result) as 'heads' | 'tails'} size={120} /> : <CoinBlank size={120} />}
      </Solo>
    ),
    options: () => [
      { key: 'heads', art: <Coin side="heads" size={38} />, name: 'heads', choice: 'heads' },
      { key: 'tails', art: <Coin side="tails" size={38} />, name: 'tails', choice: 'tails' },
    ],
  },
  highlow: {
    Icon: ({ size }) => <Card rank={13} size={size} />,
    Stage: ({ round, result }) => {
      const current = result ? num(result.reveal.current) : num(round?.publicState?.current);
      return (
        <Duo
          you={<Card rank={Number.isFinite(current) ? current : undefined} size={84} />}
          house={result ? <Card rank={num(result.reveal.next)} size={84} /> : <Card hidden size={84} />}
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
    Stage: ({ round, result }) => (
      <Solo caption={result ? `you guessed ${str(result.reveal.guess)}` : round ? 'a number 1–6 is sealed' : ''}>
        {result ? <NumberTile value={num(result.reveal.secret)} size={110} /> : <NumberTile hidden size={110} />}
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

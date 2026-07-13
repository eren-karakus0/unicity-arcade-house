/**
 * The blackjack table — the arcade's first multi-step game surface. The whole
 * shoe is committed before the first card shows (sha256 of the deck seed);
 * hit / stand / double advance the hand on the server, and the finished hand
 * settles through the exact same pipeline as every one-shot game — so the
 * verdict below is a standard PlayResult (XP, jackpot roll, achievements and
 * all), and the reveal is verified card-by-card right here in the browser.
 */
import { useEffect, useRef, useState } from 'react';
import {
  newTable,
  stepTable,
  verifyCommit,
  verifyBlackjack,
  type PlayResult,
  type PlayerSnapshot,
  type TableView,
} from '../lib/arcade';
import { Card } from './art';
import { sfx } from './sound';

/** Our card code (0..51, rank = code % 13, 0=A) → the art Card's 1..13 rank. */
const artRank = (code: number): number => (code % 13) + 1;

function HandRow({ label, cards, total, hole }: { label: string; cards: number[]; total?: number | string; hole?: boolean }) {
  return (
    <div className="bj__hand">
      <span className="bj__handlabel">{label}</span>
      <div className="bj__cards">
        {cards.map((c, i) => (
          <span className="bj__card anim-pop" key={`${c}-${i}`}>
            <Card rank={artRank(c)} size={72} />
          </span>
        ))}
        {hole && (
          <span className="bj__card">
            <Card hidden size={72} />
          </span>
        )}
      </div>
      {total !== undefined && <span className="bj__total">{total}</span>}
    </div>
  );
}

export function BlackjackTable({
  address,
  name,
  chips,
  onSettled,
}: {
  address?: string;
  name?: string;
  chips: number;
  onSettled: (res: PlayResult) => void;
}) {
  const [bet, setBet] = useState(1);
  const [view, setView] = useState<TableView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verified, setVerified] = useState<boolean | null>(null);
  const settledFor = useRef<string | null>(null);

  const result = view?.result ?? null;
  const hand = view?.hand ?? null;
  const open = !!view && !result;

  // A finished hand: absorb the standard result once + verify the shoe.
  useEffect(() => {
    if (!result || settledFor.current === result.roundId) return;
    settledFor.current = result.roundId;
    onSettled(result);
    sfx[result.outcome === 'win' ? 'win' : 'click']();
    setVerified(null);
    void (async () => {
      let ok = await verifyCommit(result.secret, result.nonce, result.commit);
      if (ok) {
        ok = await verifyBlackjack(result.secret, {
          player: (result.reveal.player as number[]) ?? [],
          dealer: (result.reveal.dealer as number[]) ?? [],
        });
      }
      setVerified(ok);
    })();
  }, [result, onSettled]);

  const deal = async () => {
    if (busy || !address) return;
    setBusy(true);
    setError(null);
    setVerified(null);
    sfx.click();
    try {
      setView(await newTable('blackjack', bet, address, name));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not deal.');
    } finally {
      setBusy(false);
    }
  };

  const act = async (action: 'hit' | 'stand' | 'double') => {
    if (!view || busy || !open) return;
    setBusy(true);
    setError(null);
    sfx.click();
    try {
      setView(await stepTable(view.roundId, action, address));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed.');
    } finally {
      setBusy(false);
    }
  };

  const you: PlayerSnapshot | undefined = view?.you;
  const balance = you?.chips ?? chips;

  return (
    <div className="bj">
      {!view || result ? (
        <>
          {result && hand && (
            <div className="bj__table">
              <HandRow label="dealer" cards={hand.dealer ?? []} total={hand.dealerTotal} />
              <HandRow label="you" cards={hand.player} total={`${hand.playerTotal}${hand.doubled ? ' · doubled' : ''}`} />
            </div>
          )}
          {result && (
            <div className="outcome">
              <div className={`gverdict verdict--${result.outcome}`}>
                {result.outcome === 'win'
                  ? `YOU WON +${result.rewardUct} UCT${result.reveal.playerBlackjack ? ' — BLACKJACK pays 3:2' : ''}`
                  : result.outcome === 'lose'
                    ? `YOU LOST ${result.bet} UCT`
                    : 'PUSH — your bet came back'}
              </div>
              <div className="outcome__verify">
                {verified === null ? (
                  <span className="verify verify--wait">verifying the shoe…</span>
                ) : verified ? (
                  <span className="verify verify--ok">
                    🔐 provably fair — every card matches the committed shoe
                  </span>
                ) : (
                  <span className="verify verify--bad">⚠ the shoe did not verify</span>
                )}
              </div>
            </div>
          )}
          <div className="betbar">
            <span className="betbar__label">bet</span>
            {[1, 5, 10, 25].map((b) => (
              <button
                key={b}
                className={`betbtn${bet === b ? ' betbtn--on' : ''}`}
                onClick={() => {
                  sfx.bet();
                  setBet(b);
                }}
                disabled={balance < b}
              >
                {b}
              </button>
            ))}
            <input
              className="betinput"
              type="number"
              min={1}
              step={1}
              value={bet}
              onChange={(e) => setBet(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
              aria-label="bet amount in chips"
            />
            <span className="betbar__unit">UCT</span>
            {balance < bet && <span className="betbar__empty">bet is over your {balance} UCT balance</span>}
          </div>
          <div className="gbtns">
            <button className="again" onClick={() => void deal()} disabled={busy || !address || balance < bet}>
              {busy ? 'dealing…' : result ? 'Deal a new hand' : 'Deal me in'}
            </button>
          </div>
        </>
      ) : (
        hand && (
          <>
            <div className="bj__table">
              <HandRow label="dealer" cards={[hand.dealerUp]} hole />
              <HandRow
                label="you"
                cards={hand.player}
                total={`${hand.playerTotal}${hand.playerSoft ? ' soft' : ''}`}
              />
            </div>
            <div className="commit">
              🔒 <strong>the shoe is sealed</strong> — every card ahead is already fixed by the commitment.
              <div className="commit__hash" title="sha256(deck seed : nonce) — commitment to the whole deck order">
                commitment <code>{view.commit.slice(0, 16)}…</code>
              </div>
            </div>
            <div className="gbtns gbtns--3">
              <button className="gbtn" onClick={() => void act('hit')} disabled={busy}>
                <span className="gbtn__name">hit</span>
              </button>
              <button className="gbtn" onClick={() => void act('stand')} disabled={busy}>
                <span className="gbtn__name">stand</span>
              </button>
              <button
                className="gbtn"
                onClick={() => void act('double')}
                disabled={busy || !hand.canDouble || balance < view.bet}
                title={hand.canDouble ? `stake another ${view.bet} UCT, take one card, stand` : 'only on your first two cards'}
              >
                <span className="gbtn__name">double</span>
              </button>
            </div>
          </>
        )
      )}
      {error && <div className="tryit__error">⚠ {error}</div>}
    </div>
  );
}

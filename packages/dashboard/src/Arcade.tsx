import { useCallback, useEffect, useRef, useState } from 'react';
import { useWalletCtx } from './WalletContext';
import {
  fetchLeaderboard,
  hasBackend,
  makeClientSeed,
  newRound,
  playRound,
  verifyCommit,
  verifyDice,
  type GameMeta,
  type LeaderRow,
  type NewRound,
  type PlayerSnapshot,
  type PlayResult,
} from './lib/arcade';
import { GAME_UI, GAMES_META } from './arcade/games-ui';
import { BotMark, Flame } from './arcade/art';

interface IdLike {
  nametag?: string;
  directAddress?: string;
  chainPubkey?: string;
}
const addressOf = (id: IdLike): string | undefined =>
  id.directAddress ?? id.chainPubkey ?? (id.nametag ? `@${id.nametag}` : undefined);
const nameOf = (id: IdLike): string => {
  if (id.nametag) return id.nametag.replace(/^@/, '');
  if (id.directAddress) return `${id.directAddress.slice(0, 10)}…`;
  return 'anon';
};

export function Arcade() {
  const wallet = useWalletCtx();
  const connected = wallet.status === 'connected' && !!wallet.identity;

  const [selected, setSelected] = useState('rps');
  const [ready, setReady] = useState<boolean | null>(null);
  const [round, setRound] = useState<NewRound | null>(null);
  const [result, setResult] = useState<PlayResult | null>(null);
  const [verified, setVerified] = useState<boolean | null>(null);
  const [status, setStatus] = useState<'idle' | 'playing'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [board, setBoard] = useState<LeaderRow[]>([]);
  const [games, setGames] = useState<GameMeta[]>(GAMES_META);
  const [house, setHouse] = useState<string | null>(null);
  const [baseReward, setBaseReward] = useState(1);
  const [you, setYou] = useState<PlayerSnapshot | null>(null);
  const [dailyDef, setDailyDef] = useState<{ goal: number; reward: number } | null>(null);
  const dealing = useRef(false);

  const meta = games.find((g) => g.id === selected) ?? GAMES_META.find((g) => g.id === selected)!;
  const ui = GAME_UI[selected]!;

  const applyBoard = useCallback((b: Awaited<ReturnType<typeof fetchLeaderboard>>) => {
    setBoard(b.rows);
    if (b.house) setHouse(b.house);
    if (b.baseRewardUct) setBaseReward(b.baseRewardUct);
    if (b.games?.length) setGames(b.games);
    if (b.daily) setDailyDef(b.daily);
  }, []);

  const refreshBoard = useCallback(() => {
    void fetchLeaderboard().then(applyBoard).catch(() => {});
  }, [applyBoard]);

  // Poll readiness — the free-tier backend cold-starts; keep probing (which
  // warms it) until the dealer is live.
  useEffect(() => {
    if (!connected) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const probe = async () => {
      try {
        const b = await fetchLeaderboard();
        if (!alive) return;
        applyBoard(b);
        if (b.ready) {
          setReady(true);
          return;
        }
      } catch {
        /* cold start / transient */
      }
      if (!alive) return;
      setReady(false);
      timer = setTimeout(probe, 5000);
    };
    void probe();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [connected, applyBoard]);

  const deal = useCallback(
    async (gameId: string) => {
      if (!connected || dealing.current || !wallet.identity) return;
      dealing.current = true;
      setError(null);
      try {
        const r = await newRound(gameId, addressOf(wallet.identity));
        setRound(r);
        setHouse(r.house);
        if (r.you) setYou(r.you);
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Could not start a round.';
        if (/timed out|waking up|failed to fetch|load failed/i.test(msg)) setReady(false);
        else setError(msg);
      } finally {
        dealing.current = false;
      }
    },
    [connected, wallet.identity],
  );

  // Auto-deal the selected game once the dealer is live and nothing is in play.
  useEffect(() => {
    if (connected && ready && !round && !result) void deal(selected);
  }, [connected, ready, round, result, selected, deal]);

  const selectGame = (id: string) => {
    if (id === selected) return;
    setSelected(id);
    setRound(null);
    setResult(null);
    setVerified(null);
    setError(null);
  };

  const play = async (choice: unknown) => {
    if (!round || status !== 'idle' || !wallet.identity) return;
    setStatus('playing');
    setError(null);
    try {
      const res = await playRound({
        game: selected,
        roundId: round.roundId,
        choice,
        address: addressOf(wallet.identity),
        name: nameOf(wallet.identity),
      });
      setRound(null);
      setResult(res);
      setYou({ streak: res.streak, best: res.best, daily: res.daily });
      setVerified(null);
      void (async () => {
        let ok = await verifyCommit(res.secret, res.nonce, res.commit);
        if (ok && res.game === 'dice') {
          ok = await verifyDice(res.secret, String(res.reveal.clientSeed), {
            dealerRoll: Number(res.reveal.dealerRoll),
            playerRoll: Number(res.reveal.playerRoll),
          });
        }
        setVerified(ok);
      })();
      refreshBoard();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Play failed.');
    } finally {
      setStatus('idle');
    }
  };

  const again = () => {
    setResult(null);
    setVerified(null);
  };

  if (!hasBackend()) {
    return (
      <section className="arcade">
        <div className="empty">The arcade needs the live backend — it isn&apos;t configured here.</div>
      </section>
    );
  }

  if (!connected) {
    return (
      <section className="arcade">
        <Hero house={house} />
        <div className="empty empty--locked">
          <div className="empty__lock">🔒</div>
          <div>Connect your Unicity wallet to play and get paid.</div>
          <button
            className="empty__connect"
            onClick={() => void wallet.connect()}
            disabled={wallet.status === 'connecting'}
          >
            {wallet.status === 'connecting' ? 'Connecting…' : 'Connect Wallet'}
          </button>
        </div>
      </section>
    );
  }

  const outcome = result?.outcome;

  return (
    <section className="arcade">
      <Hero house={house} />

      <EventsBar you={you} dailyDef={dailyDef} />

      <div className="picker">
        {games
          .filter((g) => GAME_UI[g.id])
          .map((g) => {
            const Icon = GAME_UI[g.id]!.Icon;
            return (
              <button
                key={g.id}
                className={`gcard${g.id === selected ? ' gcard--on' : ''}`}
                onClick={() => selectGame(g.id)}
              >
                <div className="gcard__art">
                  <Icon size={40} />
                </div>
                <div className="gcard__title">{g.title}</div>
                <div className="gcard__reward">win {baseReward * g.rewardMult} UCT</div>
              </button>
            );
          })}
      </div>

      <div className="table">
        <div className="table__head">
          <span className="table__title">{meta.title}</span>
          <span className="table__blurb">{meta.blurb}</span>
        </div>

        <ui.Stage round={round} result={result} pending={status === 'playing'} />

        {ready !== true ? (
          <div className="commit commit--wait">
            <span className="dot" /> waking the dealer… free-tier cold start, up to ~1 min
          </div>
        ) : !result ? (
          <>
            {status === 'playing' ? (
              <div className="commit commit--wait">
                <span className="dot" /> revealing &amp; settling any payout on-chain…
              </div>
            ) : round ? (
              <div className="commit">
                🔒 <strong>fairness lock</strong> — the house&apos;s hidden value is sealed now; play, then verify it.
                <div
                  className="commit__hash"
                  title="sha256(the house's secret + a nonce). Not a transaction — the commitment proving the house can't change its value after you act."
                >
                  commitment <code>{round.commit.slice(0, 16)}…</code>
                </div>
              </div>
            ) : (
              <div className="commit commit--wait">
                <span className="dot" /> dealing a fresh round…
              </div>
            )}

            {meta.inputKind === 'seed' ? (
              <div className="gbtns">
                <button
                  className="again"
                  onClick={() => void play(makeClientSeed())}
                  disabled={!round || status === 'playing'}
                >
                  {ui.rollLabel ?? 'Play'}
                </button>
              </div>
            ) : (
              <div className={`gbtns gbtns--${(ui.options?.(round) ?? []).length}`}>
                {(ui.options?.(round) ?? []).map((o) => (
                  <button
                    key={o.key}
                    className="gbtn"
                    onClick={() => void play(o.choice)}
                    disabled={!round || status === 'playing'}
                    aria-label={o.name || o.key}
                  >
                    <span className="gbtn__art">{o.art}</span>
                    {o.name && <span className="gbtn__name">{o.name}</span>}
                  </button>
                ))}
              </div>
            )}
          </>
        ) : (
          <div className="outcome">
            <div className={`gverdict verdict--${outcome}`}>
              {outcome === 'win' ? `YOU WON +${result.rewardUct} UCT` : outcome === 'lose' ? 'YOU LOST' : 'PUSH'}
            </div>
            <div className="outcome__pay">
              {outcome === 'win' ? (
                result.paid ? (
                  <span className="pay pay--ok">✓ {result.rewardUct} UCT sent to your wallet</span>
                ) : (
                  <span className="pay pay--pend">payout pending — {result.payoutError ?? 'retrying on testnet'}</span>
                )
              ) : outcome === 'tie' ? (
                <span className="pay">a push — no payout, go again</span>
              ) : (
                <span className="pay">the house took this one</span>
              )}
            </div>
            {outcome === 'win' && (result.streakBonus > 0 || result.dailyBonus > 0) && (
              <div className="bonusline">
                includes
                {result.streakBonus > 0 ? ` streak bonus +${result.streakBonus}` : ''}
                {result.streakBonus > 0 && result.dailyBonus > 0 ? ' ·' : ''}
                {result.dailyBonus > 0 ? ` daily bonus +${result.dailyBonus}` : ''} UCT
              </div>
            )}
            {outcome === 'win' && result.paid && result.txId && (
              <TxProof id={result.txId} delivery={result.delivery} />
            )}
            <div className="outcome__verify">
              {verified === null ? (
                <span className="verify verify--wait">verifying fairness…</span>
              ) : verified ? (
                <span className="verify verify--ok">🔐 provably fair — the reveal matches the sealed commitment</span>
              ) : (
                <span className="verify verify--bad">⚠ commitment did not verify</span>
              )}
            </div>
            <button className="again" onClick={again}>
              Play again
            </button>
          </div>
        )}

        {error && <div className="tryit__error">⚠ {error}</div>}
      </div>

      <div className="board">
        <div className="board__head">
          <span className="board__title">Leaderboard</span>
          <span className="board__note">across all games · resets on redeploy</span>
        </div>
        {board.length === 0 ? (
          <div className="empty">No games yet — be the first to beat the house.</div>
        ) : (
          <div className="board__rows">
            {board.map((r, i) => (
              <div className="brow" key={r.name}>
                <span className="brow__rank">{i + 1}</span>
                <span className="brow__name">@{r.name}</span>
                <span className="brow__wl">
                  {r.wins}W · {r.losses}L · {r.ties}T
                </span>
                <span className="brow__earned">{r.earnedUct} UCT</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function Hero({ house }: { house: string | null }) {
  return (
    <div className="arcade__hero">
      <h2 className="arcade__title">Agent Arcade</h2>
      <p className="arcade__lede">
        A hall of provably-fair games vs an autonomous house. Win and it pays you real testnet UCT
        on-chain — automatically, no human in the loop.
      </p>
      <div className="arcade__meta">
        <span className="arcade__chip arcade__chip--house">
          <BotMark size={15} /> house {house ? `@${house}` : '…'}
        </span>
        <span className="arcade__chip" title="Every game commits sha256(secret:nonce) before you act.">
          provably fair
        </span>
        <span className="arcade__chip">on-chain payouts</span>
      </div>
    </div>
  );
}

function EventsBar({
  you,
  dailyDef,
}: {
  you: PlayerSnapshot | null;
  dailyDef: { goal: number; reward: number } | null;
}) {
  const streak = you?.streak ?? 0;
  const goal = you?.daily.goal ?? dailyDef?.goal ?? 5;
  const wins = you?.daily.wins ?? 0;
  const claimed = you?.daily.claimed ?? false;
  const reward = dailyDef?.reward ?? 10;
  const pct = claimed ? 100 : Math.min(100, Math.round((wins / goal) * 100));
  return (
    <div className="events">
      <div className="events__streak">
        <Flame size={22} dim={streak === 0} />
        <span className="events__streak-n">{streak > 0 ? `${streak} win streak` : 'no streak yet'}</span>
        {!!you && you.best > 0 && <span className="events__best">best {you.best}</span>}
      </div>
      <div className="events__daily">
        <div className="events__daily-top">
          <span>Daily challenge · win {goal}</span>
          <span className="events__daily-reward">{claimed ? '✓ claimed' : `+${reward} UCT`}</span>
        </div>
        <div className="events__bar">
          <div className="events__fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="events__daily-sub">{claimed ? 'done for today' : `${wins} / ${goal} wins today`}</div>
      </div>
    </div>
  );
}

function TxProof({ id, delivery }: { id: string; delivery?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard
      ?.writeText(id)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {});
  };
  const badge =
    delivery === 'landed'
      ? 'on-chain ✓ landed'
      : delivery === 'pending-delivery'
        ? 'on-chain ✓ delivering'
        : 'on-chain ✓ settled';
  return (
    <div className="txproof" title="Sphere aggregator transfer id — your payout, settled on Unicity testnet2.">
      <span className="txproof__badge">{badge}</span>
      <code className="txproof__id">
        transfer {id.slice(0, 10)}…{id.length > 18 ? id.slice(-6) : ''}
      </code>
      <button className="txproof__copy" onClick={copy}>
        {copied ? 'copied ✓' : 'copy id'}
      </button>
    </div>
  );
}

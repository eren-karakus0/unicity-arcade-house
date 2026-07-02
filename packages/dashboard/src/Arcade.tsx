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
  verifyWheel,
  type GameMeta,
  type HouseEvent,
  type HouseStats,
  type LeaderRow,
  type NewRound,
  type PlayerSnapshot,
  type PlayResult,
} from './lib/arcade';
import { GAME_UI, GAMES_META } from './arcade/games-ui';
import { BotMark, Flame } from './arcade/art';
import { WinBurst } from './arcade/fx';

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
  const [houseStats, setHouseStats] = useState<HouseStats | null>(null);
  const [baseReward, setBaseReward] = useState(1);
  const [you, setYou] = useState<PlayerSnapshot | null>(null);
  const [dailyDef, setDailyDef] = useState<{ goal: number; reward: number } | null>(null);
  // Holds the verdict while a reveal animation (e.g. the wheel) lands.
  const [settling, setSettling] = useState(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dealing = useRef(false);

  useEffect(() => () => clearTimeout(settleTimer.current), []);

  const meta = games.find((g) => g.id === selected) ?? GAMES_META.find((g) => g.id === selected)!;
  const ui = GAME_UI[selected]!;

  const applyBoard = useCallback((b: Awaited<ReturnType<typeof fetchLeaderboard>>) => {
    setBoard(b.rows);
    if (b.house) setHouse(b.house);
    if (b.baseRewardUct) setBaseReward(b.baseRewardUct);
    if (b.games?.length) setGames(b.games);
    if (b.daily) setDailyDef(b.daily);
    if (b.houseStats) setHouseStats(b.houseStats);
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

  // Keep the ticker + house panel fresh while the hall is open.
  useEffect(() => {
    if (!connected || ready !== true) return;
    const t = setInterval(refreshBoard, 15_000);
    return () => clearInterval(t);
  }, [connected, ready, refreshBoard]);

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
    clearTimeout(settleTimer.current);
    setSettling(false);
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
      if (res.daily) setYou({ streak: res.streak, best: res.best, daily: res.daily });
      setVerified(null);
      const settleMs = GAME_UI[res.game]?.settleMs ?? 0;
      if (settleMs > 0) {
        setSettling(true);
        clearTimeout(settleTimer.current);
        settleTimer.current = setTimeout(() => setSettling(false), settleMs);
      }
      void (async () => {
        let ok = await verifyCommit(res.secret, res.nonce, res.commit);
        if (ok && res.game === 'dice') {
          ok = await verifyDice(res.secret, String(res.reveal.clientSeed), {
            dealerRoll: Number(res.reveal.dealerRoll),
            playerRoll: Number(res.reveal.playerRoll),
          });
        }
        if (ok && res.game === 'wheel') {
          const segs = res.reveal.segments as unknown[] | undefined;
          ok = await verifyWheel(res.secret, String(res.reveal.clientSeed), {
            segmentIndex: Number(res.reveal.segmentIndex),
            segmentCount: segs?.length ?? 10,
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

      <HouseTicker feed={houseStats?.feed ?? []} games={games} />

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
                <div className="gcard__reward">
                  {GAME_UI[g.id]!.reward?.(baseReward) ?? `win ${baseReward * g.rewardMult} UCT`}
                </div>
              </button>
            );
          })}
      </div>

      <div className="table">
        {outcome === 'win' && !settling && <WinBurst key={result!.nonce} />}
        <div className="table__head">
          <span className="table__title">{meta.title}</span>
          <span className="table__blurb">{meta.blurb}</span>
        </div>

        <ui.Stage round={round} result={result} pending={status === 'playing' || settling} />

        {ready !== true ? (
          <div className="commit commit--wait">
            <span className="dot" /> waking the dealer… free-tier cold start, up to ~1 min
          </div>
        ) : !result || settling ? (
          <>
            {status === 'playing' || settling ? (
              <div className="commit commit--wait">
                <span className="dot" />{' '}
                {settling ? 'watch it land…' : 'revealing & settling any payout on-chain…'}
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

      <HousePanel stats={houseStats} house={house} games={games} />
    </section>
  );
}

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

const gameTitle = (games: GameMeta[], id?: string) => games.find((g) => g.id === id)?.title ?? id ?? 'a game';

/** Scrolling strip of real recent payouts from the house feed. */
function HouseTicker({ feed, games }: { feed: HouseEvent[]; games: GameMeta[] }) {
  const wins = feed.filter((e) => e.kind === 'win').slice(0, 8);
  if (wins.length === 0) return null;
  const items = (dup: boolean) =>
    wins.map((w, i) => (
      <span className="ticker__item" key={`${dup ? 'd' : 'a'}${i}`} aria-hidden={dup}>
        <strong>@{w.name}</strong> won {w.amountUct} UCT on {gameTitle(games, w.game)}
        <em> · {timeAgo(w.at)}</em>
      </span>
    ));
  return (
    <div className="ticker" aria-label="recent wins, paid on-chain by the house agent">
      <span className="ticker__tag">live wins</span>
      <div className="ticker__clip">
        <div className="ticker__track">
          {items(false)}
          {items(true)}
        </div>
      </div>
    </div>
  );
}

/** Live transparency for the autonomous house — real balances, real events. */
function HousePanel({
  stats,
  house,
  games,
}: {
  stats: HouseStats | null;
  house: string | null;
  games: GameMeta[];
}) {
  if (!stats) return null;
  return (
    <div className="housep">
      <div className="housep__head">
        <BotMark size={20} />
        <span className="housep__title">The House — autonomous agent</span>
        <span className="housep__tag">{house ? `@${house}` : '…'}</span>
      </div>
      <div className="housep__grid">
        <Stat value={stats.treasuryUct === null ? '…' : `${stats.treasuryUct} UCT`} label="treasury, live" />
        <Stat value={`${stats.paidOutUct} UCT`} label="paid to players" />
        <Stat value={String(stats.roundsPlayed)} label="rounds dealt" />
        <Stat value={`${stats.selfMintedUct} UCT`} label="self-funded" />
      </div>
      {stats.feed.length > 0 && (
        <div className="housep__feed">
          {stats.feed.slice(0, 6).map((e, i) => (
            <div className={`hevent${e.kind === 'mint' ? ' hevent--mint' : ''}`} key={`${e.at}-${i}`}>
              <span>
                {e.kind === 'mint'
                  ? `treasury low — the agent minted itself +${e.amountUct} UCT`
                  : `paid @${e.name} +${e.amountUct} UCT · ${gameTitle(games, e.game)}`}
              </span>
              <span className="hevent__t">{timeAgo(e.at)}</span>
            </div>
          ))}
        </div>
      )}
      <div className="housep__note">
        every number above is real: balance read from the wallet, payouts settled on testnet2 · since last restart
      </div>
    </div>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="stat">
      <div className="stat__v">{value}</div>
      <div className="stat__l">{label}</div>
    </div>
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
  const goal = you?.daily?.goal ?? dailyDef?.goal ?? 5;
  const wins = you?.daily?.wins ?? 0;
  const claimed = you?.daily?.claimed ?? false;
  const reward = dailyDef?.reward ?? 10;
  const pct = claimed ? 100 : Math.min(100, Math.round((wins / goal) * 100));
  return (
    <div className="events">
      <div className="events__streak">
        <span
          className={`events__flame${streak > 0 ? ' events__flame--lit' : ''}${streak >= 5 ? ' events__flame--hot' : ''}`}
        >
          <Flame size={20 + Math.min(streak, 10) * 1.5} dim={streak === 0} />
        </span>
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

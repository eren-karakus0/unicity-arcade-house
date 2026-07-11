import { useCallback, useEffect, useRef, useState } from 'react';
import { useWalletCtx } from './WalletContext';
import {
  cashOut,
  fetchLeaderboard,
  fetchSettlement,
  hasBackend,
  makeClientSeed,
  newRound,
  playRound,
  verifyCommit,
  verifyDice,
  verifyJackpot,
  verifyPlinko,
  verifyWheel,
  fetchBalance,
  fetchTournament,
  pendingRef,
  clearRef,
  type AchievementView,
  type TournamentView,
  type DepositInfo,
  type GameMeta,
  type HouseEvent,
  type HouseStats,
  type LeaderRow,
  type NewRound,
  type PlayerSnapshot,
  type PlayResult,
  type RoundSettlement,
} from './lib/arcade';
import { saveProof } from './lib/fairness';
import { AchievementToast } from './arcade/Achievements';
import { TournamentPanel } from './arcade/Tournament';
import { GAME_UI, GAMES_META } from './arcade/games-ui';
import { BotMark, Flame, LockMark, WheelFace } from './arcade/art';
import { WinBurst } from './arcade/fx';
import { sfx } from './arcade/sound';

interface IdLike {
  nametag?: string;
  directAddress?: string;
  chainPubkey?: string;
}
// Canonical player key = chain pubkey: it is what incoming wallet transfers
// carry as the sender, so deposits match the same balance the games use.
const addressOf = (id: IdLike): string | undefined =>
  id.chainPubkey ?? id.directAddress ?? (id.nametag ? `@${id.nametag}` : undefined);
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
  const [pot, setPot] = useState<number | null>(null);
  const [you, setYou] = useState<PlayerSnapshot | null>(null);
  const [dailyDef, setDailyDef] = useState<{ goal: number; reward: number } | null>(null);
  // A queue of freshly-earned achievements (+ referral welcome) to toast on the floor.
  const [achQueue, setAchQueue] = useState<AchievementView[]>([]);
  const [tourney, setTourney] = useState<TournamentView | null>(null);
  // The round's background on-chain payout (win/jackpot), polled until it lands.
  const [stl, setStl] = useState<RoundSettlement | null>(null);
  // Chips staked per round.
  const [bet, setBet] = useState(1);
  // In-flight withdraw (balance → on-chain UCT), polled until it lands.
  // 'slow' = still settling after our polling window — it arrives, we just stop watching.
  const [cash, setCash] = useState<{ id: string; amount: number; status: 'pending' | 'landed' | 'failed' | 'slow'; txId?: string } | null>(null);
  // Wallet deposit (real UCT via the wallet's send-intent approval UI).
  const [depInfo, setDepInfo] = useState<DepositInfo | null>(null);
  const [depOpen, setDepOpen] = useState(false);
  const [depAmt, setDepAmt] = useState(10);
  const [dep, setDep] = useState<{
    status: 'approving' | 'crediting' | 'done' | 'failed';
    amount: number;
    /** Credited so far (deposits split into several tokens and trickle in). */
    credited?: number;
    error?: string;
  } | null>(null);
  // Reveal pacing: `suspense` keeps the pending animation running before the
  // reveal shows; `settling` holds the verdict while a landing animation
  // (wheel, plinko) plays out. The result itself is already committed.
  const [suspense, setSuspense] = useState(false);
  const [settling, setSettling] = useState(false);
  const suspenseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dealing = useRef(false);
  const hold = suspense || settling;

  useEffect(
    () => () => {
      clearTimeout(settleTimer.current);
      clearTimeout(suspenseTimer.current);
    },
    [],
  );

  const meta = games.find((g) => g.id === selected) ?? GAMES_META.find((g) => g.id === selected)!;
  const ui = GAME_UI[selected]!;

  const applyBoard = useCallback((b: Awaited<ReturnType<typeof fetchLeaderboard>>) => {
    setBoard(b.rows);
    if (b.house) setHouse(b.house);
    if (b.games?.length) setGames(b.games);
    if (b.daily) setDailyDef(b.daily);
    if (b.deposit) setDepInfo(b.deposit);
    if (b.houseStats) {
      setHouseStats(b.houseStats);
      if (b.houseStats.jackpotUct != null) setPot(b.houseStats.jackpotUct);
    }
  }, []);

  const refreshBoard = useCallback(() => {
    void fetchLeaderboard().then(applyBoard).catch(() => {});
  }, [applyBoard]);

  const refreshTournament = useCallback(() => {
    void fetchTournament().then(setTourney).catch(() => {});
  }, []);

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

  // Keep the ticker + house panel fresh while the hall is open, and sync the
  // balance (late-arriving deposit tokens land silently in the background).
  useEffect(() => {
    if (!connected || ready !== true) return;
    const addr = wallet.identity ? addressOf(wallet.identity) : undefined;
    const tick = () => {
      refreshBoard();
      refreshTournament();
      if (addr) {
        void fetchBalance(addr)
          .then((b) => setYou((prev) => (prev && b.balanceUct !== prev.chips ? { ...prev, chips: b.balanceUct } : prev)))
          .catch(() => {});
      }
    };
    const t = setInterval(tick, 15_000);
    return () => clearInterval(t);
  }, [connected, ready, refreshBoard, refreshTournament, wallet.identity]);

  // Locked landing: tease the REAL floor behind the glass (live pot + payout
  // feed) — and warm the dealer up before the player even connects.
  useEffect(() => {
    if (connected) return;
    refreshBoard();
    const t = setInterval(refreshBoard, 30_000);
    return () => clearInterval(t);
  }, [connected, refreshBoard]);

  // Load the live tournament once the hall is live.
  useEffect(() => {
    if (!connected || ready !== true) return;
    refreshTournament();
  }, [connected, ready, refreshTournament]);

  // Poll the jackpot's background on-chain payout until it lands (or fails).
  useEffect(() => {
    if (!result) {
      setStl(null);
      return;
    }
    if (!result.jackpot?.hit) return;
    let alive = true;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      tries += 1;
      let done = false;
      try {
        const s = await fetchSettlement(result.roundId);
        if (!alive) return;
        setStl(s);
        done = s.jackpot !== undefined && s.jackpot.status !== 'pending';
        if (done) refreshBoard();
      } catch {
        /* transient — keep polling */
      }
      if (alive && !done && tries < 20) timer = setTimeout(poll, 1300);
    };
    timer = setTimeout(poll, 800);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [result, refreshBoard]);

  // Poll an in-flight withdraw until the UCT transfer lands. Sends can take a
  // couple of minutes when the treasury tops itself up first — poll long, and
  // if it is STILL settling afterwards, stop watching without blocking the UI.
  useEffect(() => {
    if (!cash || cash.status !== 'pending') return;
    let alive = true;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      tries += 1;
      try {
        const s = await fetchSettlement(cash.id);
        if (!alive) return;
        if (s.win && s.win.status !== 'pending') {
          setCash({ ...cash, status: s.win.status, txId: s.win.txId });
          if (s.win.status === 'landed') sfx.cashout();
          if (s.win.status === 'failed') {
            // the house put the balance back — mirror it locally
            setYou((prev) => (prev ? { ...prev, chips: prev.chips + cash.amount } : prev));
          }
          refreshBoard();
          return;
        }
      } catch {
        /* transient — keep polling */
      }
      if (alive && tries < 60) {
        timer = setTimeout(poll, 2000);
      } else if (alive) {
        setCash({ ...cash, status: 'slow' }); // frees the button; the transfer still lands
      }
    };
    timer = setTimeout(poll, 800);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [cash, refreshBoard]);

  // Outcome stinger — plays once, exactly when the verdict becomes visible.
  const soundedRound = useRef<string | null>(null);
  useEffect(() => {
    if (!result || hold) return;
    if (soundedRound.current === result.roundId) return;
    soundedRound.current = result.roundId;
    if (result.jackpot?.hit) {
      sfx.jackpot();
    } else if (result.outcome === 'win') {
      sfx.win();
      if (result.streakBonus > 0 || result.dailyBonus > 0) setTimeout(() => sfx.bonus(), 500);
    } else if (result.outcome === 'tie') {
      sfx.push();
    } else {
      sfx.lose();
    }
  }, [result, hold]);

  const startCashOut = async () => {
    if (!wallet.identity || (you?.chips ?? 0) < 1 || cash?.status === 'pending') return;
    try {
      const r = await cashOut(addressOf(wallet.identity)!, nameOf(wallet.identity));
      setCash({ id: r.settlementId, amount: r.amountUct, status: 'pending' });
      setYou((prev) => (prev ? { ...prev, chips: 0 } : prev));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Withdraw failed.');
    }
  };

  /**
   * Real deposit: the wallet opens its own approval UI for the transfer
   * (send intent); once approved, the house sees the incoming transfer and
   * credits the balance — we poll until it lands.
   */
  const startDeposit = async () => {
    if (!wallet.identity || !depInfo) return;
    if (dep?.status === 'approving' || dep?.status === 'crediting') return;
    const amount = Math.max(1, Math.floor(depAmt));
    const baseline = you?.chips ?? 0;
    setDep({ status: 'approving', amount });
    try {
      const amountBase = (BigInt(amount) * 10n ** BigInt(depInfo.decimals)).toString();
      await wallet.deposit({ to: depInfo.to, amountBase, coinId: depInfo.coinId });
      setDep({ status: 'crediting', amount, credited: 0 });
      const addr = addressOf(wallet.identity)!;
      // A single send arrives as several tokens that trickle in — keep polling
      // until the FULL amount is credited (or a generous window passes).
      let credited = 0;
      for (let i = 0; i < 90; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const b = await fetchBalance(addr);
          const got = b.balanceUct - baseline;
          if (got > credited) {
            credited = got;
            setYou((prev) => (prev ? { ...prev, chips: b.balanceUct } : prev));
            setDep({ status: 'crediting', amount, credited });
            sfx.bet();
          }
          if (got >= amount) {
            setDep({ status: 'done', amount, credited: got });
            sfx.cashout();
            refreshBoard();
            return;
          }
        } catch {
          /* transient — keep polling */
        }
      }
      // Window over: report honestly. Partial credits keep landing on their
      // own — the background balance sync picks them up.
      setDep({
        status: credited > 0 ? 'done' : 'failed',
        amount,
        credited,
        error:
          credited > 0
            ? `+${credited}/${amount} UCT credited — the rest is on its way and lands automatically`
            : 'transfer approved — crediting is taking longer than usual, it will land shortly',
      });
    } catch (e) {
      setDep({ status: 'failed', amount, error: e instanceof Error ? e.message : 'wallet rejected the transfer' });
    }
  };

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
        if (r.jackpotUct != null) setPot(r.jackpotUct);
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
    sfx.click();
    setSelected(id);
    setRound(null);
    setResult(null);
    setVerified(null);
    setError(null);
    clearTimeout(settleTimer.current);
    clearTimeout(suspenseTimer.current);
    setSettling(false);
    setSuspense(false);
  };

  const play = async (choice: unknown) => {
    if (!round || status !== 'idle' || hold || !wallet.identity) return;
    setStatus('playing');
    setError(null);
    sfx.click();
    try {
      const res = await playRound({
        game: selected,
        roundId: round.roundId,
        choice,
        bet,
        address: addressOf(wallet.identity),
        name: nameOf(wallet.identity),
        ref: pendingRef(),
      });
      setResult(res);
      saveProof(res); // archive the reveal for the fairness page's verifier
      if (res.achievements?.length) {
        setAchQueue((q) => [...q, ...res.achievements!]);
        sfx.win(); // a little extra flourish on an unlock
      }
      if (res.referral) {
        clearRef(); // applied once — don't send it again
        setAchQueue((q) => [
          ...q,
          {
            id: 'ref-welcome',
            title: 'Welcome bonus!',
            detail: `+${res.referral!.welcomeBonus} UCT for joining via a friend`,
            icon: 'spark',
            reward: res.referral!.welcomeBonus,
            unlocked: true,
          },
        ]);
        sfx.win();
      }
      if (res.outcome === 'win') refreshTournament(); // the standings just moved
      if (res.daily) {
        setYou({ streak: res.streak, best: res.best, daily: res.daily, chips: res.chips, chipsGranted: 0 });
      }
      setVerified(null);
      // Pace the reveal: suspense (pending anim keeps running), then an
      // optional landing phase — the outcome is already fixed either way.
      const suspenseMs = GAME_UI[res.game]?.suspenseMs ?? 0;
      const settleMs = GAME_UI[res.game]?.settleMs ?? 0;
      clearTimeout(suspenseTimer.current);
      clearTimeout(settleTimer.current);
      const startSettle = () => {
        setRound(null);
        if (settleMs > 0) {
          setSettling(true);
          settleTimer.current = setTimeout(() => setSettling(false), settleMs);
        }
      };
      if (suspenseMs > 0) {
        setSuspense(true);
        sfx.suspense(res.game);
        suspenseTimer.current = setTimeout(() => {
          setSuspense(false);
          startSettle();
        }, suspenseMs);
      } else {
        startSettle();
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
        if (ok && res.game === 'plinko') {
          ok = await verifyPlinko(res.secret, String(res.reveal.clientSeed), {
            path: res.reveal.path as number[],
            bucketIndex: Number(res.reveal.bucketIndex),
          });
        }
        if (ok && res.jackpot) {
          ok = await verifyJackpot(res.secret, res.jackpot.input, {
            roll: res.jackpot.roll,
            threshold: res.jackpot.threshold,
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
    sfx.click();
    setRound(null); // the round is spent — force a fresh deal
    setResult(null);
    setVerified(null);
  };

  if (!hasBackend()) {
    return (
      <section className="arcade">
        <div className="empty">The game hall is offline in this build.</div>
      </section>
    );
  }

  if (!connected) {
    return (
      <section className="arcade">
        <div className="lockedfloor">
          {/* the real floor, blurred behind the glass */}
          <div className="floorback" aria-hidden="true">
            <div className="floorback__jpot">
              <JackpotSign pot={pot} />
            </div>
            <div className="floorback__wheel">
              <WheelFace size={290} />
            </div>
            <div className="floorback__stack">
              <div className="ghostrow ghostrow--hot" />
              <div className="ghostrow" />
              <div className="ghostrow" />
              <div className="ghostrow" />
            </div>
            <div className="floorback__tiles">
              <div className="ghosttile" />
              <div className="ghosttile" />
              <div className="ghosttile" />
              <div className="ghosttile" />
            </div>
          </div>
          <div className="floorscrim" aria-hidden="true" />

          <HouseTicker feed={houseStats?.feed ?? []} games={games} />

          <div className="lockbox">
            <div className="lockbox__tile">
              <LockMark size={38} />
            </div>
            <div className="lockbox__kicker">members only · testnet2</div>
            <h2 className="lockbox__title">
              Step up to
              <br />
              <em>the floor</em>
            </h2>
            <p className="lockbox__lede">
              Your wallet is your seat. Connect for a <b>5 UCT welcome stake</b>, buy in from your
              own wallet, and withdraw winnings on-chain any time.
            </p>
            <button
              className="lockbox__cta"
              onClick={() => void wallet.connect()}
              disabled={wallet.status === 'connecting'}
            >
              {wallet.status === 'connecting' ? 'CONNECTING…' : 'CONNECT WALLET →'}
            </button>
            <div className="lockbox__foot">no signup · no human in the loop · the agent pays you</div>
          </div>
        </div>
      </section>
    );
  }

  const outcome = result?.outcome;

  return (
    <section className="arcade">
      <Hero house={house} />

      <EventsBar
        you={you}
        dailyDef={dailyDef}
        cash={cash}
        dep={dep}
        onCashOut={() => void startCashOut()}
        onDeposit={() => setDepOpen((v) => !v)}
      />

      {depOpen && (
        <div className="depbar">
          <span className="betbar__label">buy in</span>
          {[10, 25, 50].map((a) => (
            <button
              key={a}
              className={`betbtn${depAmt === a ? ' betbtn--on' : ''}`}
              onClick={() => {
                sfx.bet();
                setDepAmt(a);
              }}
            >
              {a}
            </button>
          ))}
          <input
            className="betinput"
            type="number"
            min={1}
            step={1}
            value={depAmt}
            onChange={(e) => setDepAmt(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
            aria-label="deposit amount in UCT"
          />
          <button
            className="depbar__go"
            onClick={() => void startDeposit()}
            disabled={!depInfo || dep?.status === 'approving' || dep?.status === 'crediting'}
          >
            {dep?.status === 'approving'
              ? 'approve in your wallet…'
              : dep?.status === 'crediting'
                ? `crediting ${dep.credited ?? 0}/${dep.amount}…`
                : `deposit ${depAmt} UCT`}
          </button>
          <span className="depbar__note">
            {dep?.status === 'failed'
              ? dep.error
              : dep?.status === 'done'
                ? (dep.error ?? `+${dep.credited ?? dep.amount} UCT credited ✓`)
                : dep?.status === 'crediting'
                  ? 'the transfer arrives as a few tokens — crediting each as it lands'
                  : 'your wallet opens and asks you to approve the transfer'}
          </span>
        </div>
      )}

      {pot != null && <JackpotSign pot={pot} />}

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
                <div className="gcard__reward">{GAME_UI[g.id]!.reward?.() ?? `pays ×${g.rewardMult}`}</div>
              </button>
            );
          })}
      </div>

      <div className="table">
        {(outcome === 'win' || result?.jackpot?.hit) && !hold && (
          <WinBurst key={result!.nonce} big={result?.jackpot?.hit} />
        )}
        <div className="table__head">
          <span className="table__title">{meta.title}</span>
          <span className="table__blurb">{meta.blurb}</span>
        </div>

        <ui.Stage
          round={round}
          result={suspense ? null : result}
          pending={status === 'playing' || hold}
        />

        {ready !== true ? (
          <div className="commit commit--wait">
            <span className="dot" /> the dealer is waking up — usually under a minute
          </div>
        ) : !result || hold ? (
          <>
            {status === 'playing' || hold ? (
              <div className="commit commit--wait">
                <span className="dot" /> {settling ? 'watch it land…' : 'revealing…'}
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

            {status !== 'playing' && !hold && (
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
                    disabled={(you?.chips ?? 0) < b}
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
                <button
                  className="betbtn betbtn--max"
                  onClick={() => {
                    sfx.bet();
                    setBet(Math.max(1, you?.chips ?? 1));
                  }}
                  disabled={(you?.chips ?? 0) < 1}
                >
                  max
                </button>
                <span className="betbar__unit">UCT</span>
                {(you?.chips ?? 0) === 0 ? (
                  <span className="betbar__empty">no balance — deposit from your wallet to play</span>
                ) : (you?.chips ?? 0) < bet ? (
                  <span className="betbar__empty">bet is over your {you?.chips} UCT balance</span>
                ) : null}
              </div>
            )}

            {meta.inputKind === 'seed' ? (
              <div className="gbtns">
                <button
                  className="again"
                  onClick={() => void play(makeClientSeed())}
                  disabled={!round || status === 'playing' || hold || (you?.chips ?? 0) < bet}
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
                    disabled={!round || status === 'playing' || hold || (you?.chips ?? 0) < bet}
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
            {result.jackpot?.hit && (
              <div className="jackpotwin">
                <div className="jackpotwin__title">JACKPOT</div>
                <div className="jackpotwin__amount">+{result.jackpot.potUct} UCT</div>
                <div className="jackpotwin__pay">
                  {stl?.jackpot?.status === 'landed'
                    ? 'the whole pot — sent to your wallet by the house agent ✓'
                    : stl?.jackpot?.status === 'failed'
                      ? 'pot payout hit a testnet hiccup'
                      : 'the house agent is sending you the pot…'}
                </div>
              </div>
            )}
            <div className={`gverdict verdict--${outcome}`}>
              {outcome === 'win'
                ? `YOU WON +${result.rewardUct} UCT`
                : outcome === 'lose'
                  ? `YOU LOST ${result.bet} UCT`
                  : 'PUSH'}
            </div>
            <div className="outcome__pay">
              {outcome === 'win' ? (
                <span className="pay pay--ok">✓ added to your balance — {result.chips} UCT</span>
              ) : outcome === 'tie' ? (
                <span className="pay">a push — your bet came back</span>
              ) : (
                <span className="pay">your bet went to the house</span>
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
            {result.jackpot?.hit && stl?.jackpot?.status === 'landed' && stl.jackpot.txId && (
              <TxProof id={stl.jackpot.txId} delivery={stl.jackpot.delivery} />
            )}
            <div className="outcome__verify">
              {verified === null ? (
                <span className="verify verify--wait">verifying fairness…</span>
              ) : verified ? (
                <span className="verify verify--ok">
                  🔐 provably fair — the reveal matches the sealed commitment{' '}
                  <a className="verify__link" href="#/fairness" title="re-run the math yourself, step by step">
                    see the math →
                  </a>
                </span>
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

      <TournamentPanel view={tourney} />

      <div className="arcade__duo">
        <LeaderboardPanel rows={board} />

        <HousePanel stats={houseStats} house={house} games={games} />
      </div>

      <AchievementToast queue={achQueue} onShown={(id) => setAchQueue((q) => q.filter((a) => a.id !== id))} />
    </section>
  );
}

/** The bulb-marquee jackpot sign — chasing incandescent border, glowing amount. */
function JackpotSign({ pot }: { pot: number | null }) {
  return (
    <div
      className="jpot"
      title="Grows every round; a provably-fair roll can hit it in any game — the house agent pays the whole pot on-chain."
    >
      <span className="jpot__bulbs jpot__bulbs--top" aria-hidden="true" />
      <span className="jpot__bulbs jpot__bulbs--bottom" aria-hidden="true" />
      <span className="jpot__label">jackpot</span>
      <span className="jpot__amount">
        {pot ?? '…'}
        <em> UCT</em>
      </span>
      <span className="jpot__hint">
        every bet rolls for it
        <br />
        hit it, the agent pays the pot
      </span>
    </div>
  );
}

const LEADER_PER_PAGE = 8;

/** Leaderboard with client-side paging (prev/next) once it grows past one page. */
function LeaderboardPanel({ rows }: { rows: LeaderRow[] }) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(rows.length / LEADER_PER_PAGE));
  const p = Math.min(page, pageCount - 1);
  const visible = rows.slice(p * LEADER_PER_PAGE, p * LEADER_PER_PAGE + LEADER_PER_PAGE);
  return (
    <div className="board">
      <div className="board__head">
        <span className="board__title">Leaderboard</span>
        <span className="board__note">top players · all games</span>
      </div>
      {rows.length === 0 ? (
        <div className="empty">No games yet — be the first to beat the house.</div>
      ) : (
        <>
          <div className="board__rows">
            {visible.map((r, i) => (
              <div className="brow" key={r.name}>
                <span className="brow__rank">{p * LEADER_PER_PAGE + i + 1}</span>
                <span className="brow__name">@{r.name}</span>
                <span className="brow__wl">
                  {r.wins}W · {r.losses}L · {r.ties}T
                </span>
                <span className="brow__earned">{r.earnedUct} UCT</span>
              </div>
            ))}
          </div>
          {rows.length > LEADER_PER_PAGE && (
            <div className="board__pager">
              <button
                type="button"
                className="board__pg"
                onClick={() => setPage((x) => Math.max(0, x - 1))}
                disabled={p === 0}
                aria-label="Previous page"
              >
                ‹
              </button>
              <span className="board__pgnum">
                {p + 1} / {pageCount}
              </span>
              <button
                type="button"
                className="board__pg"
                onClick={() => setPage((x) => Math.min(pageCount - 1, x + 1))}
                disabled={p >= pageCount - 1}
                aria-label="Next page"
              >
                ›
              </button>
            </div>
          )}
        </>
      )}
    </div>
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
  // This strip is specifically "live payouts" — mints and incoming deposits
  // aren't payouts, so keep them out of it.
  const wins = feed.filter((e) => e.kind !== 'mint' && e.kind !== 'deposit').slice(0, 8);
  if (wins.length === 0) return null;
  const items = (dup: boolean) =>
    wins.map((w, i) => (
      <span
        className={`ticker__item${w.kind === 'jackpot' ? ' ticker__item--jackpot' : ''}`}
        key={`${dup ? 'd' : 'a'}${i}`}
        aria-hidden={dup}
      >
        <strong>@{w.name}</strong>{' '}
        {w.kind === 'jackpot'
          ? `HIT THE ${w.amountUct} UCT JACKPOT on ${gameTitle(games, w.game)}`
          : w.kind === 'tournament'
            ? `WON THE ${w.amountUct} UCT TOURNAMENT`
            : w.kind === 'cashout'
              ? `cashed out ${w.amountUct} UCT on-chain`
              : `won ${w.amountUct} UCT on ${gameTitle(games, w.game)}`}
        <em> · {timeAgo(w.at)}</em>
      </span>
    ));
  return (
    <div className="ticker" aria-label="recent payouts, sent on-chain by the house agent">
      <span className="ticker__tag">live payouts</span>
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
        <Stat value={`${stats.paidOutUct} UCT`} label="paid to players" />
        <Stat value={String(stats.roundsPlayed)} label="rounds dealt" />
        <Stat value={stats.jackpotUct != null ? `${stats.jackpotUct} UCT` : '…'} label="jackpot pot" />
      </div>
      {stats.feed.length > 0 && (
        <div className="housep__feed">
          {stats.feed.filter((e) => e.kind !== 'mint').slice(0, 6).map((e, i) => (
            <div
              className={`hevent${e.kind === 'mint' ? ' hevent--mint' : ''}${e.kind === 'jackpot' ? ' hevent--jackpot' : ''}`}
              key={`${e.at}-${i}`}
            >
              <span>
                {e.kind === 'mint'
                  ? `treasury low — the agent minted itself +${e.amountUct} UCT`
                  : e.kind === 'deposit'
                    ? `@${e.name} bought in — ${e.amountUct} UCT deposited on-chain`
                    : e.kind === 'jackpot'
                      ? `JACKPOT — paid @${e.name} the whole ${e.amountUct} UCT pot · ${gameTitle(games, e.game)}`
                      : e.kind === 'tournament'
                        ? `TOURNAMENT — paid champion @${e.name} the ${e.amountUct} UCT prize`
                        : e.kind === 'cashout'
                          ? `cashed @${e.name} out — ${e.amountUct} UCT sent on-chain`
                          : `paid @${e.name} +${e.amountUct} UCT · ${gameTitle(games, e.game)}`}
              </span>
              <span className="hevent__t">{timeAgo(e.at)}</span>
            </div>
          ))}
        </div>
      )}
      <div className="housep__note">
        payouts settled on testnet2 by the agent itself · recent activity
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
      <h2 className="arcade__title">The Game Hall</h2>
      <p className="arcade__lede">
        A hall of provably-fair games vs an autonomous house. Bet real testnet UCT, win
        multipliers, and withdraw on-chain — settled by the agent itself, no human in the loop.
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
  cash,
  dep,
  onCashOut,
  onDeposit,
}: {
  you: PlayerSnapshot | null;
  dailyDef: { goal: number; reward: number } | null;
  cash: { id: string; amount: number; status: 'pending' | 'landed' | 'failed' | 'slow'; txId?: string } | null;
  dep: { status: 'approving' | 'crediting' | 'done' | 'failed'; amount: number; error?: string } | null;
  onCashOut: () => void;
  onDeposit: () => void;
}) {
  const chips = you?.chips ?? null;
  const streak = you?.streak ?? 0;
  const goal = you?.daily?.goal ?? dailyDef?.goal ?? 5;
  const wins = you?.daily?.wins ?? 0;
  const claimed = you?.daily?.claimed ?? false;
  const reward = dailyDef?.reward ?? 10;
  const pct = claimed ? 100 : Math.min(100, Math.round((wins / goal) * 100));
  return (
    <div className="events">
      <div className="events__chips">
        <div className="events__chips-top">
          <span className="events__chips-n">{chips ?? '…'}</span>
          <span className="events__chips-l">UCT</span>
        </div>
        <div className="events__bank">
          <button
            className="cashout cashout--deposit"
            onClick={onDeposit}
            title="Buy in with real UCT from your Sphere wallet — you approve the transfer in the wallet itself."
          >
            {dep?.status === 'approving' || dep?.status === 'crediting' ? 'depositing…' : 'deposit'}
          </button>
          <button
            className="cashout"
            onClick={onCashOut}
            disabled={(chips ?? 0) < 1 || cash?.status === 'pending'}
            title="Withdraw your balance 1:1 — the house agent sends real UCT to your wallet on-chain."
          >
            {cash?.status === 'pending' ? 'sending…' : 'withdraw'}
          </button>
        </div>
        {cash?.status === 'landed' && (
          <div className="events__cash events__cash--ok" title={cash.txId}>
            ✓ {cash.amount} UCT sent on-chain
          </div>
        )}
        {cash?.status === 'slow' && (
          <div className="events__cash">on its way — it lands in your wallet shortly</div>
        )}
        {cash?.status === 'failed' && (
          <div className="events__cash events__cash--bad">testnet hiccup — balance restored</div>
        )}
        {dep?.status === 'done' && <div className="events__cash events__cash--ok">✓ +{dep.amount} UCT deposited</div>}
      </div>
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

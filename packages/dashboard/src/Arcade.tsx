import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useWalletCtx } from './WalletContext';
import {
  fetchLeaderboard,
  hasBackend,
  newRound,
  playRound,
  verifyCommit,
  type LeaderRow,
  type Move,
  type NewRound,
  type PlayResult,
} from './lib/arcade';

const HAND: Record<Move, string> = { rock: '✊', paper: '✋', scissors: '✌️' };
const MOVES: Move[] = ['rock', 'paper', 'scissors'];

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

/** Clean geometric "house agent" mark — a professional stand-in for an emoji. */
function BotMark({ size = 72, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      className={className}
      role="img"
      aria-label="house agent"
    >
      <defs>
        <linearGradient id="botmark" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FF9A4D" />
          <stop offset="1" stopColor="#FF6F00" />
        </linearGradient>
      </defs>
      <line x1="32" y1="7" x2="32" y2="17" stroke="url(#botmark)" strokeWidth="3" strokeLinecap="round" />
      <circle cx="32" cy="6" r="3" fill="url(#botmark)" />
      <rect x="11" y="17" width="42" height="34" rx="11" fill="url(#botmark)" />
      <rect x="18" y="27" width="28" height="15" rx="7.5" fill="#0a0a0a" opacity="0.82" />
      <circle cx="26" cy="34.5" r="3.4" fill="#FFB877" />
      <circle cx="38" cy="34.5" r="3.4" fill="#FFB877" />
      <rect x="24" y="55" width="16" height="4" rx="2" fill="url(#botmark)" opacity="0.5" />
    </svg>
  );
}

export function Arcade() {
  const wallet = useWalletCtx();
  const connected = wallet.status === 'connected' && !!wallet.identity;

  const [ready, setReady] = useState<boolean | null>(null); // null = probing, false = waking
  const [round, setRound] = useState<NewRound | null>(null);
  const [result, setResult] = useState<PlayResult | null>(null);
  const [verified, setVerified] = useState<boolean | null>(null);
  const [status, setStatus] = useState<'idle' | 'playing'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [board, setBoard] = useState<LeaderRow[]>([]);
  const [house, setHouse] = useState<string | null>(null);
  const [reward, setReward] = useState(1);
  const dealing = useRef(false);

  const applyBoard = useCallback((b: Awaited<ReturnType<typeof fetchLeaderboard>>) => {
    setBoard(b.rows);
    if (b.house) setHouse(b.house);
    if (b.rewardUct) setReward(b.rewardUct);
  }, []);

  const refreshBoard = useCallback(() => {
    void fetchLeaderboard().then(applyBoard).catch(() => {});
  }, [applyBoard]);

  // Poll readiness — the free-tier backend cold-starts and its agents take a
  // while to come up. Keep probing (which also warms it) until the dealer is up.
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
          return; // stop probing once the dealer is live
        }
      } catch {
        /* cold start / transient — keep trying */
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

  const deal = useCallback(async () => {
    if (!connected || dealing.current || !wallet.identity) return;
    dealing.current = true;
    setError(null);
    try {
      const r = await newRound(addressOf(wallet.identity));
      setRound(r);
      setHouse(r.house);
      setReward(r.rewardUct);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not start a round.';
      // A cold/booting backend isn't an error the player should see as a failure.
      if (/timed out|waking up|failed to fetch|load failed/i.test(msg)) setReady(false);
      else setError(msg);
    } finally {
      dealing.current = false;
    }
  }, [connected, wallet.identity]);

  // Auto-deal once the dealer is live and nothing is in play.
  useEffect(() => {
    if (connected && ready && !round && !result) void deal();
  }, [connected, ready, round, result, deal]);

  const pick = async (move: Move) => {
    if (!round || status !== 'idle' || !wallet.identity) return;
    setStatus('playing');
    setError(null);
    try {
      const res = await playRound({
        roundId: round.roundId,
        move,
        address: addressOf(wallet.identity),
        name: nameOf(wallet.identity),
      });
      setRound(null);
      setResult(res);
      setVerified(null);
      verifyCommit(res.dealerMove, res.nonce, res.commit)
        .then(setVerified)
        .catch(() => setVerified(false));
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
        <ArcadeHero house={house} reward={reward} />
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
  const houseFace: ReactNode = result ? (
    HAND[result.dealerMove]
  ) : status === 'playing' ? (
    <span className="hand__ph">…</span>
  ) : (
    <BotMark />
  );

  return (
    <section className="arcade">
      <ArcadeHero house={house} reward={reward} />

      <div className="arena">
        <Hand
          label="you"
          face={result ? HAND[result.playerMove] : <span className="hand__ph">?</span>}
          state={result ? (outcome === 'win' ? 'win' : outcome === 'lose' ? 'lose' : 'tie') : 'idle'}
        />
        <div className="arena__vs">
          {result ? (
            <div className={`verdict verdict--${outcome}`}>
              {outcome === 'win' ? 'YOU WON' : outcome === 'lose' ? 'YOU LOST' : 'TIE'}
            </div>
          ) : (
            <div className="arena__vs-txt">vs</div>
          )}
        </div>
        <Hand
          label="house"
          face={houseFace}
          state={result ? (outcome === 'lose' ? 'win' : outcome === 'win' ? 'lose' : 'tie') : 'idle'}
        />
      </div>

      {ready !== true ? (
        <div className="commit commit--wait">
          <span className="dot" /> waking the dealer… free-tier cold start, up to ~1 min
        </div>
      ) : !result ? (
        <>
          <div className="commit" title={round?.commit}>
            {round ? (
              <>
                🔒 dealer committed <code>{round.commit.slice(0, 20)}…</code> — pick your move
              </>
            ) : (
              'dealing a fresh round…'
            )}
          </div>
          <div className="moves">
            {MOVES.map((m) => (
              <button
                key={m}
                className="move"
                onClick={() => void pick(m)}
                disabled={!round || status === 'playing'}
                aria-label={m}
              >
                <span className="move__hand">{HAND[m]}</span>
                <span className="move__name">{m}</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="outcome">
          <div className="outcome__pay">
            {outcome === 'win' ? (
              result.paid ? (
                <span className="pay pay--ok">✓ {result.rewardUct} UCT sent to your wallet</span>
              ) : (
                <span className="pay pay--pend">payout pending — {result.payoutError ?? 'retrying on testnet'}</span>
              )
            ) : outcome === 'tie' ? (
              <span className="pay">a tie — no payout, go again</span>
            ) : (
              <span className="pay">the house took this one</span>
            )}
          </div>
          <div className="outcome__verify">
            {verified === null ? (
              <span className="verify verify--wait">verifying commitment…</span>
            ) : verified ? (
              <span className="verify verify--ok">
                🔐 provably fair — reveal matches the commit ({HAND[result.dealerMove]} {result.dealerMove})
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

      <div className="board">
        <div className="board__head">
          <span className="board__title">Leaderboard</span>
          <span className="board__note">top players · resets on redeploy</span>
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

function ArcadeHero({ house, reward }: { house: string | null; reward: number }) {
  return (
    <div className="arcade__hero">
      <h2 className="arcade__title">Agent Arcade</h2>
      <p className="arcade__lede">
        Rock–paper–scissors vs an autonomous house. Win and it sends you{' '}
        <span className="ink-accent">{reward} UCT</span> on-chain, automatically.
      </p>
      <div className="arcade__meta">
        <span className="arcade__chip arcade__chip--house">
          <BotMark size={15} /> house {house ? `@${house}` : '…'}
        </span>
        <span className="arcade__chip">{reward} UCT / win</span>
        <span className="arcade__chip" title="The dealer commits sha256(move:nonce) before you pick.">
          provably fair
        </span>
      </div>
    </div>
  );
}

function Hand({ label, face, state }: { label: string; face: ReactNode; state: 'idle' | 'win' | 'lose' | 'tie' }) {
  return (
    <div className={`hand hand--${state}`}>
      <div className="hand__face">{face}</div>
      <div className="hand__label">{label}</div>
    </div>
  );
}

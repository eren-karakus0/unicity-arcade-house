import { useEffect, useMemo, useState } from 'react';
import {
  loadProofs,
  parseProof,
  sha256Hex,
  verifyProof,
  type StoredProof,
  type VerifyReport,
} from './lib/fairness';
import { NavLink } from './lib/nav';
import {
  CLIENT_SEED_RE,
  fetchLeaderboard,
  getClientSeed,
  hasBackend,
  makeClientSeed,
  setClientSeed,
  type HouseStats,
} from './lib/arcade';

const GAME_TITLES: Record<string, string> = {
  rps: 'Rock · Paper · Scissors',
  dice: 'Dice Duel',
  coin: 'Coin Flip',
  highlow: 'High · Low',
  number: 'Lucky Number',
  wheel: 'Lucky Wheel',
  plinko: 'Plinko',
  limbo: 'Limbo',
  crash: 'Crash',
  mines: 'Mines',
};

/**
 * The fairness page — commit-reveal explained, then proven: a live verifier
 * that re-runs the house's math on real rounds played in this browser.
 */
export function Fairness() {
  return (
    <section className="fair">
      <NavLink className="fair__back" href="/">
        ← back to the floor
      </NavLink>
      <header className="fair__hero">
        <h1 className="fair__title">
          Don’t trust the house. <em>Check it.</em>
        </h1>
        <p className="fair__sub">
          Every round is sealed with a hash <strong>before you act</strong> — and every reveal can
          be re-computed right here, in your browser, with nothing but SHA-256. No API calls, no
          taking our word for it.
        </p>
      </header>

      <HowItWorks />
      <SeedControl />
      <Verifier />
      <HashLab />
      <OddsTable />
      <Solvency />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Your client seed — the player's half of every two-seed round
// ---------------------------------------------------------------------------

function SeedControl() {
  const [seed, setSeed] = useState(() => getClientSeed());
  const [draft, setDraft] = useState(seed);
  const [saved, setSaved] = useState<null | 'ok' | 'bad'>(null);
  const valid = CLIENT_SEED_RE.test(draft.trim());

  const save = () => {
    const ok = setClientSeed(draft);
    if (ok) setSeed(draft.trim());
    setSaved(ok ? 'ok' : 'bad');
  };
  const rotate = () => {
    const fresh = makeClientSeed();
    setClientSeed(fresh);
    setSeed(fresh);
    setDraft(fresh);
    setSaved('ok');
  };

  return (
    <div className="fair__seed">
      <h2 className="fair__h2">Your client seed</h2>
      <p className="fair__note">
        In the two-seed games (dice, wheel, plinko, limbo, crash) the outcome derives from the
        house&rsquo;s sealed seed <strong>plus this value — yours</strong>. Set it to anything you
        like <em>before</em> the house commits, and you can prove your entropy was in the mix. It
        sticks in this browser until you change it.
      </p>
      <div className="fair__seedrow">
        <input
          className="fair__labinput"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setSaved(null);
          }}
          maxLength={64}
          spellCheck={false}
          aria-label="your client seed (4-64 letters or digits)"
        />
        <button className="fairbtn" onClick={save} disabled={!valid || draft.trim() === seed}>
          save
        </button>
        <button className="fairbtn fairbtn--ghost" onClick={rotate} title="generate a fresh random seed">
          rotate
        </button>
      </div>
      <div className="fair__seedstate">
        {saved === 'bad' || !valid ? (
          <span className="fair__pasteerr">4–64 letters or digits only.</span>
        ) : (
          <span>
            active seed <code>{seed}</code>
            {saved === 'ok' ? ' — saved ✓' : ''}
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Provably solvent — the house's live treasury, in the open
// ---------------------------------------------------------------------------

function Solvency() {
  const [stats, setStats] = useState<HouseStats | null>(null);
  const [house, setHouse] = useState<string | null>(null);

  useEffect(() => {
    if (!hasBackend()) return;
    let live = true;
    const load = () =>
      void fetchLeaderboard()
        .then((b) => {
          if (!live) return;
          if (b.houseStats) setStats(b.houseStats);
          if (b.house) setHouse(b.house);
        })
        .catch(() => {});
    load();
    const t = setInterval(load, 30_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  if (!stats) return null;
  return (
    <div className="fair__solvency">
      <h2 className="fair__h2">Provably solvent</h2>
      <p className="fair__note">
        Fair maths is half the story — the other half is whether the house <em>can pay</em>. These
        are the autonomous house agent{house ? ` (@${house})` : ''}&rsquo;s live numbers, straight
        from its wallet: what it holds, what it has paid out on-chain, and what it minted to keep
        the floor liquid (testnet UCT — the house tops itself up, so a win is never unpayable).
      </p>
      <div className="fair__solvgrid">
        <div className="fairsolv">
          <span className="fairsolv__k">treasury</span>
          <span className="fairsolv__v">
            {stats.treasuryUct == null ? '…' : Math.round(stats.treasuryUct).toLocaleString()} <em>UCT</em>
          </span>
        </div>
        <div className="fairsolv">
          <span className="fairsolv__k">paid out on-chain</span>
          <span className="fairsolv__v">
            {Math.round(stats.paidOutUct).toLocaleString()} <em>UCT</em>
          </span>
        </div>
        <div className="fairsolv">
          <span className="fairsolv__k">rounds dealt</span>
          <span className="fairsolv__v">{stats.roundsPlayed.toLocaleString()}</span>
        </div>
        <div className="fairsolv">
          <span className="fairsolv__k">live jackpot</span>
          <span className="fairsolv__v">
            {stats.jackpotUct == null ? '…' : stats.jackpotUct.toLocaleString()} <em>UCT</em>
          </span>
        </div>
      </div>
    </div>
  );
}

function HowItWorks() {
  return (
    <div className="fair__steps">
      <div className="fairstep">
        <span className="fairstep__no">1</span>
        <h3>the house seals</h3>
        <p>
          It picks its hidden value (a move, a card, a seed) and shows you only{' '}
          <code>sha256(secret&thinsp;:&thinsp;nonce)</code> — the <strong>commitment</strong>. The
          secret is now locked: changing it would change the hash.
        </p>
      </div>
      <div className="fairstep">
        <span className="fairstep__no">2</span>
        <h3>you act</h3>
        <p>
          You make your call. In the seed games (dice, wheel, plinko) your browser also throws in
          its own random <strong>client seed</strong> — so the outcome depends on{' '}
          <em>both</em> sides and neither can steer it.
        </p>
      </div>
      <div className="fairstep">
        <span className="fairstep__no">3</span>
        <h3>reveal &amp; verify</h3>
        <p>
          The house opens the secret. Your browser re-hashes it against the commitment and
          re-derives the outcome. If a single bit were different, the check would fail — loudly.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The live verifier
// ---------------------------------------------------------------------------

function Verifier() {
  const [proofs, setProofs] = useState<StoredProof[]>(() => loadProofs());
  const [selected, setSelected] = useState<StoredProof | null>(null);
  const [report, setReport] = useState<VerifyReport | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasted, setPasted] = useState('');
  const [pasteErr, setPasteErr] = useState<string | null>(null);

  // Re-read on focus — the player may have played rounds in another tab.
  useEffect(() => {
    const refresh = () => setProofs(loadProofs());
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);

  const run = async (p: StoredProof) => {
    setSelected(p);
    setReport(null);
    setReport(await verifyProof(p));
  };

  const runPasted = async () => {
    setPasteErr(null);
    try {
      await run(parseProof(pasted));
    } catch (e) {
      setPasteErr(e instanceof Error ? e.message : 'Could not read that JSON.');
    }
  };

  return (
    <div className="fair__verifier">
      <h2 className="fair__h2">The verifier</h2>
      <p className="fair__note">
        Rounds you play on the floor are archived <strong>in this browser only</strong> (last 12).
        Pick one and watch the math re-run — or paste any round’s proof JSON.
      </p>

      {proofs.length === 0 ? (
        <div className="fair__empty">
          No rounds archived here yet — <NavLink href="/">play one on the floor</NavLink> and come
          back, or paste a proof below.
        </div>
      ) : (
        <ul className="fair__rounds">
          {proofs.map((p) => (
            <li
              key={`${p.roundId}-${p.at}`}
              className={`fairround${selected?.roundId === p.roundId && selected?.at === p.at ? ' fairround--active' : ''}`}
            >
              <span className="fairround__game">{GAME_TITLES[p.game] ?? p.game}</span>
              <span className={`fairround__outcome fairround__outcome--${p.outcome}`}>
                {p.outcome}
              </span>
              <span className="fairround__meta">
                bet {p.bet} UCT · {timeAgo(p.at)}
              </span>
              <span className="fairround__actions">
                <button className="fairbtn" onClick={() => void run(p)}>
                  verify
                </button>
                <button
                  className="fairbtn fairbtn--ghost"
                  title="copy this round's proof JSON — anyone can verify it here"
                  onClick={() => void navigator.clipboard?.writeText(JSON.stringify(p, null, 2))}
                >
                  copy proof
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <button className="fair__pastetoggle" onClick={() => setPasteOpen((v) => !v)}>
        {pasteOpen ? '× close' : 'paste a proof instead'}
      </button>
      {pasteOpen && (
        <div className="fair__paste">
          <textarea
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            placeholder='{"game":"dice","commit":"…","secret":"…","nonce":"…","reveal":{…}}'
            rows={5}
            spellCheck={false}
          />
          <button className="fairbtn" onClick={() => void runPasted()} disabled={!pasted.trim()}>
            verify pasted round
          </button>
          {pasteErr && <div className="fair__pasteerr">{pasteErr}</div>}
        </div>
      )}

      {selected && report && <Report key={`${selected.roundId}-${selected.at}`} report={report} />}
    </div>
  );
}

function Report({ report }: { report: VerifyReport }) {
  const verdictDelay = report.steps.length * 0.45;
  return (
    <div className="fairreport">
      {report.steps.map((s, i) => (
        <div
          key={s.title}
          className={`fairstep2 ${s.ok ? 'fairstep2--ok' : 'fairstep2--bad'}`}
          style={{ animationDelay: `${i * 0.45}s` }}
        >
          <span className="fairstep2__mark">{s.ok ? '✓' : '✗'}</span>
          <div className="fairstep2__body">
            <div className="fairstep2__title">{s.title}</div>
            <code className="fairstep2__formula">{s.formula}</code>
            <div className="fairstep2__cmp">
              <span title="what this browser just computed">
                computed <code>{s.computed}</code>
              </span>
              <span className="fairstep2__vs">vs</span>
              <span title="what the house claimed">
                claimed <code>{s.expected}</code>
              </span>
            </div>
            {s.detail && <div className="fairstep2__detail">{s.detail}</div>}
          </div>
        </div>
      ))}
      <div
        className={`fairverdict ${report.ok ? 'fairverdict--ok' : 'fairverdict--bad'}`}
        style={{ animationDelay: `${verdictDelay}s` }}
      >
        {report.ok
          ? '🔐 verified fair — every claim re-derived in your browser'
          : '⚠ MISMATCH — this round does not check out. If it came from our floor, call it out.'}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hash lab — feel the avalanche
// ---------------------------------------------------------------------------

function HashLab() {
  const [input, setInput] = useState('unicity arcade house');
  const [hash, setHash] = useState('');

  useEffect(() => {
    let live = true;
    void sha256Hex(input).then((h) => {
      if (live) setHash(h);
    });
    return () => {
      live = false;
    };
  }, [input]);

  return (
    <div className="fair__lab">
      <h2 className="fair__h2">Why the house can’t cheat</h2>
      <p className="fair__note">
        Type anything — change one letter and the whole hash changes. That’s why publishing{' '}
        <code>sha256(secret:nonce)</code> up front locks the secret: the house can’t find a
        different secret with the same hash.
      </p>
      <input
        className="fair__labinput"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        maxLength={200}
        spellCheck={false}
        aria-label="text to hash"
      />
      <div className="fair__labhash">
        <span className="fair__labarrow">sha256 →</span>
        <code>{hash}</code>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The odds, in the open
// ---------------------------------------------------------------------------

const WHEEL_SEGMENTS = [0, 1, 0, 1, 0, 2, 0, 1, 0, 1, 0, 5];
const PLINKO_MULTIPLIERS = [10, 4, 2, 1, 1, 1, 0, 1, 1, 1, 2, 4, 10];

function OddsTable() {
  const wheel = useMemo(() => WHEEL_SEGMENTS.join(' · '), []);
  const plinko = useMemo(() => PLINKO_MULTIPLIERS.join(' · '), []);
  return (
    <div className="fair__odds">
      <h2 className="fair__h2">The odds, in the open</h2>
      <p className="fair__note">
        Payouts are <strong>total-return</strong>: ×2 returns twice your bet, ×1 gives the bet
        back (push), ×0 loses it. The maths below is exactly what the verifier re-runs.
      </p>
      <div className="fair__oddswrap">
        <table className="fair__oddstable">
          <thead>
            <tr>
              <th>game</th>
              <th>outcome comes from</th>
              <th>pays</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Coin Flip · RPS · High-Low · Lucky Number</td>
              <td>
                the sealed secret <em>is</em> the outcome — committed before your call
              </td>
              <td>×2 (Lucky Number ×5)</td>
            </tr>
            <tr>
              <td>Dice Duel</td>
              <td>
                <code>h = sha256(serverSeed:clientSeed)</code> — house die{' '}
                <code>h[0..8] % 6 + 1</code>, yours <code>h[8..16] % 6 + 1</code>
              </td>
              <td>×2 · tie pushes</td>
            </tr>
            <tr>
              <td>Lucky Wheel</td>
              <td>
                <code>h[0..8] % 12</code> picks the segment: {wheel}
              </td>
              <td>×0–×5 · ×1 pushes</td>
            </tr>
            <tr>
              <td>Plinko</td>
              <td>
                12 peg bits <code>h[i] &amp; 1</code>; the bucket is the count of rights: {plinko}
              </td>
              <td>×0–×10 · ×1 pushes</td>
            </tr>
            <tr>
              <td>Limbo · Crash</td>
              <td>
                <code>r = (h[0..8]+1)/2³²</code> → result <code>max(1, 0.96/r)</code> — win iff it
                reaches your target; <code>P(≥t) = 0.96/t</code>, a flat 96% return at every target
              </td>
              <td>× your target (up to ×1000)</td>
            </tr>
            <tr>
              <td>Mines</td>
              <td>
                5 mines from a Fisher–Yates shuffle seeded by <code>sha256(secret:mines)</code> —
                sealed before you pick; brackets are fair odds × 0.96
              </td>
              <td>×1.2 (1 cell) – ×8.39 (8 cells)</td>
            </tr>
            <tr>
              <td>Progressive jackpot</td>
              <td>
                every bet rolls <code>sha256(secret:jackpot:yourInput)[0..6] % 150</code> — 0 wins
                the whole pot
              </td>
              <td>the pot, on-chain</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function timeAgo(at: number): string {
  const s = Math.max(1, Math.floor((Date.now() - at) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

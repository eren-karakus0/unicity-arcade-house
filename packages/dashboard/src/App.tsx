import { useEffect, useState } from 'react';
import { Arcade } from './Arcade';
import { ConnectWallet } from './ConnectWallet';
import { Fairness } from './Fairness';
import { Profile } from './Profile';
import { captureRef } from './lib/arcade';
import { NavLink } from './lib/nav';
import { Card, Coin, Die, HandScissors, PlinkoMark } from './arcade/art';
import { isMuted, setMuted, sfx } from './arcade/sound';

/**
 * Tiny path router — clean URLs (`/fairness`, `/profile`), no `#`. The SPA
 * rewrite in vercel.json serves index.html for deep links. Legacy `#/x` links
 * (old shares/bookmarks) are upgraded to `/x` on load.
 */
function normalizePath(): string {
  const p = window.location.pathname.replace(/\/+$/, '') || '/';
  return p;
}

function useRoute(): string {
  const [route, setRoute] = useState(normalizePath);
  useEffect(() => {
    // Upgrade a legacy hash deep-link once, keeping query params (?ref=…).
    const h = window.location.hash;
    if (h.startsWith('#/')) {
      const target = h.slice(1).replace(/\/+$/, '') || '/';
      history.replaceState({}, '', target + window.location.search);
      setRoute(target === '' ? '/' : target);
    }
    const onNav = () => {
      setRoute(normalizePath());
      window.scrollTo(0, 0);
    };
    window.addEventListener('popstate', onNav);
    return () => window.removeEventListener('popstate', onNav);
  }, []);
  return route;
}

export function App() {
  const route = useRoute();
  useEffect(() => captureRef(), []); // grab a ?ref= invite before anything else
  return (
    <div className="app">
      <WallArt />
      <Header />
      {route === '/fairness' ? <Fairness /> : route === '/profile' ? <Profile /> : <Arcade />}
      <Footer />
    </div>
  );
}

/** Ambient wall decor for wide screens — dim game pieces drifting at the page edges. */
function WallArt() {
  return (
    <div className="wallart" aria-hidden="true">
      <span className="wallart__piece wallart__piece--l1">
        <Die n={5} size={92} />
      </span>
      <span className="wallart__piece wallart__piece--l2">
        <Card rank={1} size={84} />
      </span>
      <span className="wallart__piece wallart__piece--l3">
        <HandScissors size={76} />
      </span>
      <span className="wallart__piece wallart__piece--r1">
        <Coin side="heads" size={86} />
      </span>
      <span className="wallart__piece wallart__piece--r2">
        <PlinkoMark size={90} />
      </span>
      <span className="wallart__piece wallart__piece--r3">
        <Die n={2} size={70} />
      </span>
    </div>
  );
}

function Header() {
  return (
    <header className="hdr">
      <div className="hdr__mark">
        <Die n={5} size={26} />
      </div>
      <div className="hdr__titles">
        <div className="hdr__title">
          Unicity <em>Arcade House</em>
        </div>
        <div className="hdr__sub">Provably-fair games · on-chain payouts</div>
      </div>
      <div className="hdr__right">
        <NavLink className="hdr__fair" href="/profile" title="your stats, badges, and invite link">
          profile
        </NavLink>
        <NavLink className="hdr__fair" href="/fairness" title="verify any round yourself">
          fairness
        </NavLink>
        <MuteButton />
        <span className="hdr__net">testnet2</span>
        <ConnectWallet />
      </div>
    </header>
  );
}

function MuteButton() {
  const [muted, setM] = useState(isMuted);
  const toggle = () => {
    const next = !muted;
    setMuted(next);
    setM(next);
    if (!next) sfx.click(); // audible confirmation when unmuting
  };
  return (
    <button className="mutebtn" onClick={toggle} aria-label={muted ? 'unmute sounds' : 'mute sounds'} title={muted ? 'unmute sounds' : 'mute sounds'}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <path d="M4 9 v6 h4 l5 4 V5 L8 9 Z" fill="currentColor" />
        {muted ? (
          <path d="M16 9 l5 6 M21 9 l-5 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        ) : (
          <>
            <path d="M15.5 9.5 a4 4 0 0 1 0 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <path d="M18 7.5 a7.5 7.5 0 0 1 0 9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </>
        )}
      </svg>
    </button>
  );
}

function Footer() {
  return (
    <footer className="footer">
      <span className="footer__brand">Unicity Arcade House</span>
      <span>
        <NavLink className="footer__fair" href="/fairness">
          Provably-fair games
        </NavLink>
        , on-chain payouts
      </span>
      <span>Built on the Sphere SDK · testnet2</span>
    </footer>
  );
}

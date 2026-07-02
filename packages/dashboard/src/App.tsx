import { Arcade } from './Arcade';
import { ConnectWallet } from './ConnectWallet';
import { Die } from './arcade/art';

export function App() {
  return (
    <div className="app">
      <Header />
      <Arcade />
      <Footer />
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
        <span className="hdr__net">testnet2</span>
        <ConnectWallet />
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="footer">
      <span className="footer__brand">Unicity Arcade House</span>
      <span>Provably-fair games, on-chain payouts</span>
      <span>Built on the Sphere SDK · testnet2</span>
    </footer>
  );
}

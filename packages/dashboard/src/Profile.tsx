import { useCallback, useEffect, useState } from 'react';
import { useWalletCtx } from './WalletContext';
import { ConnectWallet } from './ConnectWallet';
import { fetchProfile, hasBackend, type PlayerProfile } from './lib/arcade';
import { AchievementsPanel } from './arcade/Achievements';
import { NavLink } from './lib/nav';
import { InvitePanel } from './arcade/Invite';

interface IdLike {
  nametag?: string;
  directAddress?: string;
  chainPubkey?: string;
}
const addressOf = (id: IdLike): string | undefined =>
  id.chainPubkey ?? id.directAddress ?? (id.nametag ? `@${id.nametag}` : undefined);
const nameOf = (id: IdLike): string => {
  if (id.nametag) return id.nametag.replace(/^@/, '');
  if (id.directAddress) return `${id.directAddress.slice(0, 10)}…`;
  return 'anon';
};

/** The player's profile: identity, lifetime stats, achievements, and invites. */
export function Profile() {
  const wallet = useWalletCtx();
  const connected = wallet.status === 'connected' && !!wallet.identity;
  const [profile, setProfile] = useState<PlayerProfile | null>(null);

  const address = wallet.identity ? addressOf(wallet.identity) : undefined;
  const refresh = useCallback(() => {
    if (address) void fetchProfile(address).then(setProfile).catch(() => {});
  }, [address]);

  useEffect(() => {
    if (!connected) return;
    refresh();
    const t = setInterval(refresh, 15_000);
    return () => clearInterval(t);
  }, [connected, refresh]);

  return (
    <section className="profile">
      <NavLink className="fair__back" href="/">
        ← back to the floor
      </NavLink>

      {!connected ? (
        <div className="profile__gate">
          <h1 className="profile__gatetitle">Your profile</h1>
          <p className="profile__gatesub">Connect your wallet to see your stats, badges, and invite link.</p>
          <ConnectWallet />
        </div>
      ) : (
        <>
          <header className="profile__hero">
            <span className="profile__avatar" aria-hidden="true">
              {nameOf(wallet.identity as IdLike).slice(0, 2).toUpperCase()}
            </span>
            <div className="profile__id">
              <h1 className="profile__name">@{nameOf(wallet.identity as IdLike)}</h1>
              <span className="profile__net">Unicity testnet2</span>
            </div>
            <div className="profile__balance">
              <span className="profile__balv">{profile?.balanceUct ?? '…'}</span>
              <span className="profile__ball">UCT balance</span>
            </div>
          </header>

          <StatGrid p={profile} />

          {!hasBackend() ? null : (
            <>
              <AchievementsPanel items={profile?.achievements ?? []} />
              <InvitePanel info={profile?.referral ?? null} />
            </>
          )}
        </>
      )}
    </section>
  );
}

function StatGrid({ p }: { p: PlayerProfile | null }) {
  const stats: Array<{ label: string; value: string | number }> = [
    { label: 'current streak', value: p?.streak ?? 0 },
    { label: 'best streak', value: p?.best ?? 0 },
    { label: 'rounds won', value: p?.wins ?? 0 },
    { label: 'rounds played', value: p?.plays ?? 0 },
    { label: 'total won', value: `${p?.totalWon ?? 0} UCT` },
    { label: 'biggest win', value: `${p?.biggestWin ?? 0} UCT` },
    { label: 'jackpots hit', value: p?.jackpots ?? 0 },
    { label: 'games explored', value: `${p?.gamesPlayed ?? 0}/${p?.totalGames ?? 7}` },
  ];
  return (
    <div className="pstats">
      {stats.map((s) => (
        <div className="pstat" key={s.label}>
          <span className="pstat__v">{s.value}</span>
          <span className="pstat__l">{s.label}</span>
        </div>
      ))}
    </div>
  );
}

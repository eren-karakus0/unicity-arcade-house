/**
 * Invite panel — the player's referral code, a one-click share link, and how
 * many friends they've brought in. Bringing a friend who plays pays both sides
 * real UCT, settled the same way as everything else.
 */
import { useState } from 'react';
import type { ReferralInfo } from '../lib/arcade';

export function InvitePanel({ info, bonus = 5, welcome = 2 }: { info: ReferralInfo | null; bonus?: number; welcome?: number }) {
  const [copied, setCopied] = useState<'' | 'link' | 'code'>('');
  if (!info?.code) return null;

  const link = `${window.location.origin}/?ref=${info.code}`;
  const copy = (what: 'link' | 'code', text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(what);
      setTimeout(() => setCopied(''), 1600);
    });
  };

  return (
    <div className="invite">
      <div className="invite__head">
        <span className="invite__title">Invite a friend</span>
        {info.referrals > 0 && (
          <span className="invite__count">
            {info.referrals} joined · +{info.referrals * bonus} UCT earned
          </span>
        )}
      </div>
      <p className="invite__blurb">
        Share your link. When a friend connects and plays, the house pays <strong>you {bonus} UCT</strong>{' '}
        and gives <strong>them {welcome} UCT</strong> to start — real, on-chain.
      </p>
      <div className="invite__row">
        <code className="invite__link">{link}</code>
        <button className="invite__btn" onClick={() => copy('link', link)}>
          {copied === 'link' ? 'copied ✓' : 'copy link'}
        </button>
      </div>
      <div className="invite__coderow">
        <span className="invite__codelabel">your code</span>
        <button className="invite__code" title="copy code" onClick={() => copy('code', info.code!)}>
          {copied === 'code' ? 'copied ✓' : info.code}
        </button>
      </div>
    </div>
  );
}

import { createHash } from 'node:crypto';

/**
 * Referrals — a short, stable, URL-safe code derived from a player's key. The
 * server is authoritative (it owns the code→key map for resolution); the UI
 * just displays the code it's given. Derivation is deterministic so a player's
 * code never changes across sessions.
 */
export const REFERRAL_BONUS_UCT = 5; // credited to the referrer
export const REFERRAL_WELCOME_UCT = 2; // credited to the new player

/** A 6-char base36 code from the first 4 bytes of sha256(key). */
export function referralCode(key: string): string {
  const digest = createHash('sha256').update(key).digest();
  const n = digest.readUInt32BE(0);
  return n.toString(36).toUpperCase().padStart(6, '0').slice(0, 6);
}

/** Normalize a user-supplied referral code (trim, upcase, strip noise). */
export function normalizeCode(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const c = raw.trim().toUpperCase().replace(/[^0-9A-Z]/g, '');
  return c.length >= 4 && c.length <= 8 ? c : undefined;
}

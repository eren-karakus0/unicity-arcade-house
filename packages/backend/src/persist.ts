/**
 * Lightweight file persistence for the arcade house state. A single JSON
 * snapshot, written atomically (tmp + rename). Keeps player balances, the
 * leaderboard, referrals, the jackpot and tournament across process restarts on
 * any host with a durable filesystem (local dev, or a server / mounted disk).
 *
 * NOTE: on an ephemeral-filesystem host (e.g. Render's free tier, which
 * destroys the container on sleep), the file does not survive a full restart -
 * a real database (DATABASE_URL) is the fix. See store.ts.
 */
import fs from 'node:fs';
import path from 'node:path';

export function loadSnapshot<T>(file: string): T | null {
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function saveSnapshot(file: string, snapshot: unknown): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot), 'utf8');
    fs.renameSync(tmp, file); // atomic on the same filesystem
    return true;
  } catch {
    return false;
  }
}

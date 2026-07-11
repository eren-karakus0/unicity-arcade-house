/**
 * Durable persistence for the arcade house snapshot, behind one async interface
 * with two interchangeable backends:
 *
 *   - Postgres (when DATABASE_URL is set): a single JSONB row. Survives process
 *     restarts and redeploys on any host - this is production.
 *   - File (fallback): a JSON file on disk, for local dev with no database.
 *
 * Both round-trip the exact `GameDealer.snapshot()` / `restore()` shape, so the
 * game logic itself is untouched - we only swap where the bytes land.
 */
import pg from 'pg';
import type { Logger } from '@bazaar/core';
import { loadSnapshot, saveSnapshot } from './persist.js';

export interface SnapshotStore<T> {
  readonly kind: 'postgres' | 'file';
  load(): Promise<T | null>;
  save(snapshot: T): Promise<boolean>;
  close(): Promise<void>;
}

class FileStore<T> implements SnapshotStore<T> {
  readonly kind = 'file' as const;
  constructor(private readonly file: string) {}
  load(): Promise<T | null> {
    return Promise.resolve(loadSnapshot<T>(this.file));
  }
  save(snapshot: T): Promise<boolean> {
    return Promise.resolve(saveSnapshot(this.file, snapshot));
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

class PgStore<T> implements SnapshotStore<T> {
  readonly kind = 'postgres' as const;
  private readonly pool: pg.Pool;
  private readonly ready: Promise<void>;

  constructor(
    databaseUrl: string,
    private readonly logger?: Logger,
  ) {
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
    // A dropped idle connection must not crash the process.
    this.pool.on('error', (err) => this.logger?.warn(`pg pool error: ${err.message}`));
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS arcade_state (
         id         smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
         data       jsonb NOT NULL,
         updated_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
  }

  async load(): Promise<T | null> {
    await this.ready;
    const res = await this.pool.query<{ data: T }>('SELECT data FROM arcade_state WHERE id = 1');
    return res.rows[0]?.data ?? null;
  }

  async save(snapshot: T): Promise<boolean> {
    try {
      await this.ready;
      await this.pool.query(
        `INSERT INTO arcade_state (id, data, updated_at) VALUES (1, $1::jsonb, now())
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [JSON.stringify(snapshot)],
      );
      return true;
    } catch (err) {
      this.logger?.error(`snapshot save failed: ${(err as Error).message}`);
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Pick a backend from the environment. A configured DATABASE_URL selects
 * Postgres (and the connection is validated up-front so a misconfiguration
 * fails at boot, not on the first save); otherwise state falls back to a file.
 */
export async function createSnapshotStore<T>(opts: {
  databaseUrl?: string;
  file: string;
  logger?: Logger;
}): Promise<SnapshotStore<T>> {
  if (opts.databaseUrl) {
    const store = new PgStore<T>(opts.databaseUrl, opts.logger);
    await store.load(); // eager connect + ensure schema; throws if unreachable
    return store;
  }
  return new FileStore<T>(opts.file);
}

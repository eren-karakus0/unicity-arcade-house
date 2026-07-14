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

// Only our own identifiers reach this (a fixed default or a hard-coded literal),
// never user input — but validate anyway so the table name can never inject.
const SAFE_TABLE = /^[a-z_][a-z0-9_]*$/;

class PgStore<T> implements SnapshotStore<T> {
  readonly kind = 'postgres' as const;
  private readonly pool: pg.Pool;
  private readonly ready: Promise<void>;
  private readonly table: string;

  constructor(
    databaseUrl: string,
    private readonly logger?: Logger,
    table = 'arcade_state',
  ) {
    if (!SAFE_TABLE.test(table)) throw new Error(`unsafe table name: ${table}`);
    this.table = table;
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
    // A dropped idle connection must not crash the process.
    this.pool.on('error', (err) => this.logger?.warn(`pg pool error: ${err.message}`));
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS ${this.table} (
         id         smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
         data       jsonb NOT NULL,
         updated_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
  }

  async load(): Promise<T | null> {
    await this.ready;
    const res = await this.pool.query<{ data: T }>(`SELECT data FROM ${this.table} WHERE id = 1`);
    return res.rows[0]?.data ?? null;
  }

  async save(snapshot: T): Promise<boolean> {
    try {
      await this.ready;
      await this.pool.query(
        `INSERT INTO ${this.table} (id, data, updated_at) VALUES (1, $1::jsonb, now())
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
  /** Postgres table (own single-row store per name). Default 'arcade_state'. */
  table?: string;
}): Promise<SnapshotStore<T>> {
  if (opts.databaseUrl) {
    const store = new PgStore<T>(opts.databaseUrl, opts.logger, opts.table);
    await store.load(); // eager connect + ensure schema; throws if unreachable
    return store;
  }
  return new FileStore<T>(opts.file);
}

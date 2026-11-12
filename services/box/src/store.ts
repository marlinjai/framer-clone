// services/box/src/store.ts
//
// The one thing the box may do in the database: call the function
// `box_document(site_id, sha256)`, as the role `box_reader`, which can read no
// table and no view. A caller gets the row of a pair it already knows and can
// list nothing. The function is the contract the application's migration has
// to meet (decision D18, and the fixture in test/integration/fixture.sql):
//
//   box_document(text, text) RETURNS TABLE (
//     document text, live boolean, subdomain_labels text[], custom_hostnames text[])

import postgres from 'postgres';

export interface BoxRow {
  document: unknown;
  live: unknown;
  subdomainLabels: unknown;
  customHostnames: unknown;
}

export interface BoxStore {
  /** The row of a pair, or null when there is none. Rejects when the database cannot be asked. */
  find(siteId: string, sha256: string): Promise<BoxRow | null>;
  /** Resolves when one call of the function works. */
  ping(): Promise<void>;
  close(): Promise<void>;
}

/** Why the database could not be asked, as one of a few words. Never the driver's own text, which can name hosts and roles. */
export type StoreFailure = 'timeout' | 'connect' | 'denied' | 'query';

export function storeFailureOf(error: unknown): StoreFailure {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : '';
  if (code === 'BOX_TIMEOUT' || code === 'CONNECT_TIMEOUT' || code === '57014') return 'timeout';
  if (code.startsWith('28') || code === '42501') return 'denied';
  if (/^(ECONN|ENOTFOUND|EAI_|EHOST|ENET|EPIPE|ETIMEDOUT|CONNECTION_)/.test(code) || code.startsWith('08') || code.startsWith('57P')) return 'connect';
  return 'query';
}

class TimeoutError extends Error {
  readonly code = 'BOX_TIMEOUT';
}

/**
 * The promise, or a rejection after `ms`: a connection that neither answers
 * nor fails must not hold a request open.
 */
export function withTimeout<T>(promise: PromiseLike<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError('the database did not answer in time')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export interface PostgresStoreOptions {
  /** How long one call may take before it is given up on. */
  queryTimeoutMs?: number;
  connectTimeoutSeconds?: number;
}

export function createPostgresStore(databaseUrl: string, options: PostgresStoreOptions = {}): BoxStore {
  const queryTimeoutMs = options.queryTimeoutMs ?? 3000;
  const connect = () =>
    postgres(databaseUrl, {
      // The role allows 4 connections; one is left for an operator's check.
      max: 3,
      idle_timeout: 30,
      connect_timeout: options.connectTimeoutSeconds ?? 5,
      max_lifetime: 60 * 30,
      // No look at the type catalogue: the two list columns are read as JSON.
      fetch_types: false,
      prepare: true,
      onnotice: () => {},
      connection: { application_name: 'framer-clone-box', statement_timeout: 2000 },
    });
  let sql = connect();

  /**
   * Runs one call. When it is given up on, the whole pool is thrown away and a
   * new one takes its place: connections that went silent (a database that
   * accepts and never answers) are not asked again, and the next request
   * starts on fresh ones, so service comes back by itself. The old pool is
   * closed at once, which ends its queries; nothing is cancelled through a
   * second connection, whose failure would be a rejection nobody waits for.
   */
  async function run<T>(query: (db: typeof sql) => PromiseLike<T>): Promise<T> {
    const db = sql;
    // The driver's promise is observed even after it was given up on.
    const pending = Promise.resolve(query(db));
    pending.catch(() => {});
    try {
      return await withTimeout(pending, queryTimeoutMs);
    } catch (error) {
      if (error instanceof TimeoutError && sql === db) {
        sql = connect();
        db.end({ timeout: 0 }).catch(() => {});
      }
      throw error;
    }
  }

  return {
    async find(siteId, sha256) {
      const rows = await run(
        (db) => db<{ document: unknown; live: unknown; subdomain_labels: unknown; custom_hostnames: unknown }[]>`
          SELECT document, live, to_json(subdomain_labels) AS subdomain_labels, to_json(custom_hostnames) AS custom_hostnames
          FROM box_document(${siteId}, ${sha256})
          LIMIT 1
        `,
      );
      const row = rows[0];
      if (!row) return null;
      return { document: row.document, live: row.live, subdomainLabels: row.subdomain_labels, customHostnames: row.custom_hostnames };
    },
    async ping() {
      // A pair no site can have: the call itself is what is checked.
      await run((db) => db`SELECT 1 AS ok FROM box_document(${'00000000-0000-0000-0000-000000000000'}, ${'0'.repeat(64)})`);
    },
    async close() {
      await sql.end({ timeout: 2 });
    },
  };
}

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

import { connect as netConnect, type Socket } from 'node:net';
import postgres from 'postgres';
import { parseDatabaseUrl, type DatabaseTarget } from './databaseUrl';

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

/** One set of connections: what the store asks, and how it is thrown away. */
export interface BoxPool {
  find(siteId: string, sha256: string): PromiseLike<BoxRow | null>;
  ping(): PromiseLike<void>;
  /** Ends the pool in an orderly way. */
  end(): Promise<void>;
  /** Closes every connection of the pool now, whatever state it is in. */
  destroy(): void;
}

export interface PostgresStoreOptions {
  /** How long one call may take, queueing and connecting included, before the caller is told to come back. */
  queryTimeoutMs?: number;
  /** How long one connection may take to open. Kept below the query timeout, so a slow connect fails as itself. */
  connectTimeoutMs?: number;
  /** Opens a pool. For tests; the default is the real driver. */
  open?: () => BoxPool;
  now?: () => number;
}

/** True for an error the database itself sent (a five character SQLSTATE): proof that it answers. */
function isAnswerFromDatabase(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && /^[0-9A-Z]{5}$/.test(String((error as { code: unknown }).code));
}

function openPostgresPool(target: DatabaseTarget, connectTimeoutMs: number): BoxPool {
  const sockets = new Set<Socket>();
  // Set when the pool is thrown away: from then on it opens no connection, whatever the driver retries.
  let dead = false;
  // `socket` is an option of the driver (its connection.js) that its type definitions leave out. The
  // driver's version is pinned exactly, and a test fails if the option stops being used.
  const driverOptions: postgres.Options<Record<string, never>> & { socket: () => Promise<Socket> } = {
    host: target.host,
    port: target.port,
    database: target.database,
    username: target.username,
    password: target.password,
    ssl: target.ssl,
    // The role allows 4 connections. Two here, so a pool that is being thrown away and the one that
    // takes its place stay within the limit together.
    max: 2,
    idle_timeout: 30,
    connect_timeout: Math.ceil(connectTimeoutMs / 1000),
    max_lifetime: 60 * 30,
    // No look at the type catalogue: the two list columns are read as JSON.
    fetch_types: false,
    prepare: true,
    onnotice: () => {},
    connection: { application_name: 'framer-clone-box', statement_timeout: 2000 },
    // The box opens the socket itself, to the one host it checked, and keeps hold of it, so a
    // connection that went silent can be closed for real and not only asked to close.
    socket: () =>
      new Promise<Socket>((resolve, reject) => {
        if (dead) {
          reject(Object.assign(new Error('the pool was thrown away'), { code: 'CONNECTION_DESTROYED' }));
          return;
        }
        const socket = netConnect({ host: target.host, port: target.port });
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
        const timer = setTimeout(() => socket.destroy(Object.assign(new Error('the connection did not open in time'), { code: 'CONNECT_TIMEOUT' })), connectTimeoutMs);
        socket.once('connect', () => {
          clearTimeout(timer);
          socket.off('error', reject);
          resolve(socket);
        });
        socket.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      }),
  };
  const sql = postgres(driverOptions);
  return {
    async find(siteId, sha256) {
      const rows = await sql<{ document: unknown; live: unknown; subdomain_labels: unknown; custom_hostnames: unknown }[]>`
        SELECT document, live, to_json(subdomain_labels) AS subdomain_labels, to_json(custom_hostnames) AS custom_hostnames
        FROM box_document(${siteId}, ${sha256})
        LIMIT 1
      `;
      const row = rows[0];
      if (!row) return null;
      return { document: row.document, live: row.live, subdomainLabels: row.subdomain_labels, customHostnames: row.custom_hostnames };
    },
    async ping() {
      // A pair no site can have: the call itself is what is checked.
      await sql`SELECT 1 AS ok FROM box_document(${'00000000-0000-0000-0000-000000000000'}, ${'0'.repeat(64)})`;
    },
    end: () => sql.end({ timeout: 2 }),
    destroy() {
      dead = true;
      sql.end({ timeout: 0 }).catch(() => {});
      for (const socket of sockets) socket.destroy();
    },
  };
}

/**
 * The store. `database` is the address as text or already read; the driver is
 * given its parts, never the text (databaseUrl.ts).
 */
export function createPostgresStore(database: string | DatabaseTarget, options: PostgresStoreOptions = {}): BoxStore {
  const queryTimeoutMs = options.queryTimeoutMs ?? 3000;
  const connectTimeoutMs = options.connectTimeoutMs ?? 2000;
  const now = options.now ?? (() => performance.now());
  const target = typeof database === 'string' ? parseDatabaseUrl(database) : database;
  const open = options.open ?? (() => openPostgresPool(target, connectTimeoutMs));

  let current = { pool: open(), lastAnswer: now() };

  /**
   * Runs one call on the current pool. A call that takes too long is given up
   * on, and its caller is told to come back. The pool is thrown away only
   * when it gave no answer at all, to any call, since this call began: a
   * database that is busy but answering keeps its pool (replacing it would
   * fail every other call for nothing), one that went silent does not (its
   * connections would never be asked again). The old pool's connections are
   * closed for real, at once, and the next request starts on fresh ones, so
   * service comes back by itself.
   */
  async function run<T>(call: (pool: BoxPool) => PromiseLike<T>): Promise<T> {
    const used = current;
    const started = now();
    const pending = Promise.resolve().then(() => call(used.pool));
    pending.then(
      () => {
        used.lastAnswer = now();
      },
      (error: unknown) => {
        // Also keeps the driver's promise observed after it was given up on.
        if (isAnswerFromDatabase(error)) used.lastAnswer = now();
      },
    );
    try {
      return await withTimeout(pending, queryTimeoutMs);
    } catch (error) {
      if (error instanceof TimeoutError && current === used && used.lastAnswer < started) {
        current = { pool: open(), lastAnswer: now() };
        used.pool.destroy();
      }
      throw error;
    }
  }

  return {
    find: (siteId, sha256) => run((pool) => pool.find(siteId, sha256)),
    ping: () => run((pool) => pool.ping()),
    close: () => current.pool.end(),
  };
}

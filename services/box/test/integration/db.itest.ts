import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BoxConfig } from '../../src/config';
import { createBoxHandler } from '../../src/handler';
import { createPostgresStore, type BoxStore } from '../../src/store';
import { startScratchPostgres, type ScratchPostgres } from './docker';

// The box's store and handler against a real Postgres 16 holding the fixture:
// what the role can and cannot do, what the function lets through, and what
// happens when the database goes away and comes back.

const SITE_A = '0b0e7c1a-5d2f-4c3b-9a8e-1f2d3c4b5a69';
const SITE_B = '7a1f3c55-0e2d-4b6a-8c9d-2e3f4a5b6c7d';
const SITE_OFF = '3c9d1e2f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const HASH = 'a'.repeat(64);
const BLOCKED = 'b'.repeat(64);
const FRAME = { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'cross-site' };

const config: BoxConfig = {
  listenHost: '127.0.0.1',
  port: 0,
  databaseUrl: '',
  editorHost: 'app.lumitra.co',
  sitesBaseHost: 'sites.lumitra.co',
  trustedProxies: [],
  abuseContact: null,
  securityContact: null,
  takedownUrl: null,
  securityTxtExpires: null,
};

let pg: ScratchPostgres;
let store: BoxStore;

beforeAll(async () => {
  pg = await startScratchPostgres();
  pg.sql(`
    INSERT INTO sites (id, custom_code_enabled) VALUES ('${SITE_A}', true), ('${SITE_B}', true), ('${SITE_OFF}', false);
    INSERT INTO site_domains (id, site_id, subdomain, custom_hostname, verification_status) VALUES
      ('d1', '${SITE_A}', 'shop', NULL, 'active'),
      ('d2', '${SITE_A}', 'preview-abcdefghijklmnopqrstuvwxyz234567', NULL, 'active'),
      ('d3', '${SITE_A}', NULL, 'www.example.com', 'active'),
      ('d4', '${SITE_A}', NULL, 'pending.example.com', 'pending'),
      ('d5', '${SITE_A}', NULL, 'preview-x.sites.lumitra.co', 'verified'),
      ('d6', '${SITE_A}', NULL, '*.sites.lumitra.co', 'active'),
      ('d8', '${SITE_A}', NULL, 'other.sites.lumitra.co', 'active'),
      ('d7', '${SITE_B}', 'other', NULL, 'active');
    INSERT INTO custom_code_blobs (site_id, sha256, document, declaration, title, created_by, blocked_at) VALUES
      ('${SITE_A}', '${HASH}', '<p>site a</p>', '{}', 'A', 'u1', NULL),
      ('${SITE_A}', '${BLOCKED}', '<p>blocked</p>', '{}', 'Blocked', 'u1', now()),
      ('${SITE_OFF}', '${HASH}', '<p>off</p>', '{}', 'Off', 'u1', NULL);
  `);
  store = createPostgresStore(pg.readerUrl);
});

afterAll(async () => {
  await store?.close();
  pg?.remove();
});

describe('the role box_reader', () => {
  const asReader = () => postgres(pg.readerUrl, { max: 1, onnotice: () => {} });

  it('can call the one function for a pair it knows', async () => {
    const sql = asReader();
    try {
      const rows = await sql`SELECT document, live FROM box_document(${SITE_A}, ${HASH})`;
      expect(rows.map((row) => [row.document, row.live])).toEqual([['<p>site a</p>', true]]);
      expect(await sql`SELECT 1 FROM box_document(${SITE_B}, ${HASH})`).toHaveLength(0);
    } finally {
      await sql.end();
    }
  });

  // Each statement with the one error it must fail with: permission denied (42501) unless said otherwise.
  it.each([
    ['read the blobs', 'SELECT * FROM custom_code_blobs', '42501'],
    ['read the sites', 'SELECT * FROM sites', '42501'],
    ['read the domains', 'SELECT * FROM site_domains', '42501'],
    ['read anything else of the application', 'SELECT * FROM application_rows', '42501'],
    ['read password hashes', 'SELECT rolpassword FROM pg_authid', '42501'],
    ['write a blob', "INSERT INTO custom_code_blobs (site_id, sha256, document, declaration, title, created_by) VALUES ('x', 'y', 'z', '{}', 't', 'u')", '42501'],
    ['unblock a blob', 'UPDATE custom_code_blobs SET blocked_at = NULL', '42501'],
    ['switch a site on', 'UPDATE sites SET custom_code_enabled = true', '42501'],
    ['delete blobs', 'DELETE FROM custom_code_blobs', '42501'],
    ['empty a table', 'TRUNCATE custom_code_blobs', '42501'],
    ['create a table', 'CREATE TABLE box_owned (id int)', '42501'],
    ['create a temporary table', 'CREATE TEMPORARY TABLE box_temp (id int)', '42501'],
    ['create a schema', 'CREATE SCHEMA box_owned', '42501'],
    ['replace the function', "CREATE OR REPLACE FUNCTION box_document(p_site_id text, p_sha256 text) RETURNS TABLE (document text, live boolean, subdomain_labels text[], custom_hostnames text[]) LANGUAGE sql AS 'SELECT NULL::text, true, ARRAY[]::text[], ARRAY[]::text[]'", '42501'],
    ['drop the function', 'DROP FUNCTION box_document(text, text)', '42501'],
    ['run a program on the server', "COPY application_rows TO PROGRAM 'id'", '42501'],
    ['read a file of the server', "SELECT pg_read_file('/etc/passwd')", '42501'],
    ['become another role', 'SET ROLE postgres', '42501'],
  ])('cannot %s', async (_what, statement, code) => {
    const sql = asReader();
    try {
      await expect(sql.unsafe(statement)).rejects.toMatchObject({ code });
    } finally {
      await sql.end();
    }
  });

  it('cannot list what the function could answer: there is nothing to select from', async () => {
    const sql = asReader();
    try {
      const readable = await sql`
        SELECT table_schema, table_name FROM information_schema.tables
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND has_table_privilege(format('%I.%I', table_schema, table_name), 'SELECT')
      `;
      expect(readable).toHaveLength(0);
      // The function's own text holds table names, never rows.
      await expect(sql.unsafe('SELECT * FROM box_documents')).rejects.toMatchObject({ code: '42P01' });
    } finally {
      await sql.end();
    }
  });

  it('never gets the code of a blocked blob or of a site that is off', async () => {
    const sql = asReader();
    try {
      expect((await sql`SELECT document, live FROM box_document(${SITE_A}, ${BLOCKED})`).map((r) => [r.document, r.live])).toEqual([[null, false]]);
      expect((await sql`SELECT document, live FROM box_document(${SITE_OFF}, ${HASH})`).map((r) => [r.document, r.live])).toEqual([[null, false]]);
    } finally {
      await sql.end();
    }
  });

  it('cannot bend the function with text in place of a pair', async () => {
    const sql = asReader();
    try {
      for (const hostile of ["' OR '1'='1", "x'; DROP TABLE sites; --", '%', '_', `${SITE_A}' --`, '\\']) {
        expect(await sql`SELECT 1 FROM box_document(${hostile}, ${HASH})`).toHaveLength(0);
        expect(await sql`SELECT 1 FROM box_document(${SITE_A}, ${hostile})`).toHaveLength(0);
      }
    } finally {
      await sql.end();
    }
    expect(pg.sql('SELECT count(*) FROM sites;').trim()).toBe('3');
  });

  it('is stopped after two seconds by default and at four connections', async () => {
    const one = asReader();
    const others = [1, 2, 3].map(() => asReader());
    const fifth = postgres(pg.readerUrl, { max: 1, onnotice: () => {}, connect_timeout: 5 });
    // The store keeps idle connections of its own: close it so this test counts only what it opens.
    await store.close();
    try {
      await expect(one`SELECT pg_sleep(4)`).rejects.toMatchObject({ code: '57014' });
      for (const sql of others) await sql`SELECT 1`;
      await expect(fifth`SELECT 1`).rejects.toMatchObject({ code: '53300' });
    } finally {
      await Promise.all([one, ...others, fifth].map((sql) => sql.end({ timeout: 1 })));
      store = createPostgresStore(pg.readerUrl);
    }
  });

  it('gets no document larger than a block may be', async () => {
    const big = 'e'.repeat(64);
    pg.sql(`INSERT INTO custom_code_blobs (site_id, sha256, document, declaration, title, created_by) VALUES ('${SITE_A}', '${big}', repeat('x', 262145), '{}', 'Big', 'u1');`);
    const sql = asReader();
    try {
      expect((await sql`SELECT document, live FROM box_document(${SITE_A}, ${big})`).map((r) => [r.document, r.live])).toEqual([[null, true]]);
    } finally {
      await sql.end();
      pg.sql(`DELETE FROM custom_code_blobs WHERE sha256 = '${big}';`);
    }
  });

  it('RESIDUAL: it can read the catalogs (names of tables, columns and functions), never their rows', async () => {
    const sql = asReader();
    try {
      const names = await sql`SELECT relname FROM pg_class WHERE relname IN ('custom_code_blobs', 'application_rows') ORDER BY relname`;
      expect(names.map((row) => row.relname)).toEqual(['application_rows', 'custom_code_blobs']);
    } finally {
      await sql.end();
    }
  });

  // Decision D20: stated residuals of a stolen password, asserted so that a change in either direction is noticed.
  it('RESIDUAL: a session can lift its own timeout and take an advisory lock', async () => {
    const sql = postgres(pg.readerUrl, { max: 1, onnotice: () => {} });
    try {
      await sql.begin(async (tx) => {
        await tx`SET LOCAL statement_timeout = 0`;
        expect((await tx`SELECT pg_sleep(2.5) IS NOT NULL AS slept`)[0]?.slept).toBe(true);
        expect((await tx`SELECT pg_try_advisory_xact_lock(424242) AS locked`)[0]?.locked).toBe(true);
      });
    } finally {
      await sql.end();
    }
  });
});

describe('the handler on a real database', () => {
  const handlerOf = (cacheTtlMs = 60_000) => {
    const handle = createBoxHandler({ config, store, killSwitchOn: () => false, cacheTtlMs });
    return (siteId: string, sha256: string) => handle({ method: 'GET', url: `/box/${siteId}/${sha256}`, headers: FRAME, remoteAddress: '203.0.113.7' });
  };

  it('serves a live block with the hosts of its site, and never a preview host, a wildcard or a platform name claimed as a custom domain', async () => {
    const response = await handlerOf()(SITE_A, HASH);
    expect(response.status).toBe(200);
    expect(response.body.toString('utf8').endsWith('<p>site a</p>')).toBe(true);
    expect(response.headers['Content-Security-Policy']).toContain(
      '; frame-ancestors https://shop.sites.lumitra.co https://www.example.com https://app.lumitra.co; report-uri https://app.lumitra.co/api/csp-report/box',
    );
  });

  it('finds nothing for another site naming the hash, or for an unknown hash', async () => {
    const get = handlerOf();
    expect((await get(SITE_B, HASH)).status).toBe(404);
    expect((await get(SITE_A, 'c'.repeat(64))).status).toBe(404);
  });

  it('answers 410 for a blocked blob and for a site that is off', async () => {
    const get = handlerOf();
    expect((await get(SITE_A, BLOCKED)).status).toBe(410);
    expect((await get(SITE_OFF, HASH)).status).toBe(410);
  });

  it('follows a takedown and its reversal once the remembered answer has run out', async () => {
    const get = handlerOf(0);
    expect((await get(SITE_A, HASH)).status).toBe(200);
    pg.sql(`UPDATE custom_code_blobs SET blocked_at = now() WHERE site_id = '${SITE_A}' AND sha256 = '${HASH}';`);
    expect((await get(SITE_A, HASH)).status).toBe(410);
    pg.sql(`UPDATE custom_code_blobs SET blocked_at = NULL WHERE site_id = '${SITE_A}' AND sha256 = '${HASH}';`);
    pg.sql(`UPDATE sites SET custom_code_enabled = false WHERE id = '${SITE_A}';`);
    expect((await get(SITE_A, HASH)).status).toBe(410);
    pg.sql(`UPDATE sites SET custom_code_enabled = true WHERE id = '${SITE_A}';`);
    expect((await get(SITE_A, HASH)).status).toBe(200);
  });

  // What this holds: a frozen database is answered 503 in bounded time, nothing stray is left behind, and
  // service returns. That a silent pool is replaced is held by the unit tests, which fail without it; a
  // paused Postgres answers its old sessions again once it thaws, so this test alone would not show it.
  it('answers 503 in time while the database is frozen, and serves again when it thaws', async () => {
    const frozenStore = createPostgresStore(pg.readerUrl, { queryTimeoutMs: 1500 });
    const handle = createBoxHandler({ config, store: frozenStore, killSwitchOn: () => false, cacheTtlMs: 0 });
    const get = () => handle({ method: 'GET', url: `/box/${SITE_A}/${HASH}`, headers: FRAME, remoteAddress: '203.0.113.7' });
    const stray: unknown[] = [];
    const onStray = (reason: unknown) => stray.push(reason);
    process.on('unhandledRejection', onStray);
    try {
      expect((await get()).status).toBe(200);
      // Frozen: the connection the store holds stays open and never answers.
      pg.pause();
      try {
        for (let i = 0; i < 3; i++) {
          const started = Date.now();
          const down = await get();
          expect(down.status).toBe(503);
          expect(down.body.length).toBe(0);
          expect(Date.now() - started).toBeLessThan(8000);
        }
      } finally {
        pg.unpause();
      }
      let status = 0;
      for (let i = 0; i < 40 && status !== 200; i++) {
        status = (await get()).status;
        if (status !== 200) await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(status).toBe(200);
      expect(stray).toEqual([]);
    } finally {
      process.off('unhandledRejection', onStray);
      await frozenStore.close().catch(() => {});
    }
  });

  it('answers 503 while the database is away and serves again when it is back', async () => {
    const handle = createBoxHandler({ config, store, killSwitchOn: () => false, cacheTtlMs: 0 });
    const get = (url: string, headers = FRAME) => handle({ method: 'GET', url, headers, remoteAddress: '203.0.113.7' });
    expect((await get(`/box/${SITE_A}/${HASH}`)).status).toBe(200);
    pg.stop();
    try {
      const down = await get(`/box/${SITE_A}/${HASH}`);
      expect(down.status).toBe(503);
      expect(down.body.length).toBe(0);
      const health = await get('/health/db', {} as typeof FRAME);
      expect(health.status).toBe(503);
      expect(health.body.toString()).toMatch(/^unavailable: (connect|timeout)$/);
      // The process itself is still well.
      expect((await get('/health', {} as typeof FRAME)).status).toBe(200);
    } finally {
      await pg.start();
    }
    let status = 0;
    for (let i = 0; i < 40 && status !== 200; i++) {
      status = (await get(`/box/${SITE_A}/${HASH}`)).status;
      if (status !== 200) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(status).toBe(200);
  });
});

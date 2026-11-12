// The Postgres repository of the model store and its migration (plan S2), against a REAL Postgres: the integration
// globalSetup's throwaway container, which has run every migration (including 20261112200000_site_models) with
// `prisma migrate deploy` before any test. Scratch databases only; nothing here can reach production.
//
// Covered: the round trip, tenant isolation (a repository made for a workspace cannot see, change or insert into another
// workspace's rows; the same hash in two sites is two rows), the atomic quota under parallel uploads, originals counted
// once, a branch refused, every database constraint, the cascade from the site, the failure path (a refused insert
// leaves no row and releases the lock), and the migration's lifecycle on a scratch database (applied, rolled back,
// applied again, a second apply refused cleanly, a failed apply inside a transaction leaving nothing).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '@/server/db';
import { SiteBranchRepository } from '@/server/sites/branches/repository';
import { latestVersionRepository } from '@/server/sites/__tests__/latestVersionRepository';
import { MODEL_QUOTAS } from '@/lib/scene/modelQuota';
import { PrismaSiteModels } from '../prismaModels';
import type { SiteModelRecord } from '../ports';

const MB = 1024 * 1024;
const GROUP = '018f9c10-0000-7000-8000-0000000b6a01';
const hex = (c: string) => c.repeat(64);

let prisma: PrismaClient;
const created: { workspaceId: string }[] = [];

function project(id: string) {
  const page = { id: 'home', slug: '', metadata: { title: 'Home', description: 'Home' }, appComponentTree: { id: 'root', type: 'div', componentType: 'host', props: {}, children: [] }, canvasNodes: {} };
  return { id, metadata: { title: 'Site', description: 'A site', createdAt: 1, updatedAt: 2 }, pages: { home: page }, siteSettings: { siteName: 'Site' } } as never;
}

async function makeSite() {
  const scope = { workspaceId: `ws_models_${randomUUID().slice(0, 8)}`, tenantGroupId: GROUP };
  const id = randomUUID();
  await latestVersionRepository().saveProject(scope, project(id), { companyId: 'company-models' });
  created.push(scope);
  return { id, workspaceId: scope.workspaceId, scope };
}

let n = 0;
function rec(siteId: string, over: Partial<SiteModelRecord> = {}): SiteModelRecord {
  const i = ++n;
  const sha = i.toString(16).padStart(64, 'a');
  return {
    siteId, sha256: sha, bytes: MB, triangles: 1000, materials: 2, nodes: 5, clips: 1, textures: 1, extensions: ['EXT_meshopt_compression'],
    materialNames: ['paint', 'glass'], nodeNames: ['root'], uploaderId: 'user-1', createdAt: new Date('2026-11-10T10:00:00Z'), lastUsedAt: new Date('2026-11-10T10:00:00Z'),
    originalSha256: `b${i.toString(16).padStart(63, '0')}`, originalBytes: 2 * MB, ...over,
  };
}
const LIMITS = { servedBytes: MODEL_QUOTAS.perSite, originalBytes: MODEL_QUOTAS.originalsPerSite };

/** The Postgres message of a refused statement. */
async function refusal(run: () => Promise<unknown>): Promise<string> {
  try { await run(); } catch (err) { return err instanceof Error ? err.message : String(err); }
  throw new Error('the statement was not refused');
}

beforeAll(() => { prisma = getPrismaClient(); });
afterAll(async () => {
  await prisma.site.deleteMany({ where: { tenantGroupId: GROUP, branchOfSiteId: { not: null } } });
  await prisma.site.deleteMany({ where: { tenantGroupId: GROUP } });
  await prisma.$disconnect();
});

describe('the repository: round trip', () => {
  it('stores, reads, lists, totals, touches and deletes a model, with its names and extensions', async () => {
    const site = await makeSite();
    const repo = new PrismaSiteModels(prisma);
    const r = rec(site.id);
    expect(await repo.insertWithinQuota(r, LIMITS)).toEqual({ ok: true });
    expect(await repo.find(site.id, r.sha256)).toEqual(r);
    expect(await repo.list(site.id)).toEqual([r]);
    expect(await repo.totalBytes(site.id)).toBe(MB);
    // The denormalised isolation columns come from the site, never from the caller.
    const row = await prisma.siteModel.findFirstOrThrow({ where: { siteId: site.id } });
    expect(row.workspaceId).toBe(site.workspaceId);
    expect(row.tenantGroupId).toBe(GROUP);
    await repo.touch(site.id, r.sha256, new Date('2026-11-20T00:00:00Z'));
    expect((await repo.find(site.id, r.sha256))?.lastUsedAt).toEqual(new Date('2026-11-20T00:00:00Z'));
    await repo.delete(site.id, r.sha256);
    expect(await repo.find(site.id, r.sha256)).toBeNull();
    expect(await repo.totalBytes(site.id)).toBe(0);
  });

  it('answers "exists" for the same model twice and keeps one row', async () => {
    const site = await makeSite();
    const repo = new PrismaSiteModels(prisma);
    const r = rec(site.id);
    await repo.insertWithinQuota(r, LIMITS);
    expect(await repo.insertWithinQuota(r, LIMITS)).toEqual({ ok: false, reason: 'exists' });
    expect((await repo.list(site.id)).length).toBe(1);
  });

  it('never moves a last use backwards or before the row was created', async () => {
    const site = await makeSite();
    const repo = new PrismaSiteModels(prisma);
    const r = rec(site.id);
    await repo.insertWithinQuota(r, LIMITS);
    await repo.touch(site.id, r.sha256, new Date('2026-11-15T00:00:00Z'));
    await repo.touch(site.id, r.sha256, new Date('2026-11-01T00:00:00Z'));
    expect((await repo.find(site.id, r.sha256))?.lastUsedAt).toEqual(new Date('2026-11-15T00:00:00Z'));
  });
});

describe('tenant isolation', () => {
  it('lets a repository made for one workspace see, change and delete nothing of another workspace\'s site', async () => {
    const a = await makeSite();
    const b = await makeSite();
    const asA = new PrismaSiteModels(prisma, { workspaceId: a.workspaceId });
    const asB = new PrismaSiteModels(prisma, { workspaceId: b.workspaceId });
    const r = rec(a.id);
    expect(await asA.insertWithinQuota(r, LIMITS)).toEqual({ ok: true });

    expect(await asB.find(a.id, r.sha256)).toBeNull();
    expect(await asB.list(a.id)).toEqual([]);
    expect(await asB.totalBytes(a.id)).toBe(0);
    await asB.touch(a.id, r.sha256, new Date('2027-01-01T00:00:00Z'));
    await asB.delete(a.id, r.sha256);
    expect(await asA.find(a.id, r.sha256)).toEqual(r);
    expect(await refusal(() => asB.insertWithinQuota(rec(a.id), LIMITS))).toMatch(/no such site/);
    expect((await asA.list(a.id)).length).toBe(1);
  });

  it('keeps the same hash in two sites as two independent rows, each served only from its own site', async () => {
    const a = await makeSite();
    const b = await makeSite();
    const repo = new PrismaSiteModels(prisma);
    const r = rec(a.id);
    await repo.insertWithinQuota(r, LIMITS);
    expect(await repo.find(b.id, r.sha256)).toBeNull();
    expect(await repo.insertWithinQuota({ ...r, siteId: b.id }, LIMITS)).toEqual({ ok: true });
    await repo.delete(a.id, r.sha256);
    expect(await repo.find(a.id, r.sha256)).toBeNull();
    expect(await repo.find(b.id, r.sha256)).not.toBeNull();
  });

  it('counts each site\'s quota alone', async () => {
    const a = await makeSite();
    const b = await makeSite();
    const repo = new PrismaSiteModels(prisma);
    await repo.insertWithinQuota(rec(a.id, { bytes: 3 * MB }), LIMITS);
    expect(await repo.insertWithinQuota(rec(b.id, { bytes: 3 * MB }), { servedBytes: 4 * MB, originalBytes: LIMITS.originalBytes })).toEqual({ ok: true });
  });

  it('refuses an unknown site, and a branch (a branch has no models of its own)', async () => {
    const main = await makeSite();
    const repo = new PrismaSiteModels(prisma);
    expect(await refusal(() => repo.insertWithinQuota(rec(randomUUID()), LIMITS))).toMatch(/no such site/);
    const branches = new SiteBranchRepository(prisma);
    const { branch } = await branches.createBranch(main.scope, main.id, { name: 'Spring', actor: { kind: 'user', id: 'u' } });
    expect(await refusal(() => repo.insertWithinQuota(rec(branch.branchId), LIMITS))).toMatch(/a branch has no models of its own/);
    expect(await prisma.siteModel.count({ where: { siteId: branch.branchId } })).toBe(0);
  });
});

describe('the quota', () => {
  it('lets exactly the room there is through when many uploads run at once', async () => {
    const site = await makeSite();
    const repo = new PrismaSiteModels(prisma);
    const outcomes = await Promise.all(Array.from({ length: 12 }, () => repo.insertWithinQuota(rec(site.id), { servedBytes: 5 * MB, originalBytes: LIMITS.originalBytes })));
    expect(outcomes.filter((o) => o.ok).length).toBe(5);
    expect(outcomes.filter((o) => !o.ok && o.reason === 'quota').length).toBe(7);
    expect(await repo.totalBytes(site.id)).toBe(5 * MB);
  });

  it('counts a shared original once and caps the originals of a site', async () => {
    const site = await makeSite();
    const repo = new PrismaSiteModels(prisma);
    const shared = hex('c');
    expect((await repo.insertWithinQuota(rec(site.id, { originalSha256: shared, originalBytes: 3 * MB }), { servedBytes: LIMITS.servedBytes, originalBytes: 4 * MB })).ok).toBe(true);
    expect((await repo.insertWithinQuota(rec(site.id, { originalSha256: shared, originalBytes: 3 * MB }), { servedBytes: LIMITS.servedBytes, originalBytes: 4 * MB })).ok).toBe(true);
    expect(await repo.insertWithinQuota(rec(site.id, { originalBytes: 3 * MB }), { servedBytes: LIMITS.servedBytes, originalBytes: 4 * MB })).toEqual({ ok: false, reason: 'originals-quota' });
  });

  it('a delete under the same lock makes room for the next upload', async () => {
    const site = await makeSite();
    const repo = new PrismaSiteModels(prisma);
    const limit = { servedBytes: 2 * MB, originalBytes: LIMITS.originalBytes };
    const [a, b] = [rec(site.id), rec(site.id)];
    await repo.insertWithinQuota(a, limit);
    await repo.insertWithinQuota(b, limit);
    expect(await repo.insertWithinQuota(rec(site.id), limit)).toEqual({ ok: false, reason: 'quota' });
    await repo.delete(site.id, a.sha256);
    expect(await repo.insertWithinQuota(rec(site.id), limit)).toEqual({ ok: true });
  });
});

describe('races', () => {
  it('the same model uploaded many times at once is one row, one \"ok\" and the rest \"exists\"', async () => {
    const site = await makeSite();
    const repo = new PrismaSiteModels(prisma);
    const r = rec(site.id);
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => repo.insertWithinQuota(r, LIMITS)));
    expect(outcomes.filter((o) => o.ok).length).toBe(1);
    expect(outcomes.filter((o) => !o.ok && o.reason === 'exists').length).toBe(5);
    expect((await repo.list(site.id)).length).toBe(1);
  });

  it('parallel uploads cannot pass the originals cap either', async () => {
    const site = await makeSite();
    const repo = new PrismaSiteModels(prisma);
    const limit = { servedBytes: LIMITS.servedBytes, originalBytes: 5 * MB };
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => repo.insertWithinQuota(rec(site.id, { originalBytes: 2 * MB }), limit)));
    expect(outcomes.filter((o) => o.ok).length).toBe(2);
    expect(outcomes.filter((o) => !o.ok && o.reason === 'originals-quota').length).toBe(6);
  });

  it('an insert racing the deletion of its site leaves no row behind, whichever wins', async () => {
    for (let i = 0; i < 5; i++) {
      const site = await makeSite();
      const repo = new PrismaSiteModels(prisma);
      await Promise.allSettled([repo.insertWithinQuota(rec(site.id), LIMITS), prisma.site.delete({ where: { id: site.id } })]);
      expect(await prisma.siteModel.count({ where: { siteId: site.id } })).toBe(0);
    }
  });

  it('lets the owning workspace\'s repository touch its own model', async () => {
    const site = await makeSite();
    const own = new PrismaSiteModels(prisma, { workspaceId: site.workspaceId });
    const r = rec(site.id);
    await own.insertWithinQuota(r, LIMITS);
    await own.touch(site.id, r.sha256, new Date('2026-12-24T00:00:00Z'));
    expect((await own.find(site.id, r.sha256))?.lastUsedAt).toEqual(new Date('2026-12-24T00:00:00Z'));
  });
});

describe('failure paths', () => {
  it('leaves no row after a refused insert and releases the site lock for the next one', async () => {
    const site = await makeSite();
    const repo = new PrismaSiteModels(prisma);
    expect(await refusal(() => repo.insertWithinQuota(rec(site.id, { sha256: 'not-a-hash' }), LIMITS))).toMatch(/site_models_sha256_check|check constraint/i);
    expect(await prisma.siteModel.count({ where: { siteId: site.id } })).toBe(0);
    expect(await repo.insertWithinQuota(rec(site.id), LIMITS)).toEqual({ ok: true });
  });
});

describe('the database constraints (the backstop behind the upload checks)', () => {
  const insert = (siteId: string, workspaceId: string, over: Record<string, unknown>) => {
    const base = { id: randomUUID(), site_id: siteId, workspace_id: workspaceId, tenant_group_id: GROUP, sha256: hex('d'), byte_size: 1000, triangles: 10, material_count: 1, node_count: 1, clip_count: 0, texture_count: 0, original_sha256: hex('e'), original_bytes: 1000, uploaded_by: 'u', ...over } as Record<string, unknown>;
    const cols = Object.keys(base);
    const sql = `INSERT INTO public.site_models (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`;
    return prisma.$executeRawUnsafe(sql, ...Object.values(base));
  };

  it('accepts a plain valid row, and refuses each bad one', async () => {
    const site = await makeSite();
    await insert(site.id, site.workspaceId, { sha256: hex('1') });
    const bad: [string, Record<string, unknown>, RegExp][] = [
      ['an upper-case hash', { sha256: hex('A') }, /site_models_sha256_check/],
      ['a short hash', { sha256: 'a'.repeat(63) }, /site_models_sha256_check/],
      ['an original that is not a hash', { original_sha256: 'x' }, /site_models_original_sha256_check/],
      ['an empty file', { byte_size: 0 }, /site_models_byte_size_check/],
      ['a file over 8 MB', { byte_size: 8 * MB + 1 }, /site_models_byte_size_check/],
      ['an original of zero bytes', { original_bytes: 0 }, /site_models_original_bytes_check/],
      ['an original over 50 MB', { original_bytes: 50 * MB + 1 }, /site_models_original_bytes_check/],
      ['too many triangles', { triangles: 500_001 }, /site_models_counts_check/],
      ['too many materials', { material_count: 65 }, /site_models_counts_check/],
      ['too many nodes', { node_count: 1001 }, /site_models_counts_check/],
      ['too many clips', { clip_count: 33 }, /site_models_counts_check/],
      ['too many textures', { texture_count: 17 }, /site_models_counts_check/],
      ['a negative count', { triangles: -1 }, /site_models_counts_check/],
      ['a last use before the creation', { created_at: new Date('2026-11-10T10:00:00Z'), last_used_at: new Date('2026-11-09T10:00:00Z') }, /site_models_dates_check/],
    ];
    for (const [i, [what, over, constraint]] of bad.entries()) {
      // A VALID hash of its own for each case, so only the field under test can be the reason for the refusal.
      const message = await refusal(() => insert(site.id, site.workspaceId, { sha256: (i + 100).toString(16).padStart(64, '0'), ...over }));
      expect(message, what).toMatch(constraint);
    }
  });

  it('refuses names that are not JSON arrays', async () => {
    const site = await makeSite();
    for (const col of ['material_names', 'node_names']) {
      const message = await refusal(() => prisma.$executeRawUnsafe(`INSERT INTO public.site_models (id, site_id, workspace_id, tenant_group_id, sha256, byte_size, triangles, material_count, node_count, clip_count, original_sha256, original_bytes, uploaded_by, ${col}) VALUES ($1, $2, 'w', $3, $4, 10, 1, 1, 1, 0, $5, 10, 'u', '{"a":1}'::jsonb)`, randomUUID(), site.id, GROUP, hex('7'), hex('8')));
      expect(message).toMatch(/site_models_names_check/);
    }
    const tooMany = await refusal(() => prisma.$executeRawUnsafe(`INSERT INTO public.site_models (id, site_id, workspace_id, tenant_group_id, sha256, byte_size, triangles, material_count, node_count, clip_count, original_sha256, original_bytes, uploaded_by, node_names) VALUES ($1, $2, 'w', $3, $4, 10, 1, 1, 1, 0, $5, 10, 'u', (SELECT jsonb_agg(i::text) FROM generate_series(1, 1001) i))`, randomUUID(), site.id, GROUP, hex('9'), hex('8')));
    expect(tooMany).toMatch(/site_models_names_check/);
  });

  it('refuses a model for a site that does not exist and a duplicate (site, hash)', async () => {
    const site = await makeSite();
    expect(await refusal(() => insert(randomUUID(), 'ws', { sha256: hex('f') }))).toMatch(/23503|site_models_site_id_workspace_id_fkey|foreign key/i);
    // A workspace that is not the site's is refused by the composite key, not just by the repository.
    expect(await refusal(() => insert(site.id, 'ws_someone_else', { sha256: hex('3') }))).toMatch(/23503|site_models_site_id_workspace_id_fkey|foreign key/i);
    await insert(site.id, site.workspaceId, { sha256: hex('2') });
    expect(await refusal(() => insert(site.id, site.workspaceId, { sha256: hex('2') }))).toMatch(/23505|unique|duplicate/i);
  });

  it('deletes a site\'s models with the site (cascade) and no one else\'s', async () => {
    const a = await makeSite();
    const b = await makeSite();
    const repo = new PrismaSiteModels(prisma);
    await repo.insertWithinQuota(rec(a.id), LIMITS);
    await repo.insertWithinQuota(rec(b.id), LIMITS);
    await prisma.site.delete({ where: { id: a.id } });
    expect(await prisma.siteModel.count({ where: { siteId: a.id } })).toBe(0);
    expect(await prisma.siteModel.count({ where: { siteId: b.id } })).toBe(1);
  });
});

describe('the migration on a scratch database', () => {
  const dir = path.join(process.cwd(), 'prisma/migrations/20261112200000_site_models');
  const migrationFile = path.join(dir, 'migration.sql');
  const rollbackFile = path.join(dir, 'rollback.sql');
  const migration = readFileSync(migrationFile, 'utf8');
  const admin = () => postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });
  const dbName = `scratch_models_${randomUUID().slice(0, 8)}`;
  let url: string;

  beforeAll(async () => {
    const a = admin();
    await a`CREATE DATABASE ${a(dbName)}`;
    await a.end();
    url = process.env.DATABASE_URL!.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
    const s = postgres(url, { max: 1 });
    // The one thing the migration depends on: the sites table (the real chain's, reduced to its keys).
    await s`CREATE TABLE public.sites (id text PRIMARY KEY, workspace_id text NOT NULL, UNIQUE (id, workspace_id))`;
    await s`CREATE TABLE public.sentinel (id int)`;
    await s`INSERT INTO public.sentinel VALUES (1)`;
    await s`INSERT INTO public.sites VALUES ('s1', 'w')`;
    // Prisma's history table, with this migration's row and a neighbour's.
    await s`CREATE TABLE public._prisma_migrations (migration_name text PRIMARY KEY)`;
    await s`INSERT INTO public._prisma_migrations VALUES ('20261112200000_site_models'), ('20261112180000_site_branch_backstops')`;
    await s.end();
  });
  afterAll(async () => {
    const a = admin();
    await a`DROP DATABASE IF EXISTS ${a(dbName)} WITH (FORCE)`;
    await a.end();
  });

  const tables = async (s: postgres.Sql) => (await s`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`).map((r) => r.table_name as string);

  it('applies, rolls back to exactly what was there, applies again, and refuses a second apply without changing anything', async () => {
    const s = postgres(url, { max: 1, onnotice: () => undefined });
    try {
      expect(await tables(s)).toEqual(['_prisma_migrations', 'sentinel', 'sites']);
      await s.file(migrationFile);
      expect(await tables(s)).toEqual(['_prisma_migrations', 'sentinel', 'site_models', 'sites']);
      await s`INSERT INTO public.site_models (id, site_id, workspace_id, tenant_group_id, sha256, byte_size, triangles, material_count, node_count, clip_count, original_sha256, original_bytes, uploaded_by) VALUES ('m1', 's1', 'w', 't', ${hex('1')}, 10, 1, 1, 1, 0, ${hex('2')}, 10, 'u')`;

      // A second apply fails and the table, its row and everything else are unchanged.
      await expect(s.file(migrationFile)).rejects.toThrow(/already exists/);
      expect((await s`SELECT count(*)::int AS n FROM public.site_models`)[0].n).toBe(1);

      // The rollback script, in one transaction as its header says, removes this migration's table and nothing else.
      await s.begin(async (tx) => { await tx.file(rollbackFile); });
      expect(await tables(s)).toEqual(['_prisma_migrations', 'sentinel', 'sites']);
      // It forgets its own history row (so a redeploy applies it again) and only that one.
      expect((await s`SELECT migration_name FROM public._prisma_migrations`).map((r) => r.migration_name)).toEqual(['20261112180000_site_branch_backstops']);
      expect((await s`SELECT count(*)::int AS n FROM public.sites`)[0].n).toBe(1);
      expect((await s`SELECT count(*)::int AS n FROM public.sentinel`)[0].n).toBe(1);
      // And it is safe to run again.
      await s.file(rollbackFile);

      await s.file(migrationFile);
      expect(await tables(s)).toEqual(['_prisma_migrations', 'sentinel', 'site_models', 'sites']);
      expect((await s`SELECT count(*)::int AS n FROM public.site_models`)[0].n).toBe(0);
    } finally { await s.file(rollbackFile); await s.end(); }
  });

  it('leaves nothing behind when an apply fails part way inside a transaction', async () => {
    const s = postgres(url, { max: 1, onnotice: () => undefined });
    try {
      await expect(s.begin(async (tx) => {
        await tx.file(migrationFile);
        await tx`SELECT 1/0`;
      })).rejects.toThrow(/division by zero/);
      expect(await tables(s)).toEqual(['_prisma_migrations', 'sentinel', 'sites']);
      // A failed apply leaves a clean database that the same migration then applies to.
      await s.file(migrationFile);
      expect(await tables(s)).toContain('site_models');
    } finally { await s.file(rollbackFile); await s.end(); }
  });

  it('is additive: it creates only site_models and touches no other table', async () => {
    const s = postgres(url, { max: 1, onnotice: () => undefined });
    try {
      const before = (await s`SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1, 2`).map((r) => `${r.table_name}.${r.column_name}:${r.data_type}`);
      await s.file(migrationFile);
      const after = (await s`SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name <> 'site_models' ORDER BY 1, 2`).map((r) => `${r.table_name}.${r.column_name}:${r.data_type}`);
      expect(after).toEqual(before);
      // Every statement creates this table or one of its indexes, or alters this table only.
      const statements = migration.replace(/--[^\n]*/g, '').split(';').map((x) => x.trim()).filter(Boolean);
      for (const st of statements) expect(st).toMatch(/^(CREATE TABLE "public"\."site_models"|CREATE (UNIQUE )?INDEX "site_models_[a-z0-9_]+" ON "public"\."site_models"|ALTER TABLE "public"\."site_models" ADD CONSTRAINT)/);
    } finally { await s.file(rollbackFile); await s.end(); }
  });
});

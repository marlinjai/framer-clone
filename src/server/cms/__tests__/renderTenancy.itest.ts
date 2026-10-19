// src/server/cms/__tests__/renderTenancy.itest.ts
//
// The REGRESSION GUARD for MT-13: per-site CMS workspace isolation on the render
// path. This is the bug the spec exists to prevent — N published sites on the
// wildcard each rendering ONLY their own CMS collections, NOT one global
// workspace's content.
//
// CMS isolates by a `workspace_id` COLUMN: `getCmsRepository(workspaceId)` binds
// `listCollections` to `adapter.listTables(workspaceId)`. The render route
// (src/app/(site)/[...slug]/page.tsx) threads `site.workspaceId` (resolved from
// the request Host) into that factory. So the proof is: TWO workspaces, each
// with its OWN collection, and `getCmsRepository(wsX)` sees ONLY wsX's data.
//
// Seeds through the SAME PrismaAdapter `getCmsRepository()` reads, against a REAL
// Postgres (the shared globalSetup container). The `.itest.ts` suffix keeps this
// OUT of the headless `pnpm test` unit gate; it runs ONLY under
// `pnpm test:integration`.

import { PrismaAdapter } from '@marlinjai/data-table-adapter-prisma';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import { getPrismaClient } from '@/server/db';
import { getCmsRepository, getPublishedCmsRepository } from '@/server/cms';
import { CMS_WORKSPACE_ID } from '@/lib/cms/constants';
import { hydrateBindings, type ComponentNode } from '@/lib/renderer/publish/hydrateBindings';

// Two DISTINCT tenant workspaces, each with its own collection content. The
// suffix keeps them clear of the constant single-tenant workspace and of any
// other suite's seeded data.
const WORKSPACE_A = 'mt13-workspace-alpha';
const WORKSPACE_B = 'mt13-workspace-beta';
const COLLECTION_A = 'Alpha Collection';
const COLLECTION_B = 'Beta Collection';

let prisma: PrismaClient;
// Ids of the seeded collections and one row in each, for the by-id reads.
let tableA: string;
let tableB: string;
let rowA: string;
let rowB: string;

beforeAll(async () => {
  // Same DATABASE_URL the globalSetup exported, so the seed writes and the
  // getCmsRepository() reads share one client/pool.
  prisma = getPrismaClient();
  const adapter = new PrismaAdapter({ prisma });

  tableA = (await adapter.createTable({ workspaceId: WORKSPACE_A, name: COLLECTION_A })).id;
  tableB = (await adapter.createTable({ workspaceId: WORKSPACE_B, name: COLLECTION_B })).id;
  rowA = (await adapter.createRow({ tableId: tableA, cells: {} })).id;
  rowB = (await adapter.createRow({ tableId: tableB, cells: {} })).id;
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe('MT-13: per-site CMS workspace isolation on the render path', () => {
  it('renders ONLY workspace A\'s collections for a site resolved to workspace A', async () => {
    const names = (await getCmsRepository(WORKSPACE_A).listCollections()).map(
      (c) => c.name,
    );
    expect(names).toContain(COLLECTION_A);
    // The cross-tenant bleed this spec prevents: B's content must NOT appear.
    expect(names).not.toContain(COLLECTION_B);
  });

  it('renders ONLY workspace B\'s collections for a site resolved to workspace B', async () => {
    const names = (await getCmsRepository(WORKSPACE_B).listCollections()).map(
      (c) => c.name,
    );
    expect(names).toContain(COLLECTION_B);
    expect(names).not.toContain(COLLECTION_A);
  });

  it('does NOT leak either tenant through the module-constant workspace', async () => {
    // The render path must NOT fall back to CMS_WORKSPACE_ID: a site resolved to
    // workspace A or B passes ITS workspace, so the constant workspace sees
    // neither seeded collection. This is the "no module-constant workspace
    // reaches a render-path query" acceptance criterion.
    const names = (await getCmsRepository(CMS_WORKSPACE_ID).listCollections()).map(
      (c) => c.name,
    );
    expect(names).not.toContain(COLLECTION_A);
    expect(names).not.toContain(COLLECTION_B);
  });
});

// The by-id reads behind the /api/cms routes and the SSR hydrator, against the
// real adapter: a repository bound to workspace A must answer workspace B's
// collection and row ids exactly like missing ones.
describe('by-id reads stay inside the bound workspace (real Postgres)', () => {
  it('getCollection: own collection found, foreign collection null', async () => {
    const repoA = getCmsRepository(WORKSPACE_A);
    expect((await repoA.getCollection(tableA))?.name).toBe(COLLECTION_A);
    expect(await repoA.getCollection(tableB)).toBeNull();
  });

  it('listRows: own rows listed, foreign collection an empty page', async () => {
    const repoA = getCmsRepository(WORKSPACE_A);
    expect((await repoA.listRows(tableA)).rows.map((r) => r.id)).toEqual([rowA]);
    expect(await repoA.listRows(tableB)).toEqual({ rows: [], nextCursor: undefined, total: 0 });
  });

  it('getRow: own row found, foreign row null (also via a mismatched collection id)', async () => {
    const repoA = getCmsRepository(WORKSPACE_A);
    expect((await repoA.getRow(tableA, rowA))?.id).toBe(rowA);
    expect(await repoA.getRow(tableB, rowB)).toBeNull();
    // A foreign row smuggled under an own collection id is refused too.
    expect(await repoA.getRow(tableA, rowB)).toBeNull();
  });
});

// The SSR render path (src/app/(site)/[...slug]/page.tsx) hydrates bound CMS
// data through getCmsRepository(site.workspaceId). A published page whose
// collection binding names ANOTHER workspace's collection id must render
// nothing from it.
describe('SSR hydration through the site-bound repository (real Postgres)', () => {
  function collectionNode(collectionId: string): ComponentNode {
    return {
      type: 'div',
      props: { 'data-component-kind': 'collection', emptyContent: 'No items' },
      bindings: { collection: { mode: 'read', expression: collectionId } },
      children: [{ type: 'div', props: { 'data-testid': 'item' } }],
    } as unknown as ComponentNode;
  }

  it('renders one item per own row for a binding to the site\'s own collection', async () => {
    const out = await hydrateBindings(collectionNode(tableA), {}, {
      cmsRepo: getCmsRepository(WORKSPACE_A),
    });
    expect(out.children).toHaveLength(1);
  });

  it('renders the empty state, not the foreign rows, for a binding to another workspace\'s collection', async () => {
    const out = await hydrateBindings(collectionNode(tableB), {}, {
      cmsRepo: getCmsRepository(WORKSPACE_A),
    });
    expect(JSON.stringify(out)).not.toContain(rowB);
    expect(JSON.stringify(out)).toContain('No items');
  });
});

// The PUBLISHED read tier (getPublishedCmsRepository), the one the storefront
// render and the published-site /api/cms plane use, against the real adapter:
// published rows only, never archived ones, pages capped at 100, by-id lookups
// inside the requested table.
describe('published read tier (real Postgres)', () => {
  const WORKSPACE_P = 'mt13-workspace-published';
  let statusTable: string;
  let plainTable: string;
  let publishedRow: string;
  let draftRow: string;
  let unsetRow: string;
  let archivedRow: string;

  beforeAll(async () => {
    const adapter = new PrismaAdapter({ prisma });
    statusTable = (await adapter.createTable({ workspaceId: WORKSPACE_P, name: 'Posts' })).id;
    const status = await adapter.createColumn({ tableId: statusTable, name: 'Status', type: 'select' });
    const draft = await adapter.createSelectOption({ columnId: status.id, name: 'Draft' });
    const published = await adapter.createSelectOption({ columnId: status.id, name: 'Published' });
    publishedRow = (await adapter.createRow({ tableId: statusTable, cells: { [status.id]: published.id } })).id;
    draftRow = (await adapter.createRow({ tableId: statusTable, cells: { [status.id]: draft.id } })).id;
    unsetRow = (await adapter.createRow({ tableId: statusTable, cells: {} })).id;
    archivedRow = (await adapter.createRow({ tableId: statusTable, cells: { [status.id]: published.id } })).id;
    await adapter.archiveRow(archivedRow);

    // A collection with no Status field: every non-archived row is published.
    plainTable = (await adapter.createTable({ workspaceId: WORKSPACE_P, name: 'Plain' })).id;
    await adapter.bulkCreateRows(
      Array.from({ length: 105 }, () => ({ tableId: plainTable, cells: {} })),
    );
  }, 120_000);

  it('lists only Published rows of a collection with a Status field (no draft, unset or archived)', async () => {
    const page = await getPublishedCmsRepository(WORKSPACE_P).listRows(statusTable);
    expect(page.rows.map((r) => r.id)).toEqual([publishedRow]);
    expect(page.total).toBe(1);
  });

  it('the editor repository still sees the drafts (preview of unpublished work)', async () => {
    const ids = (await getCmsRepository(WORKSPACE_P).listRows(statusTable)).rows.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([publishedRow, draftRow, unsetRow]));
  });

  it('getRow: published row found; draft, unset, archived and foreign rows are null', async () => {
    const repo = getPublishedCmsRepository(WORKSPACE_P);
    expect((await repo.getRow(statusTable, publishedRow))?.id).toBe(publishedRow);
    expect(await repo.getRow(statusTable, draftRow)).toBeNull();
    expect(await repo.getRow(statusTable, unsetRow)).toBeNull();
    expect(await repo.getRow(statusTable, archivedRow)).toBeNull();
    // A row of another collection, asked for under this one, is not found
    // (the lookup stays inside the requested table).
    expect(await repo.getRow(plainTable, publishedRow)).toBeNull();
    expect(await repo.getRow(tableA, rowA)).toBeNull();
  });

  it('caps a page at 100 rows whatever limit is asked for', async () => {
    const page = await getPublishedCmsRepository(WORKSPACE_P).listRows(plainTable, { limit: 500 });
    expect(page.rows).toHaveLength(100);
    expect(page.total).toBe(105);
  });

  it('counts only published rows in the collection list', async () => {
    const collections = await getPublishedCmsRepository(WORKSPACE_P).listCollections();
    const posts = collections.find((c) => c.id === statusTable);
    expect(posts?.itemCount).toBe(1);
  });

  it('SSR hydration through the published repository renders only the published row', async () => {
    const node = {
      type: 'div',
      props: { 'data-component-kind': 'collection', emptyContent: 'No items' },
      bindings: { collection: { mode: 'read', expression: statusTable } },
      children: [{ type: 'div', props: { 'data-testid': 'item' } }],
    } as unknown as ComponentNode;
    const out = await hydrateBindings(node, {}, { cmsRepo: getPublishedCmsRepository(WORKSPACE_P) });
    expect(out.children).toHaveLength(1);
  });
});


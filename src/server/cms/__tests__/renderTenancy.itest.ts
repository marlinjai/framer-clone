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
import { getCmsRepository } from '@/server/cms';
import { CMS_WORKSPACE_ID } from '@/lib/cms/constants';

// Two DISTINCT tenant workspaces, each with its own collection content. The
// suffix keeps them clear of the constant single-tenant workspace and of any
// other suite's seeded data.
const WORKSPACE_A = 'mt13-workspace-alpha';
const WORKSPACE_B = 'mt13-workspace-beta';
const COLLECTION_A = 'Alpha Collection';
const COLLECTION_B = 'Beta Collection';

let prisma: PrismaClient;

beforeAll(async () => {
  // Same DATABASE_URL the globalSetup exported, so the seed writes and the
  // getCmsRepository() reads share one client/pool.
  prisma = getPrismaClient();
  const adapter = new PrismaAdapter({ prisma });

  await adapter.createTable({ workspaceId: WORKSPACE_A, name: COLLECTION_A });
  await adapter.createTable({ workspaceId: WORKSPACE_B, name: COLLECTION_B });
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

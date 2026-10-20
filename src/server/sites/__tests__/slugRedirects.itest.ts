// src/server/sites/__tests__/slugRedirects.itest.ts
//
// Page slug rules and old-slug redirects against a REAL Postgres (the
// `20261021000000_site_redirects` migration applied by the integration
// globalSetup): a published site whose page changes its slug keeps the old
// path in `sites.redirects`, the public resolver hands it to the router, an
// invalid slug is refused without touching the stored rows, and a page that
// reclaims the old path removes the redirect.
//
// Runs only under `pnpm test:integration` (Docker).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { getPrismaClient } from '@/server/db';
import { getSiteRepository, InvalidPageSlugError, type TenantScope } from '@/server/sites';
import { resolvePublishedSiteByKey } from '@/server/sites/publicResolver';
import { findRedirectTarget } from '@/lib/pages/redirects';

const SCOPE: TenantScope = {
  workspaceId: `ws_slug_${randomUUID().slice(0, 8)}`,
  tenantGroupId: '018f9c10-0000-7000-8000-0000000051a9',
};
const SITE_ID = randomUUID();

let prisma: PrismaClient;

function project(pages: Record<string, string>) {
  const all: Record<string, unknown> = {};
  for (const [id, slug] of Object.entries(pages)) {
    all[id] = {
      id,
      slug,
      metadata: { title: id },
      appComponentTree: { id: `root-${id}`, type: 'div', componentType: 'host', props: {}, children: [] },
      canvasNodes: {},
    };
  }
  return {
    id: SITE_ID,
    metadata: { title: 'Slug site', description: '', createdAt: 1, updatedAt: 2 },
    pages: all,
  } as never;
}

async function storedRedirects(): Promise<unknown> {
  const row = await prisma.site.findUnique({ where: { id: SITE_ID }, select: { redirects: true } });
  return row?.redirects;
}

beforeAll(() => {
  prisma = getPrismaClient();
});

afterAll(async () => {
  await prisma.site.deleteMany({ where: { id: SITE_ID } });
  await prisma.$disconnect();
});

describe('slug changes on a real database', () => {
  it('starts with no redirects, and records none before the first publish', async () => {
    const repo = getSiteRepository();
    await repo.saveProject(SCOPE, project({ home: '', about: 'about' }));
    expect(await storedRedirects()).toEqual([]);
    await repo.saveProject(SCOPE, project({ home: '', about: 'about-draft' }));
    expect(await storedRedirects()).toEqual([]);
    await repo.saveProject(SCOPE, project({ home: '', about: 'about' }));
  });

  it('keeps the old path once the site has been published, and serves it to the router', async () => {
    const repo = getSiteRepository();
    await repo.publishProject(SCOPE, SITE_ID);
    const { subdomain } = await repo.ensureSiteDomain(SCOPE, SITE_ID);

    await repo.saveProject(SCOPE, project({ home: '', about: 'about-us' }));
    expect(await storedRedirects()).toEqual([
      { from: 'about', pageId: 'about', createdAt: expect.any(String) },
    ]);

    const site = await resolvePublishedSiteByKey({ kind: 'subdomain', value: subdomain }, prisma);
    expect(site).not.toBeNull();
    expect(findRedirectTarget(site!.redirects, site!.pages, ['about'])).toBe('about-us');
  });

  it('refuses an invalid slug and leaves the stored rows alone', async () => {
    const repo = getSiteRepository();
    await expect(repo.saveProject(SCOPE, project({ home: '', about: 'Projects' }))).rejects.toBeInstanceOf(
      InvalidPageSlugError,
    );
    await expect(repo.saveProject(SCOPE, project({ home: '', about: 'projects' }))).rejects.toBeInstanceOf(
      InvalidPageSlugError,
    );
    const rows = await prisma.sitePage.findMany({ where: { siteId: SITE_ID }, select: { pageId: true, slug: true } });
    expect(rows.find((r) => r.pageId === 'about')?.slug).toBe('about-us');
  });

  it('drops the redirect when a page reclaims the old path', async () => {
    const repo = getSiteRepository();
    await repo.saveProject(SCOPE, project({ home: '', about: 'about-us', team: 'about' }));
    expect(await storedRedirects()).toEqual([]);
  });
});

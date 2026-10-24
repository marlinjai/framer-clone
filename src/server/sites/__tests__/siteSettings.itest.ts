// src/server/sites/__tests__/siteSettings.itest.ts
//
// Site settings against a REAL Postgres (the `20261023000000_site_settings`
// migration applied by the integration globalSetup): a site saved before the
// column existed reads as all defaults (language `en`), settings saved through
// the repository load back unchanged, the public resolver hands them to the
// published routes normalized, a later save replaces them as a whole, and the
// primary host follows the platform subdomain until a custom domain is live.
//
// Runs only under `pnpm test:integration` (Docker).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { getPrismaClient } from '@/server/db';
import { getSiteRepository, type TenantScope } from '@/server/sites';
import { resolvePublishedSiteByKey } from '@/server/sites/publicResolver';
import { loadSitePrimaryHost } from '@/server/sites/primaryHost';
import { normalizeSiteSettings } from '@/lib/site/siteSettings';

const SCOPE: TenantScope = {
  workspaceId: `ws_settings_${randomUUID().slice(0, 8)}`,
  tenantGroupId: '018f9c10-0000-7000-8000-0000000051b1',
};
const SITE_ID = randomUUID();

let prisma: PrismaClient;

function project(siteSettings?: object) {
  return {
    id: SITE_ID,
    metadata: { title: 'Settings site', description: '', createdAt: 1, updatedAt: 2 },
    pages: {
      home: {
        id: 'home',
        slug: '',
        metadata: { title: 'Home' },
        appComponentTree: { id: 'root-home', type: 'div', componentType: 'host', props: {}, children: [] },
        canvasNodes: {},
      },
    },
    ...(siteSettings ? { siteSettings } : {}),
  } as never;
}

beforeAll(() => {
  prisma = getPrismaClient();
});

afterAll(async () => {
  await prisma.site.deleteMany({ where: { id: SITE_ID } });
  await prisma.$disconnect();
});

describe('site settings on a real database', () => {
  it('a row without settings reads as the defaults, language en', async () => {
    const repo = getSiteRepository();
    await repo.saveProject(SCOPE, project());
    await prisma.site.update({ where: { id: SITE_ID }, data: { siteSettings: {} } });
    const loaded = await repo.loadProject(SCOPE, SITE_ID);
    expect(loaded.site).toEqual(normalizeSiteSettings({}));
    expect(loaded.site.language).toBe('en');
  });

  it('saves, loads and resolves the settings unchanged', async () => {
    const repo = getSiteRepository();
    const settings = normalizeSiteSettings({
      siteName: 'Bäckerei Müller',
      language: 'de',
      faviconUrl: 'https://cdn.mueller.de/icon.png',
      notFoundPageId: '',
      business: {
        street: 'Hauptstr. 1',
        postalCode: '80331',
        city: 'München',
        country: 'DE',
        openingHours: [{ days: ['Monday'], opens: '07:00', closes: '18:00' }],
        managingDirectors: ['Anna Müller'],
      },
    });
    await repo.saveProject(SCOPE, project(settings), { mustExist: true });
    expect((await repo.loadProject(SCOPE, SITE_ID)).site).toEqual(settings);

    await repo.publishProject(SCOPE, SITE_ID);
    const { subdomain } = await repo.ensureSiteDomain(SCOPE, SITE_ID);
    const site = await resolvePublishedSiteByKey({ kind: 'subdomain', value: subdomain }, prisma);
    expect(site?.siteSettings).toEqual(settings);

    expect(await loadSitePrimaryHost(prisma, SITE_ID, 'ignored.test', 'sites.lumitra.co')).toBe(
      `${subdomain}.sites.lumitra.co`,
    );
  });

  it('a later save replaces the whole object, and a malformed stored value is normalized on read', async () => {
    const repo = getSiteRepository();
    await repo.saveProject(SCOPE, project({ language: 'fr' }), { mustExist: true });
    const loaded = await repo.loadProject(SCOPE, SITE_ID);
    expect(loaded.site.language).toBe('fr');
    expect(loaded.site.siteName).toBe('');

    await prisma.site.update({
      where: { id: SITE_ID },
      data: { siteSettings: { language: 7, business: 'nope', extra: true } },
    });
    expect((await repo.loadProject(SCOPE, SITE_ID)).site).toEqual(normalizeSiteSettings({}));
  });
});

// src/server/sites/__tests__/publishedCopy.itest.ts
//
// The immutable published copy against a REAL Postgres (the
// `20261102200000_site_revisions` migration applied by the integration
// globalSetup). `resolvePublishedSiteByKey` is what a cache miss runs (a restart,
// a deploy, a second replica), so every assertion here is about what a visitor
// gets when nothing is cached. Plan: docs/plans/2026-11-01-immutable-published-copy.md.
//
// Runs only under `pnpm test:integration` (Docker).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { randomBytes, randomUUID } from 'node:crypto';
import { getPrismaClient } from '@/server/db';
import { getSiteRepository, SiteNotFoundError, SiteRevisionNotFoundError, type TenantScope } from '@/server/sites';
import { REVISIONS_KEPT } from '@/server/sites/repository';
import { REVISION_SCHEMA_VERSION } from '@/server/sites/revision';
import { resolvePublishedSiteByKey, type PublishedSite } from '@/server/sites/publicResolver';
import { findRedirectTarget } from '@/lib/pages/redirects';
import { siteInfo } from '@/server/commerce/mail/runtime';

const TENANT_GROUP = '018f9c10-0000-7000-8000-0000000052b1';

let prisma: PrismaClient;
let scope: TenantScope;
let siteId: string;

function page(id: string, slug: string, text: string) {
  return {
    id,
    slug,
    metadata: { title: id },
    appComponentTree: { id: `root-${id}`, type: 'div', componentType: 'host', props: { children: text }, children: [] },
    canvasNodes: {},
  };
}

/** A definition the reader keeps (reusable components contract): `name` tells versions apart. */
function nav(name: string) {
  return {
    id: 'nav',
    name,
    page: {
      id: 'nav-page',
      slug: '',
      metadata: { title: name },
      appComponentTree: { id: 'nav-root', type: 'nav', componentType: 'host', props: { children: name }, children: [] },
      canvasNodes: {},
    },
    inputs: [],
    states: [],
  };
}

/** A project snapshot: `text` marks the content, so a test can tell versions apart. */
function project(text: string, over: { slug?: string; siteSettings?: unknown; lumitra?: unknown; components?: unknown } = {}) {
  const { slug = 'about', ...rest } = over;
  return {
    id: siteId,
    metadata: { title: 'Bakery', description: '', createdAt: 1, updatedAt: 2 },
    pages: { home: page('home', '', text), about: page('about', slug, text) },
    ...rest,
  } as never;
}

function textOf(site: PublishedSite | null, pageId = 'home'): unknown {
  const snapshot = site?.pages.find((p) => p.pageId === pageId)?.snapshot as
    | { appComponentTree?: { props?: { children?: unknown } } }
    | undefined;
  return snapshot?.appComponentTree?.props?.children;
}

async function subdomainOf(): Promise<string> {
  return (await getSiteRepository().ensureSiteDomain(scope, siteId)).subdomain;
}

async function visit(): Promise<PublishedSite | null> {
  return resolvePublishedSiteByKey({ kind: 'subdomain', value: await subdomainOf() }, prisma);
}

async function storedSite() {
  return prisma.site.findUniqueOrThrow({ where: { id: siteId }, select: { publishedRevisionId: true, status: true } });
}

beforeAll(() => {
  prisma = getPrismaClient();
});

beforeEach(async () => {
  siteId = randomUUID();
  scope = { workspaceId: `ws_copy_${randomUUID().slice(0, 8)}`, tenantGroupId: TENANT_GROUP };
  await getSiteRepository().saveProject(scope, project('first draft'));
});

afterAll(async () => {
  await prisma.site.deleteMany({ where: { tenantGroupId: TENANT_GROUP } });
  await prisma.$disconnect();
});

describe('publish freezes what visitors read', () => {
  it('a save after a publish changes the working copy and nothing a visitor reads', async () => {
    const repo = getSiteRepository();
    await expect(repo.publishProject(scope, project('published'))).resolves.toEqual({ revision: 1 });
    await repo.saveProject(scope, project('saved, not published'), { mustExist: true });

    const site = await visit();
    expect(textOf(site)).toBe('published');
    expect(site?.revisionNumber).toBe(1);

    // Draft preview reads the working copy (src/app/projects/[projectId]/preview).
    const draft = await repo.loadProject(scope, siteId);
    expect((draft.pages.get('home')?.appComponentTree.props as { children?: unknown }).children).toBe('saved, not published');
  });

  it('the next publish brings the saved work live', async () => {
    const repo = getSiteRepository();
    await repo.publishProject(scope, project('v1'));
    await repo.saveProject(scope, project('v2'), { mustExist: true });
    await expect(repo.publishProject(scope, project('v2'))).resolves.toEqual({ revision: 2 });
    expect(textOf(await visit())).toBe('v2');
  });

  it('a page added or deleted in a save is not live until published', async () => {
    const repo = getSiteRepository();
    await repo.publishProject(scope, project('v1'));
    const withoutAbout = { ...(project('v1') as object), pages: { home: page('home', '', 'v1') } };
    await repo.saveProject(scope, withoutAbout as never, { mustExist: true });
    expect((await visit())?.pages.map((p) => p.pageId).sort()).toEqual(['about', 'home']);
  });

  it('freezes settings, name and the analytics binding with the pages', async () => {
    const repo = getSiteRepository();
    await repo.publishProject(scope, project('v1', {
      siteSettings: { siteName: 'Live name', language: 'de' },
      lumitra: { enabled: true, projectId: 'p-live', apiKeyRef: 'REF_LIVE' },
    }));
    await repo.saveProject(scope, project('v1', {
      siteSettings: { siteName: 'Draft name', language: 'fr' },
      lumitra: { enabled: false, projectId: 'p-draft', apiKeyRef: 'REF_DRAFT' },
    }), { mustExist: true });
    await repo.renameSite(scope, siteId, 'Renamed in the dashboard');

    const site = await visit();
    expect(site?.siteSettings).toMatchObject({ siteName: 'Live name', language: 'de' });
    expect(site).toMatchObject({ name: 'Bakery', lumitraEnabled: true, analyticsProjectId: 'p-live', apiKeyRef: 'REF_LIVE' });

    // The receipt letter speaks for the live site too.
    await expect(siteInfo(siteId)).resolves.toEqual({ name: 'Live name', language: 'de' });
  });

  it('freezes redirects: a save that drops one leaves it working for visitors', async () => {
    const repo = getSiteRepository();
    await repo.publishProject(scope, project('v1'));
    await subdomainOf();
    await repo.publishProject(scope, project('v2', { slug: 'about-us' }));
    let site = await visit();
    expect(findRedirectTarget(site!.redirects, site!.pages, ['about'])).toBe('/about-us');

    // Moving the page back removes the redirect from the working copy.
    await repo.saveProject(scope, project('v2'), { mustExist: true });
    site = await visit();
    expect(findRedirectTarget(site!.redirects, site!.pages, ['about'])).toBe('/about-us');
  });

  it('holds components beside pages, and rolls them back together (decision 12)', async () => {
    const repo = getSiteRepository();
    await repo.publishProject(scope, project('v1', { components: { nav: nav('Nav one') } }));
    await repo.publishProject(scope, project('v2', { components: { nav: nav('Nav two') } }));
    expect((await visit())?.components.nav?.name).toBe('Nav two');
    await repo.rollbackToRevision(scope, siteId, 1);
    const site = await visit();
    expect(site?.components.nav?.name).toBe('Nav one');
    expect(textOf(site)).toBe('v1');
  });

  it('a publish from a tab older than the column freezes the definitions the column holds', async () => {
    const repo = getSiteRepository();
    await repo.saveProject(scope, project('v1', { components: { nav: nav('Stored nav') } }), { mustExist: true });
    // No `components` key: the column keeps what it holds, and that is what freezes.
    await repo.publishProject(scope, project('v1'));
    expect((await visit())?.components.nav?.name).toBe('Stored nav');

    // A later save of new definitions changes the working copy only.
    await repo.saveProject(scope, project('v2', { components: { nav: nav('Draft nav') } }), { mustExist: true });
    const site = await visit();
    expect(site?.components.nav?.name).toBe('Stored nav');
    expect(textOf(site)).toBe('v1');
    expect((await repo.loadProject(scope, siteId)).components.get('nav')?.name).toBe('Draft nav');
  });

  it('freezes the theme and head a save from an older tab kept', async () => {
    const repo = getSiteRepository();
    const theme = { tokens: [{ id: 'ab12cd34', name: 'Ink', kind: 'color', light: '#111111' }], document: {} };
    const head = [{ kind: 'meta', name: 'author', content: 'Bakery' }];
    await repo.saveProject(scope, project('v1', { siteSettings: { theme, head } }), { mustExist: true });
    // A body with neither key keeps the stored ones, and the revision holds them.
    await repo.publishProject(scope, project('v1', { siteSettings: { siteName: 'Bakery' } }));
    const site = await visit();
    expect(site?.siteSettings.siteName).toBe('Bakery');
    expect(site?.siteSettings.theme.tokens.map((token) => token.id)).toEqual(['ab12cd34']);
    expect(site?.siteSettings.head).toEqual(head);

    // Clearing them in the editor reaches visitors only with the next publish.
    await repo.saveProject(scope, project('v2', { siteSettings: { theme: { tokens: [], document: {} }, head: [] } }), { mustExist: true });
    expect((await visit())?.siteSettings.head).toEqual(head);
  });

  it('a site published with no components key holds none', async () => {
    await getSiteRepository().publishProject(scope, project('v1'));
    expect((await visit())?.components).toEqual({});
  });

  it('serves the same revision on a custom domain, connected before or after the publish', async () => {
    const repo = getSiteRepository();
    await repo.publishProject(scope, project('published'));
    const hostname = `www.${randomUUID().slice(0, 8)}.example`;
    await prisma.siteDomain.create({
      data: {
        siteId,
        workspaceId: scope.workspaceId,
        tenantGroupId: scope.tenantGroupId,
        hostname,
        customHostname: hostname,
        verificationStatus: 'active',
        // Never due for the scheduled re-check, which scans every live domain in the
        // shared database: service.itest.ts counts what it finds and runs in parallel.
        lastCheckedAt: new Date('2100-01-01T00:00:00.000Z'),
      },
    });
    await repo.saveProject(scope, project('saved, not published'), { mustExist: true });

    const site = await resolvePublishedSiteByKey({ kind: 'custom', value: hostname }, prisma);
    expect(textOf(site)).toBe('published');
    await repo.publishProject(scope, project('second'));
    await repo.rollbackToRevision(scope, siteId, 1);
    expect(textOf(await resolvePublishedSiteByKey({ kind: 'custom', value: hostname }, prisma))).toBe('published');
  });

  it('a failed publish changes nothing', async () => {
    const repo = getSiteRepository();
    await repo.publishProject(scope, project('v1'));
    const bad = project('never live', { slug: 'Not A Slug' });
    await expect(repo.publishProject(scope, bad)).rejects.toThrow();
    expect(textOf(await visit())).toBe('v1');
    expect(await prisma.siteRevision.count({ where: { siteId } })).toBe(1);
  });

  it('two publishes at once get distinct numbers and the site points at one of them', async () => {
    const repo = getSiteRepository();
    const results = await Promise.all([
      repo.publishProject(scope, project('left')),
      repo.publishProject(scope, project('right')),
    ]);
    expect(results.map((r) => r.revision).sort()).toEqual([1, 2]);
    const site = await visit();
    expect(site?.revisionNumber).toBe(2);
    expect(['left', 'right']).toContain(textOf(site));
  });

  it('writes the schema version into the document', async () => {
    await getSiteRepository().publishProject(scope, project('v1'));
    const row = await prisma.siteRevision.findFirstOrThrow({ where: { siteId } });
    expect(row.document).toMatchObject({ schemaVersion: REVISION_SCHEMA_VERSION });
  });

  it('publishes of unrelated sites at once do not fail each other', async () => {
    const repo = getSiteRepository();
    const sites: string[] = [];
    for (let i = 0; i < 16; i++) {
      siteId = randomUUID();
      sites.push(siteId);
      await repo.saveProject(scope, project(`site ${i}`));
    }
    const results = await Promise.allSettled(
      sites.map((id, i) => {
        siteId = id;
        return repo.publishProject(scope, project(`published ${i}`));
      }),
    );
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
  });

  it('one save racing two publishes leaves a revision holding one publish, never the save', async () => {
    const repo = getSiteRepository();
    for (let round = 0; round < 5; round++) {
      await Promise.all([
        repo.publishProject(scope, project('left')),
        repo.saveProject(scope, project('the save'), { mustExist: true }),
        repo.publishProject(scope, project('right')),
      ]);
      expect(['left', 'right']).toContain(textOf(await visit()));
    }
  });

  it('a body near the limit publishes, on a site from before revisions too', async () => {
    const repo = getSiteRepository();
    const pages: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) {
      // Hex of random bytes: poorly compressible, 95 KB a page.
      pages[`p${i}`] = page(`p${i}`, i === 0 ? '' : `p${i}`, randomBytes(47_500).toString('hex'));
    }
    const big = { ...(project('big') as object), pages } as never;
    await repo.saveProject(scope, big, { mustExist: true });
    await prisma.site.update({ where: { id: siteId }, data: { status: 'published' } });

    // A baseline and a publish, two full documents in one transaction.
    await expect(repo.publishProject(scope, big)).resolves.toEqual({ revision: 2 });
  }, 60_000);

  it('a save racing a publish never lands in the revision', async () => {
    const repo = getSiteRepository();
    await Promise.all([
      repo.publishProject(scope, project('published')),
      repo.saveProject(scope, project('saved at the same moment'), { mustExist: true }),
    ]);
    expect(textOf(await visit())).toBe('published');
  });

  it('keeps the newest revisions only, and numbers are never reused', async () => {
    const repo = getSiteRepository();
    const total = REVISIONS_KEPT + 2;
    for (let i = 1; i <= total; i++) await repo.publishProject(scope, project(`v${i}`));

    const { revisions, live } = await repo.listRevisions(scope, siteId);
    expect(revisions).toHaveLength(REVISIONS_KEPT);
    expect(revisions[0].number).toBe(total);
    expect(revisions[revisions.length - 1].number).toBe(3);
    expect(live).toBe(total);
    await expect(repo.rollbackToRevision(scope, siteId, 2)).rejects.toBeInstanceOf(SiteRevisionNotFoundError);
  }, 120_000);
});

describe('rollback', () => {
  it('serves the earlier revision on a cache miss and leaves the working copy alone', async () => {
    const repo = getSiteRepository();
    await repo.publishProject(scope, project('good', { siteSettings: { siteName: 'Good' } }));
    await repo.publishProject(scope, project('bad', { siteSettings: { siteName: 'Bad' } }));
    await repo.saveProject(scope, project('work in progress'), { mustExist: true });

    await repo.rollbackToRevision(scope, siteId, 1);
    const site = await visit();
    expect(textOf(site)).toBe('good');
    expect(site?.siteSettings.siteName).toBe('Good');
    expect(site?.revisionNumber).toBe(1);

    const draft = await repo.loadProject(scope, siteId);
    expect((draft.pages.get('home')?.appComponentTree.props as { children?: unknown }).children).toBe('work in progress');
  });

  it('can go forward again, and a later publish gets the next number', async () => {
    const repo = getSiteRepository();
    await repo.publishProject(scope, project('v1'));
    await repo.publishProject(scope, project('v2'));
    await repo.rollbackToRevision(scope, siteId, 1);
    await repo.rollbackToRevision(scope, siteId, 2);
    expect(textOf(await visit())).toBe('v2');

    await repo.rollbackToRevision(scope, siteId, 1);
    await expect(repo.publishProject(scope, project('v3'))).resolves.toEqual({ revision: 3 });
    expect(textOf(await visit())).toBe('v3');
  });

  it('brings an unpublished site back online with that revision', async () => {
    const repo = getSiteRepository();
    await repo.publishProject(scope, project('v1'));
    await repo.unpublishProject(scope, siteId);
    expect(await visit()).toBeNull();

    await repo.rollbackToRevision(scope, siteId, 1);
    expect(textOf(await visit())).toBe('v1');
    expect((await storedSite()).status).toBe('published');
  });

  it('checks the frozen version, not the draft', async () => {
    const repo = getSiteRepository();
    await repo.publishProject(scope, project('v1', { siteSettings: { business: { legalName: 'Bakery GmbH' } } }));
    await repo.saveProject(scope, project('v2'), { mustExist: true });
    await expect(repo.checkRevision(scope, siteId, 1)).resolves.toMatchObject({ missingImpressum: true });
    await expect(repo.checkRevision(scope, siteId, 9)).rejects.toBeInstanceOf(SiteRevisionNotFoundError);
    const foreign = { workspaceId: `ws_foreign_${randomUUID().slice(0, 8)}`, tenantGroupId: TENANT_GROUP };
    await expect(repo.checkRevision(foreign, siteId, 1)).rejects.toBeInstanceOf(SiteNotFoundError);
  });

  it('refuses a number this site does not have, changing nothing', async () => {
    const repo = getSiteRepository();
    await repo.publishProject(scope, project('v1'));
    await expect(repo.rollbackToRevision(scope, siteId, 9)).rejects.toBeInstanceOf(SiteRevisionNotFoundError);
    expect(textOf(await visit())).toBe('v1');
  });

  it("refuses a revision of another site, and another workspace's site", async () => {
    const repo = getSiteRepository();
    await repo.publishProject(scope, project('mine'));
    const mine = { scope, siteId };

    // A second site with a version 2, which the first does not have.
    siteId = randomUUID();
    await repo.saveProject(scope, project('other'));
    await repo.publishProject(scope, project('other 1'));
    await repo.publishProject(scope, project('other 2'));
    await expect(repo.rollbackToRevision(mine.scope, mine.siteId, 2)).rejects.toBeInstanceOf(SiteRevisionNotFoundError);

    const foreign = { workspaceId: `ws_foreign_${randomUUID().slice(0, 8)}`, tenantGroupId: TENANT_GROUP };
    await expect(repo.rollbackToRevision(foreign, siteId, 1)).rejects.toBeInstanceOf(SiteNotFoundError);
    await expect(repo.listRevisions(foreign, siteId)).rejects.toBeInstanceOf(SiteNotFoundError);
    expect(textOf(await visit())).toBe('other 2');
  });
});

describe('a site published before revisions existed', () => {
  /** A published site as production holds it today: rows, a status, no pointer. */
  async function legacySite(text: string) {
    await prisma.sitePage.deleteMany({ where: { siteId } });
    await prisma.sitePage.create({
      data: {
        siteId,
        workspaceId: scope.workspaceId,
        tenantGroupId: scope.tenantGroupId,
        pageId: 'home',
        slug: '',
        snapshot: page('home', '', text),
      },
    });
    await prisma.site.update({
      where: { id: siteId },
      data: { status: 'published', siteSettings: { siteName: 'Legacy' } },
    });
    await subdomainOf();
  }

  it('keeps serving its current content with no revision and no write', async () => {
    await legacySite('legacy content');
    const site = await visit();
    expect(textOf(site)).toBe('legacy content');
    expect(site?.revisionNumber).toBeNull();
    expect(site?.siteSettings.siteName).toBe('Legacy');
    expect(await prisma.siteRevision.count({ where: { siteId } })).toBe(0);
  });

  it('serves its components column, and its first save freezes that as the baseline', async () => {
    const repo = getSiteRepository();
    await legacySite('legacy content');
    await prisma.site.update({ where: { id: siteId }, data: { components: { nav: nav('Legacy nav') } } });
    expect((await visit())?.components.nav?.name).toBe('Legacy nav');

    await repo.saveProject(scope, project('first edit', { components: { nav: nav('Edited nav') } }), { mustExist: true });
    const site = await visit();
    expect(site?.revisionNumber).toBe(1);
    expect(site?.components.nav?.name).toBe('Legacy nav');
    expect(textOf(site)).toBe('legacy content');
  });

  it('freezes what it serves at the first save: visitors keep it, the save is kept as the working copy', async () => {
    const repo = getSiteRepository();
    await legacySite('legacy content');
    await repo.saveProject(scope, project('first edit', { siteSettings: { siteName: 'Edited' } }), { mustExist: true });

    const site = await visit();
    expect(textOf(site)).toBe('legacy content');
    expect(site?.siteSettings.siteName).toBe('Legacy');
    expect(site?.revisionNumber).toBe(1);

    const list = await repo.listRevisions(scope, siteId);
    expect(list.live).toBe(1);
    expect(list.revisions).toMatchObject([{ number: 1, kind: 'baseline', publishedBy: null }]);

    // Only once: the next save freezes nothing.
    await repo.saveProject(scope, project('second edit'), { mustExist: true });
    expect(await prisma.siteRevision.count({ where: { siteId } })).toBe(1);
    expect(textOf(await visit())).toBe('legacy content');
  });

  it('its first publish keeps the old content as a version to go back to', async () => {
    const repo = getSiteRepository();
    await legacySite('legacy content');
    await expect(repo.publishProject(scope, project('new', { }), { publishedBy: 'user-1' })).resolves.toEqual({ revision: 2 });
    expect(textOf(await visit())).toBe('new');
    expect((await repo.listRevisions(scope, siteId)).revisions).toMatchObject([
      { number: 2, kind: 'publish', publishedBy: 'user-1' },
      { number: 1, kind: 'baseline' },
    ]);

    await repo.rollbackToRevision(scope, siteId, 1);
    expect(textOf(await visit())).toBe('legacy content');
  });

  it('a read straddling the first save still gets a whole site, from one snapshot', async () => {
    await legacySite('legacy content');
    const subdomain = await subdomainOf();

    // Hold site_pages, so the visitor's read stops between its sites statement
    // and its pages statement, and commit the first-save pointer change there.
    let release = () => {};
    const released = new Promise<void>((resolve) => { release = resolve; });
    let locked = () => {};
    const isLocked = new Promise<void>((resolve) => { locked = resolve; });
    const holder = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`LOCK TABLE public.site_pages IN ACCESS EXCLUSIVE MODE`;
      locked();
      await released;
    }, { timeout: 30_000 });
    await isLocked;

    const reading = resolvePublishedSiteByKey({ kind: 'subdomain', value: subdomain }, prisma);
    for (;;) {
      const waiting = await prisma.$queryRaw<unknown[]>`
        SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%site_pages%' AND query NOT ILIKE '%pg_stat_activity%'`;
      if (waiting.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const revision = await prisma.siteRevision.create({
      data: { siteId, workspaceId: scope.workspaceId, tenantGroupId: scope.tenantGroupId, number: 1, kind: 'baseline', document: { schemaVersion: REVISION_SCHEMA_VERSION, pages: [] } },
    });
    await prisma.site.update({ where: { id: siteId }, data: { publishedRevisionId: revision.id } });
    release();
    await holder;

    const site = await reading;
    expect(textOf(site)).toBe('legacy content');
    expect(site?.revisionNumber).toBeNull();
  });

  it('a pointer with no revision behind it fails loudly, never serving the working copy', async () => {
    await legacySite('legacy content');
    const subdomain = await subdomainOf();
    const tx = {
      site: {
        findFirst: async () => ({
          ...(await prisma.site.findFirstOrThrow({ where: { id: siteId } })),
          publishedRevisionId: 'gone',
          publishedRevision: null,
          pages: [],
        }),
      },
    };
    const fake = Object.create(prisma, { $transaction: { value: (run: (t: unknown) => unknown) => run(tx) } });
    await expect(resolvePublishedSiteByKey({ kind: 'subdomain', value: subdomain }, fake)).rejects.toThrow(
      'points at a revision that does not exist',
    );
  });

  it('lists no versions until then', async () => {
    await legacySite('legacy content');
    await expect(getSiteRepository().listRevisions(scope, siteId)).resolves.toEqual({
      status: 'published',
      live: null,
      revisions: [],
    });
  });

  it('a site saved as a draft is never frozen by a save', async () => {
    await getSiteRepository().saveProject(scope, project('draft'), { mustExist: true });
    expect(await prisma.siteRevision.count({ where: { siteId } })).toBe(0);
  });
});

describe('unpublish and delete', () => {
  it('unpublish takes the site offline; a republish freezes the next version', async () => {
    const repo = getSiteRepository();
    await repo.publishProject(scope, project('v1'));
    await repo.unpublishProject(scope, siteId);
    expect(await visit()).toBeNull();
    await expect(repo.publishProject(scope, project('v2'))).resolves.toEqual({ revision: 2 });
    expect(textOf(await visit())).toBe('v2');
  });

  it('a live revision cannot be deleted on its own: the site never falls through to its drafts', async () => {
    const repo = getSiteRepository();
    await repo.publishProject(scope, project('v1'));
    const { publishedRevisionId } = await storedSite();
    await expect(prisma.siteRevision.delete({ where: { id: publishedRevisionId! } })).rejects.toThrow();
    expect(textOf(await visit())).toBe('v1');
  });

  it('deleting the site removes its revisions', async () => {
    const repo = getSiteRepository();
    await repo.publishProject(scope, project('v1'));
    await repo.deleteSite(scope, siteId, { confirmName: 'Bakery' });
    expect(await prisma.siteRevision.count({ where: { siteId } })).toBe(0);
  });
});

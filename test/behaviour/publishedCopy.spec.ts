// The immutable published copy (docs/plans/2026-11-01-immutable-published-copy.md) as a
// visitor gets it: a real build, the real `(site)/[...slug]` route, real Chromium and
// WebKit, a real Postgres. Every site here is new, so its first visit is a cache miss and
// reads the database, which is exactly what a restart, a deploy or a second replica does.
// Before the published copy, each "draft" below was what that visitor got.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, webkit, type Browser, type BrowserType } from 'playwright';
import { randomUUID } from 'node:crypto';
import { getSnapshot } from 'mobx-state-tree';
import { DEFAULT_VIEWPORTS } from '@/lib/canvas/defaultViewports';
import { getPrismaClient } from '@/server/db';
import { getSiteRepository, type TenantScope } from '@/server/sites';

const SCOPE: TenantScope = {
  workspaceId: `ws_copy_${randomUUID().slice(0, 8)}`,
  tenantGroupId: '018f9c10-0000-7000-8000-0000000051c3',
};

const frames = Object.fromEntries(
  DEFAULT_VIEWPORTS.map((v) => [
    v.label.toLowerCase(),
    { id: v.label.toLowerCase(), type: 'div', componentType: 'host', canvasNodeType: 'viewport', breakpointId: v.label.toLowerCase(), breakpointMinWidth: v.minWidth, label: v.label, viewportWidth: v.width, viewportHeight: v.height, props: {}, children: [] },
  ]),
);

/** A definition whose text says which version it is. */
const banner = (text: string) => ({
  id: 'banner',
  name: 'Banner',
  page: {
    id: 'banner-page',
    slug: '',
    metadata: { title: 'Banner' },
    appComponentTree: {
      id: 'b-root', type: 'div', componentType: 'host', props: {},
      children: [{ id: 'b-text', type: 'p', componentType: 'host', props: { 'data-t': 'banner', children: text }, children: [] }],
    },
    canvasNodes: {},
  },
  inputs: [],
  states: [],
});

/** One page saying `text`, placing the banner, with the banner's own text `bannerText`. */
function project(siteId: string, text: string, bannerText: string) {
  return {
    id: siteId,
    metadata: { title: 'Copy', description: '', createdAt: 1, updatedAt: 2 },
    pages: {
      home: {
        id: 'home',
        slug: '',
        metadata: { title: 'Home' },
        appComponentTree: {
          id: 'root-home', type: 'div', componentType: 'host', props: {},
          children: [
            { id: 'text', type: 'h1', componentType: 'host', props: { 'data-t': 'text', children: text }, children: [] },
            { id: 'place', type: '#component', componentType: 'host', props: { component: 'banner', inputs: {} }, children: [] },
          ],
        },
        canvasNodes: frames,
      },
    },
    components: { banner: banner(bannerText) },
  } as never;
}

async function origin(siteId: string): Promise<string> {
  const { subdomain } = await getSiteRepository().ensureSiteDomain(SCOPE, siteId);
  return `http://${subdomain}.sites.localhost:${process.env.BEHAVIOUR_PORT}`;
}

const ENGINES: [string, BrowserType][] = [['chromium', chromium], ['webkit', webkit]];

afterAll(async () => {
  await getPrismaClient().$disconnect();
});

describe.each(ENGINES)('in %s', (_name, engine) => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await engine.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });

  /** What a visitor reads on the home page: the page's text and the banner's. */
  async function read(address: string): Promise<{ text: string | null; banner: string | null }> {
    const page = await browser.newPage();
    try {
      const response = await page.goto(`${address}/`);
      expect(response?.status()).toBe(200);
      return {
        text: await page.locator('[data-t="text"]').first().textContent(),
        banner: await page.locator('[data-t="banner"]').first().textContent(),
      };
    } finally {
      await page.close();
    }
  }

  it('a save after a publish reaches the editor and not the visitor', async () => {
    const repo = getSiteRepository();
    const siteId = randomUUID();
    await repo.saveProject(SCOPE, project(siteId, 'published', 'published banner'));
    await repo.publishProject(SCOPE, project(siteId, 'published', 'published banner'));
    await repo.saveProject(SCOPE, project(siteId, 'draft', 'draft banner'), { mustExist: true });

    expect(await read(await origin(siteId))).toEqual({ text: 'published', banner: 'published banner' });
    // The editor's working copy holds the save.
    expect(JSON.stringify(getSnapshot(await repo.loadProject(SCOPE, siteId)))).toContain('draft banner');
  });

  it('the next publish brings the saved work live', async () => {
    const repo = getSiteRepository();
    const siteId = randomUUID();
    await repo.saveProject(SCOPE, project(siteId, 'v1', 'banner v1'));
    await repo.publishProject(SCOPE, project(siteId, 'v1', 'banner v1'));
    await repo.saveProject(SCOPE, project(siteId, 'v2', 'banner v2'), { mustExist: true });
    await repo.publishProject(SCOPE, project(siteId, 'v2', 'banner v2'));

    expect(await read(await origin(siteId))).toEqual({ text: 'v2', banner: 'banner v2' });
  });

  it('a rollback serves the earlier version, pages and components together', async () => {
    const repo = getSiteRepository();
    const siteId = randomUUID();
    await repo.saveProject(SCOPE, project(siteId, 'v1', 'banner v1'));
    await repo.publishProject(SCOPE, project(siteId, 'v1', 'banner v1'));
    await repo.publishProject(SCOPE, project(siteId, 'v2', 'banner v2'));
    await repo.rollbackToRevision(SCOPE, siteId, 1);

    expect(await read(await origin(siteId))).toEqual({ text: 'v1', banner: 'banner v1' });
  });

  it('a site from before revisions keeps its content through its first save', async () => {
    const repo = getSiteRepository();
    const prisma = getPrismaClient();
    const siteId = randomUUID();
    // As production holds such a site: published rows and column, no revision.
    await repo.saveProject(SCOPE, project(siteId, 'legacy', 'legacy banner'));
    await prisma.site.update({ where: { id: siteId }, data: { status: 'published' } });
    await repo.saveProject(SCOPE, project(siteId, 'first edit', 'edited banner'), { mustExist: true });

    expect(await read(await origin(siteId))).toEqual({ text: 'legacy', banner: 'legacy banner' });
    expect(await prisma.siteRevision.count({ where: { siteId, kind: 'baseline' } })).toBe(1);
  });
});

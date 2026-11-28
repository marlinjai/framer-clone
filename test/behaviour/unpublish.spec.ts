// Unpublish in the interface, in real Chromium and WebKit with a real pointer: the real Published versions
// dialog on the real store, and the real dashboard card. The editor routes need a signed-in session, so the
// browser's two requests are answered here by the repository calls those routes make, on the harness's
// real Postgres. The route's guard and cache clearing are proven in its own tests
// (src/app/api/projects/__tests__/unpublish-route.test.ts). What a visitor then gets is read from the real
// build's `(site)/[...slug]` route on an address nobody visited before, so nothing is cached for it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, webkit, type Browser, type BrowserType, type Page, type Route } from 'playwright';
import { randomUUID } from 'node:crypto';
import { DEFAULT_VIEWPORTS } from '@/lib/canvas/defaultViewports';
import { getPrismaClient } from '@/server/db';
import { getSiteRepository, type TenantScope } from '@/server/sites';
import { getSnapshot } from 'mobx-state-tree';
import { bundleEditor, openBundle } from '../score/lib/canvasBundle';

const SCOPE: TenantScope = {
  workspaceId: `ws_unpublish_${randomUUID().slice(0, 8)}`,
  tenantGroupId: '018f9c10-0000-7000-8000-0000000051c9',
};
const ENGINES: [string, BrowserType][] = [['chromium', chromium], ['webkit', webkit]];
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

const frames = Object.fromEntries(
  DEFAULT_VIEWPORTS.map((v) => [
    v.label.toLowerCase(),
    { id: v.label.toLowerCase(), type: 'div', componentType: 'host', canvasNodeType: 'viewport', breakpointId: v.label.toLowerCase(), breakpointMinWidth: v.minWidth, label: v.label, viewportWidth: v.width, viewportHeight: v.height, props: {}, children: [] },
  ]),
);

/** A published site with one version, and the address nobody has visited. */
async function publishedSite(siteId: string): Promise<string> {
  const repo = getSiteRepository();
  const project = {
    id: siteId,
    metadata: { title: 'Unpublish', description: '', createdAt: 1, updatedAt: 2 },
    pages: { home: { id: 'home', slug: '', metadata: { title: 'Home' }, appComponentTree: { id: 'root-home', type: 'div', componentType: 'host', props: {}, children: [] }, canvasNodes: frames } },
  } as never;
  const saved = await repo.saveProject(SCOPE, project);
  await repo.publishProject(SCOPE, project, { expectedVersion: saved.version });
  const { subdomain } = await repo.ensureSiteDomain(SCOPE, siteId);
  return `http://${subdomain}.sites.localhost:${process.env.BEHAVIOUR_PORT}/`;
}

const statusOf = async (siteId: string) => (await getPrismaClient().site.findUniqueOrThrow({ where: { id: siteId } })).status;

/** Answers the unpublish request as the route does; `failures` answers come first as an unfinished one. */
async function answerUnpublish(page: Page, failures = 0): Promise<string[]> {
  const asked: string[] = [];
  await page.route('**/api/projects/unpublish', async (route) => {
    const { siteId } = route.request().postDataJSON() as { siteId: string };
    asked.push(siteId);
    await getSiteRepository().unpublishProject(SCOPE, siteId);
    return asked.length <= failures
      ? json(route, { error: { code: 'unpublish_failed', message: 'cache' } }, 500)
      : json(route, { siteId, status: 'draft' });
  });
  return asked;
}

let dialogBundle: string;
let cardBundle: string;
beforeAll(async () => {
  dialogBundle = await bundleEditor('test/behaviour/unpublish/dialogEntry.tsx', 'unpublish-dialog-bundle');
  cardBundle = await bundleEditor('test/behaviour/unpublish/cardEntry.tsx', 'unpublish-card-bundle');
}, 180_000);
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

  it('the editor dialog takes the site offline after an unfinished attempt, and brings it back', async () => {
    const siteId = randomUUID();
    const address = await publishedSite(siteId);
    const snapshot = getSnapshot(await getSiteRepository().loadProject(SCOPE, siteId));
    let asked: string[] = [];
    const { page, crashes } = await openBundle(browser, dialogBundle, {}, async (p) => {
      await p.addInitScript((project) => { (window as unknown as { __PROJECT__: unknown }).__PROJECT__ = project; }, snapshot as never);
      await p.route(`**/api/projects/${siteId}/revisions`, async (route) => {
        if (route.request().method() === 'POST') {
          const { number } = route.request().postDataJSON() as { number: number };
          await getSiteRepository().rollbackToRevision(SCOPE, siteId, number);
          return json(route, { siteId, status: 'published', live: number });
        }
        return json(route, await getSiteRepository().listRevisions(SCOPE, siteId));
      });
      await p.route(`**/api/projects/${siteId}/revisions/*`, (route) => json(route, { number: 1, check: { missingImpressum: false, placeholders: [], components: [] } }));
      asked = await answerUnpublish(p, 1);
    });
    try {
      page.setDefaultTimeout(8000);
      await page.getByRole('button', { name: 'Published versions' }).click();
      await page.getByRole('button', { name: 'Unpublish site' }).click();
      await page.getByRole('group', { name: 'Confirm unpublish' }).getByRole('button', { name: 'Cancel' }).click();
      expect(asked).toEqual([]);
      expect(await statusOf(siteId)).toBe('published');

      await page.getByRole('button', { name: 'Unpublish site' }).click();
      await page.getByRole('button', { name: 'Take offline' }).click();
      await page.getByText('This site is offline.', { exact: false }).waitFor();
      await page.getByRole('button', { name: 'Try unpublishing again' }).click();
      await page.getByRole('button', { name: 'Still visible to visitors? Unpublish again' }).waitFor();

      // Both requests name the open project.
      expect(asked).toEqual([siteId, siteId]);
      expect(await statusOf(siteId)).toBe('draft');
      expect((await fetchAsVisitor(browser, address))).toBe(404);

      await page.getByRole('button', { name: 'Make live' }).click();
      await page.getByRole('button', { name: 'Put back online' }).click();
      await page.getByRole('button', { name: 'Unpublish site' }).waitFor();
      expect(await statusOf(siteId)).toBe('published');
      expect(crashes).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('the dashboard card takes the site offline, and the announcement outlives the refresh', async () => {
    const siteId = randomUUID();
    const address = await publishedSite(siteId);
    let asked: string[] = [];
    const { page, crashes } = await openBundle(browser, cardBundle, {}, async (p) => {
      await p.addInitScript((props) => { (window as unknown as { __CARD_PROPS__: unknown }).__CARD_PROPS__ = props; }, {
        siteId, name: 'Bakery', status: 'published', updatedLabel: 'today', liveHost: new URL(address).host,
      });
      await p.route('**/card-state', async (route) => json(route, { status: await statusOf(siteId) }));
      asked = await answerUnpublish(p);
    });
    try {
      page.setDefaultTimeout(8000);
      await page.getByRole('button', { name: 'More actions for Bakery' }).click();
      await page.getByRole('menuitem', { name: 'Unpublish' }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Unpublish site' }).click();
      await page.getByRole('alertdialog').waitFor({ state: 'detached' });
      await page.getByText('Draft').waitFor();

      expect(await page.locator('#projects-status').textContent()).toBe('The site Bakery is offline.');
      expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('More actions for Bakery');
      await page.getByRole('button', { name: 'More actions for Bakery' }).click();
      await page.getByRole('menuitem', { name: 'Rename' }).waitFor();
      expect(await page.getByRole('menuitem', { name: 'Unpublish' }).count()).toBe(0);
      expect(asked).toEqual([siteId]);
      expect(await fetchAsVisitor(browser, address)).toBe(404);
      expect(crashes).toEqual([]);
    } finally {
      await page.close();
    }
  });
});

async function fetchAsVisitor(browser: Browser, address: string): Promise<number | undefined> {
  const page = await browser.newPage();
  try {
    return (await page.goto(address))?.status();
  } finally {
    await page.close();
  }
}
// ci-replay touch

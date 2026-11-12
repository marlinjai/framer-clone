// The public preview link of a site branch (docs/plans/2026-11-10-site-branches.md, slice S8 and decision 94) as
// the person who was sent the link gets it: a real build, the real middleware and `(site)/[...slug]` route on a
// real `preview-<token>` host, real Chromium and WebKit, a real Postgres. The branch and its link are made
// through the real repository and the real link service.
//
// What only a browser can settle, and what the whole-feature review asked for:
//   - the band that says "this is a preview" never lies over the page's own header, which here is fixed to the
//     top as headers very often are, at a desktop and at a phone width;
//   - it never covers the end of the page either, however its text wraps;
//   - it is German on a German site;
//   - a revoked link shows nothing on the next request.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, webkit, type Browser, type BrowserType, type Page } from 'playwright';
import { randomUUID } from 'node:crypto';
import { DEFAULT_VIEWPORTS } from '@/lib/canvas/defaultViewports';
import { getPrismaClient } from '@/server/db';
import { getSiteRepository, type TenantScope } from '@/server/sites';
import { getSiteBranchRepository } from '@/server/sites/branches/repository';
import { getSiteBranchPreviewLinks } from '@/server/sites/branches/previewLinks';

const SCOPE: TenantScope = {
  workspaceId: `ws_preview_${randomUUID().slice(0, 8)}`,
  tenantGroupId: '018f9c10-0000-7000-8000-0000000051c4',
};
const COMPANY = 'company-behaviour-preview';
const USER = { kind: 'user' as const, id: 'user-behaviour' };
const ENGINES: [string, BrowserType][] = [['chromium', chromium], ['webkit', webkit]];
const SIZES = [
  { name: 'a desktop window', width: 1280, height: 720 },
  { name: 'a phone', width: 390, height: 780 },
];

const frames = Object.fromEntries(
  DEFAULT_VIEWPORTS.map((v) => [
    v.label.toLowerCase(),
    { id: v.label.toLowerCase(), type: 'div', componentType: 'host', canvasNodeType: 'viewport', breakpointId: v.label.toLowerCase(), breakpointMinWidth: v.minWidth, label: v.label, viewportWidth: v.width, viewportHeight: v.height, props: {}, children: [] },
  ]),
);

const el = (id: string, type: string, props: Record<string, unknown>, children: unknown[] = []) => ({
  id, type, componentType: 'host', props: { 'data-t': id, ...props }, children,
});

/** A long page whose header is fixed to the top of the window, as a site's own navigation very often is. */
function project(siteId: string, heading: string, language: string) {
  return {
    id: siteId,
    metadata: { title: 'Bakery', description: '', createdAt: 1, updatedAt: 2 },
    siteSettings: { language },
    pages: {
      home: {
        id: 'home',
        slug: '',
        metadata: { title: 'Home' },
        appComponentTree: el('root-home', 'div', {}, [
          el('site-header', 'header', {
            children: 'Bakery',
            style: { position: 'fixed', top: '0px', left: '0px', right: '0px', height: '64px', background: '#ffffff', zIndex: '50' },
          }),
          el('heading', 'h1', { children: heading, style: { marginTop: '80px' } }),
          el('filler', 'div', { style: { height: '2400px' } }),
          el('last', 'p', { children: 'The end of the page', style: { margin: '0px' } }),
        ]),
        canvasNodes: frames,
      },
    },
  } as never;
}

/** A site, a branch of it that says `heading`, and the branch's public link: the link's origin on this server. */
async function previewOf(heading: string, language = 'en'): Promise<{ origin: string; siteId: string; branchId: string }> {
  const repo = getSiteRepository();
  const siteId = randomUUID();
  await repo.saveProject(SCOPE, project(siteId, 'Main heading', language), { companyId: COMPANY });
  const { branch } = await getSiteBranchRepository().createBranch(SCOPE, siteId, { name: 'Summer sale', actor: USER });
  await repo.saveProject(SCOPE, project(branch.branchId, heading, language), { mustExist: true });
  const link = await getSiteBranchPreviewLinks().create(SCOPE, siteId, branch.branchId, USER, 1);
  return { origin: `http://${new URL(link.url).host}:${process.env.BEHAVIOUR_PORT}`, siteId, branchId: branch.branchId };
}

interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
  height: number;
}

/** Where the band, the page's header and the page's last line are in the window right now. */
function boxes(page: Page) {
  return page.evaluate(() => {
    const box = (selector: string) => {
      const r = document.querySelector(selector)!.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height };
    };
    const header = document.querySelector('[data-t="site-header"]')!.getBoundingClientRect();
    const atHeader = document.elementFromPoint(header.left + header.width / 2, header.top + header.height / 2);
    return {
      band: box('[data-fc-preview-band]'),
      space: box('[data-fc-preview-band-space]'),
      header: box('[data-t="site-header"]'),
      last: box('[data-t="last"]'),
      window: { width: document.documentElement.clientWidth, height: window.innerHeight },
      /** What a click in the middle of the header would land on. */
      headerOnTop: atHeader?.closest('[data-t="site-header"]') !== null,
      bandText: document.querySelector('[data-fc-preview-band]')!.textContent ?? '',
    };
  }) as Promise<{ band: Box; space: Box; header: Box; last: Box; window: { width: number; height: number }; headerOnTop: boolean; bandText: string }>;
}

beforeAll(() => {
  // As the server under test is started (setup.ts): the link service makes the address from it.
  process.env.PUBLIC_SITE_BASE_HOST = 'sites.localhost';
  process.env.SITE_BRANCHES_COMPANIES = '*';
});

afterAll(async () => {
  await getPrismaClient().$disconnect();
});

describe.each(ENGINES)('a branch\'s public preview link in %s', (_name, engine) => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await engine.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it.each(SIZES)('on $name the band sits at the bottom edge, clear of the page\'s fixed header and of the end of the page', async ({ width, height }) => {
    const { origin } = await previewOf('Branch heading');
    const page = await browser.newPage({ viewport: { width, height } });
    try {
      const response = await page.goto(`${origin}/`);
      expect(response?.status()).toBe(200);
      expect(response?.headers()['x-robots-tag']).toContain('noindex');
      expect(response?.headers()['cache-control']).toContain('no-store');
      // The branch, not the site it was made from.
      expect(await page.locator('[data-t="heading"]').first().textContent()).toBe('Branch heading');

      const top = await boxes(page);
      expect(top.bandText).toContain('Preview of the branch “Summer sale”');
      expect(top.bandText).toContain('This is not the live site');
      // The band: the full width of the window, at its bottom edge.
      expect(top.band.left).toBeCloseTo(0, 0);
      expect(top.band.right).toBeCloseTo(top.window.width, 0);
      expect(top.band.bottom).toBeCloseTo(top.window.height, 0);
      // The page's own header: where the page put it, whole, and on top there.
      expect(top.header.top).toBeCloseTo(0, 0);
      expect(top.header.height).toBeCloseTo(64, 0);
      expect(top.header.bottom).toBeLessThanOrEqual(top.band.top);
      expect(top.headerOnTop).toBe(true);
      // The room kept free after the page is exactly the band's height, however the text wrapped at this width.
      expect(top.space.height).toBeCloseTo(top.band.height, 0);

      // Scrolled to the very end: the last line of the page is above the band, not under it.
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      const end = await boxes(page);
      expect(end.band.bottom).toBeCloseTo(end.window.height, 0);
      expect(end.last.bottom).toBeLessThanOrEqual(end.band.top + 0.5);
      expect(end.header.top).toBeCloseTo(0, 0);
      expect(end.headerOnTop).toBe(true);
    } finally {
      await page.close();
    }
  });

  it('is German on a German site, and a revoked link shows nothing on the next request', async () => {
    const { origin, siteId, branchId } = await previewOf('Sommerangebot', 'de');
    const page = await browser.newPage();
    try {
      expect((await page.goto(`${origin}/`))?.status()).toBe(200);
      const band = (await page.locator('[data-fc-preview-band]').textContent()) ?? '';
      expect(band).toContain('Vorschau des Entwurfs „Summer sale“');
      expect(band).toContain('Dies ist nicht die veröffentlichte Website');
      expect(band).not.toContain('This is not the live site');
      expect(await getSiteBranchPreviewLinks().revoke(SCOPE, siteId, branchId, USER)).toBe(true);
      expect((await page.goto(`${origin}/`))?.status()).toBe(404);
    } finally {
      await page.close();
    }
  });
});

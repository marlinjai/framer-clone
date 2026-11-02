// Google Maps embeds on a real build (src/lib/mapEmbed), in real Chromium and WebKit:
// every request the browser makes is watched, Google is answered by a stub so the run
// is hermetic, and the log is the evidence that nothing reaches Google before consent.
//
// Covered: the placeholder before any choice; Decline keeps it; "Load map" only opens
// the platform's banner on the maps question and the banner's Accept shows the map;
// one choice per purpose where a page uses analytics and a map; withdrawal from
// "Cookie settings" on a page without a map, on a maps-only site and on a site with
// both; the review's payloads (a transparent map box over a decoy, the note hidden by
// a stored rule); phone width; the report-only policy per consent; the frame's
// sandbox; and BusBasis home's map as the held-out lift wrote it (the box and the map
// from test/score/corpus/busbasis, measured against the original frame's size).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, webkit, type Browser, type BrowserContext, type BrowserType, type Page, type Response } from 'playwright';
import { getPrismaClient } from '@/server/db';
import { node, type StoredNode } from './pages';
import { publishPages } from './site';
import { CONSENT_TAP_GUARD_MS } from '@/lib/consent/consent';

const SHARE = 'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d2419.6!2d13.2834!3d52.6871!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!5e0!3m2!1sde!2sde!4v1730000000000';
const ADDRESS = 'Hauptstraße 1, 16547 Birkenwerder';
const SANDBOX = 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox';

/**
 * BusBasis home's map exactly as the lift wrote it into the held-out tree: the box (e404,
 * 0.5rem corners, 300px high and 350px from 640px wide) around the map component (e405)
 * the lift made of the original's Google frame, with the frame's recaptured address and
 * title. `heights` is the original frame's height per captured width, from the live page.
 */
const busbasis = (() => {
  const dir = path.resolve(process.cwd(), 'test/score/corpus/busbasis');
  type Lifted = { id: string; type: string; props: Record<string, unknown>; children?: Lifted[] };
  const tree = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, 'pages/home.tree.json.gz'))).toString()) as Lifted;
  const find = (n: Lifted, id: string): Lifted | undefined =>
    n.props['data-parity-id'] === id ? n : (n.children ?? []).map((c) => find(c, id)).find(Boolean);
  const stored = (n: Lifted): StoredNode => ({
    id: n.id,
    type: n.type,
    componentType: 'host',
    props: { 'data-t': n.props['data-parity-id'], ...n.props },
    children: (n.children ?? []).map(stored),
  });
  const box = find(tree, 'e404');
  const map = box && find(box, 'e405');
  if (!box || !map || map.props['data-map-embed'] !== 'google') throw new Error('the held-out home tree has no lifted map at e404 and e405');
  const computed = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, 'pages/home.computed.json.gz'))).toString()) as Record<
    string,
    { width: number; firsts: Record<string, Record<string, string>>; rows: Record<string, { t: string; d: Record<string, string> }> }
  >;
  const heights = Object.fromEntries(
    Object.values(computed).map((w) => {
      const row = w.rows.e405;
      return [w.width, parseFloat({ ...w.firsts[row.t], ...row.d }.height)];
    }),
  ) as Record<number, number>;
  return { box: stored(box), title: map.props.mapTitle as string, src: map.props.mapUrl as string, heights };
})();

const map = (id: string, props: Record<string, unknown>) => node(id, 'div', { 'data-map-embed': 'google', ...props });
const footer = () => node('footer', 'footer', {}, node('cookie-link', 'a', { href: '#cookie-settings', children: 'Cookie settings' }));
const page = (...children: StoredNode[]) => () => node('page-root', 'main', { style: { padding: '16px' } }, ...children, footer());
const fill = { position: 'fixed', top: '0', left: '0', right: '0', bottom: '0' };

const PAGES = {
  map: page(
    node('title', 'h1', { children: 'Find us' }),
    map('the-map', { mapUrl: SHARE, mapAddress: ADDRESS, style: { width: '100%', height: '360px' } }),
  ),
  other: page(node('other-title', 'h1', { children: 'Another page' })),
  // The review's payload: a map box over the whole screen, everything in it made
  // transparent by a stored rule, above a decoy that asks for a tap.
  jack: page(
    node('decoy', 'div', { style: { ...fill, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '28px' } }, node('decoy-text', 'p', { children: 'Tap here to continue' })),
    map('jack-map', { mapUrl: SHARE, style: { ...fill, zIndex: 5 }, rules: [{ id: 'j', selector: '& *', style: { opacity: '0' } }] }),
  ),
  // The recheck's payload (N1): the box transparent and fixed over the screen above a
  // decoy, and rules that tried to stretch its button over the viewport.
  twotap: page(
    node('decoy2', 'div', { style: { ...fill, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '28px' } }, node('decoy2-text', 'p', { children: 'Tap twice to continue' })),
    map('twotap-map', {
      mapUrl: SHARE,
      style: { ...fill, zIndex: 5, opacity: '0' },
      rules: [
        { id: 'a', selector: '& *', style: { opacity: '0' } },
        { id: 'b', selector: '& button', style: { position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh' } },
      ],
    }),
  ),
  // The review's quieter payload: the note that Google receives data hidden, the button kept.
  quiet: page(map('quiet-map', { mapUrl: SHARE, mapAddress: ADDRESS, rules: [{ id: 'q', selector: '& p', style: { display: 'none' } }] })),
  'busbasis-home-map': page(node('location', 'section', {}, node('heading', 'h2', { children: 'Unsere Werkstatt' }), busbasis.box)),
};

const ENGINES: [string, BrowserType][] = [['chromium', chromium], ['webkit', webkit]];
const SETTLE_MS = 1500;
const LOG = path.join(os.tmpdir(), 'maps-requests.json');
const evidence: Record<string, string[]> = {};
const MAPS_ROW_ACCEPT = 'Maps from Google Maps: Accept';

let mapsOnly: string;
let withAnalytics: string;
let german: string;

beforeAll(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const port = process.env.BEHAVIOUR_PORT as string;
  mapsOnly = await publishPages(port, { pages: PAGES });
  withAnalytics = await publishPages(port, { pages: PAGES, analytics: true });
  german = await publishPages(port, { pages: PAGES, language: 'de' });
});

afterAll(async () => {
  fs.writeFileSync(LOG, JSON.stringify(evidence, null, 2));
  console.info(`[maps] request log written to ${LOG}`);
  await getPrismaClient().$disconnect();
});

describe.each(ENGINES)('in %s', (engineName, engine) => {
  let browser: Browser;
  let context: BrowserContext;
  let tab: Page;
  /** Every request the browser made, frames included, in order. */
  let requests: string[];
  let errors: string[];
  /** What the report-only policy said it would block, kept apart from real errors. */
  let cspReports: string[];

  const google = () => requests.filter((url) => /^https?:\/\/([^/]*\.)?(google|gstatic|googleapis)\.[a-z.]+\//.test(url));
  const foreign = (origin: string) => requests.filter((url) => !url.startsWith(origin) && !url.startsWith('data:') && !url.startsWith('blob:'));
  const record = (step: string) => {
    evidence[`${engineName}: ${step}`] = [...requests];
  };
  const frame = () => tab.locator('iframe[data-fc-map-frame]');
  const placeholder = () => tab.locator('[data-fc-map-placeholder]:visible');
  /** A banner opened from outside it ignores pointer clicks for a moment (CONSENT_TAP_GUARD_MS). */
  const pastGuard = () => tab.waitForTimeout(CONSENT_TAP_GUARD_MS + 100);
  const banner = () => tab.locator('#fc-consent');
  const stored = () => tab.evaluate(() => JSON.parse(window.localStorage.getItem('lumitra-consent') ?? 'null') as Record<string, unknown> | null);
  const mapsCookie = async () => (await context.cookies()).find((c) => c.name === 'lumitra-consent-maps')?.value ?? null;
  const open = async (url: string): Promise<Response | null> => {
    const response = await tab.goto(url);
    await tab.waitForTimeout(SETTLE_MS);
    return response;
  };
  /** The topmost element at the centre of a locator's box, as a real click would hit it. */
  const topAt = (selector: string) =>
    tab.evaluate((s) => {
      const target = document.querySelector(s);
      if (!target) return 'missing';
      const r = target.getBoundingClientRect();
      return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === target ? 'top' : 'covered';
    }, selector);

  beforeAll(async () => {
    browser = await engine.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });
  const start = async (width = 1280, height = 800) => {
    context = await browser.newContext({ viewport: { width, height } });
    requests = [];
    errors = [];
    cspReports = [];
    context.on('request', (request) => requests.push(request.url()));
    // Google answers with a stub: the test sees each request without reaching Google.
    await context.route(/^https:\/\/www\.google\.com\//, (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>map stub</title><p>map stub</p>' }),
    );
    tab = await context.newPage();
    tab.on('console', (message) => {
      if (message.type() !== 'error') return;
      if (/report-only Content Security Policy|^\[Report Only\]/i.test(message.text())) cspReports.push(message.text());
      else errors.push(message.text());
    });
    tab.on('pageerror', (error) => errors.push(error.message));
  };
  beforeEach(async () => {
    await start();
  });
  afterEach(async () => {
    await Promise.race([context.close(), new Promise((resolve) => { setTimeout(resolve, 3000); })]);
  });

  it('contacts nothing but the site before consent, and shows the placeholder and the banner', async () => {
    const response = await open(`${mapsOnly}/map`);
    record('first visit, no choice');
    expect(google()).toEqual([]);
    expect(foreign(mapsOnly)).toEqual([]);
    expect(await frame().count()).toBe(0);
    await expect.poll(() => banner().isVisible()).toBe(true);
    expect(await banner().textContent()).toContain('Google Ireland Limited');
    expect(await placeholder().textContent()).toContain(ADDRESS);
    const link = tab.getByRole('link', { name: 'Open in Google Maps' });
    expect(await link.getAttribute('href')).toBe(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(ADDRESS)}`);
    expect(await link.getAttribute('rel')).toBe('noopener noreferrer');
    // The report-only policy: any frame reports for a visitor without maps consent,
    // and there is no frame to report.
    expect(response?.headers()['content-security-policy-report-only']).toContain("frame-src 'self';");
    expect(cspReports).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('keeps the placeholder after Decline, across a reload, with nothing sent to Google', async () => {
    await open(`${mapsOnly}/map`);
    await banner().getByRole('button', { name: 'Decline' }).click();
    await tab.waitForTimeout(500);
    expect(await banner().isVisible()).toBe(false);
    expect(await frame().count()).toBe(0);
    await open(`${mapsOnly}/map`);
    record('declined, reloaded');
    expect(await banner().isVisible()).toBe(false);
    expect(await frame().count()).toBe(0);
    expect(google()).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('"Load map" asks in the banner and records nothing; the banner\'s Accept shows the map; revoking takes it out', async () => {
    await open(`${mapsOnly}/map`);
    await banner().getByRole('button', { name: 'Decline' }).click();
    await tab.getByRole('button', { name: 'Load map' }).click();
    await expect.poll(() => banner().isVisible()).toBe(true);
    await pastGuard();
    // Asking is not answering.
    expect((await stored())?.maps).toBe(false);
    expect(await frame().count()).toBe(0);
    expect(google()).toEqual([]);
    expect(await topAt('#fc-consent [data-fc-consent-accept]')).toBe('top');
    await banner().getByRole('button', { name: 'Accept' }).click();
    await expect.poll(() => frame().count()).toBe(1);
    expect(await frame().getAttribute('src')).toBe(SHARE);
    expect(await frame().getAttribute('title')).toBe(`Map: ${ADDRESS}`);
    expect(await frame().getAttribute('sandbox')).toBe(SANDBOX);
    expect(await frame().getAttribute('allow')).toBe('fullscreen');
    expect(await frame().getAttribute('referrerpolicy')).toBe('strict-origin-when-cross-origin');
    await expect.poll(() => google()).toEqual([SHARE]);
    record('after Load map and the banner\'s Accept');
    expect(await mapsCookie()).toBe('1');
    // The page view on which the visitor said yes was served before the choice, so its
    // policy reports the Google frame once (src/lib/site/cspReportOnly.ts says so).
    expect(cspReports.every((line) => line.includes('https://www.google.com'))).toBe(true);

    requests = [];
    cspReports = [];
    const response = await open(`${mapsOnly}/map`);
    expect(response?.headers()['content-security-policy-report-only']).toContain("frame-src 'self' https://www.google.com;");
    await expect.poll(() => frame().count()).toBe(1);
    expect(await banner().isVisible()).toBe(false);
    expect(cspReports).toEqual([]);

    await tab.getByRole('link', { name: 'Cookie settings' }).click();
    await expect.poll(() => banner().isVisible()).toBe(true);
    await pastGuard();
    await banner().getByRole('button', { name: 'Decline' }).click();
    await expect.poll(() => frame().count()).toBe(0);
    expect(await placeholder().count()).toBe(1);
    expect(await mapsCookie()).toBeNull();
    requests = [];
    await open(`${mapsOnly}/map`);
    record('revoked on the map page, reloaded');
    expect(google()).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('asks analytics and maps separately, so analytics alone can be allowed with no Google contact', async () => {
    await open(`${withAnalytics}/map`);
    record('analytics and map, no choice');
    expect(google()).toEqual([]);
    expect(await banner().locator('[data-fc-consent-row="analytics"]').isVisible()).toBe(true);
    expect(await banner().locator('[data-fc-consent-row="maps"]').isVisible()).toBe(true);
    await tab.getByRole('button', { name: 'Audience measurement (Lumitra Analytics): Accept' }).click();
    await tab.getByRole('button', { name: 'Maps from Google Maps: Decline' }).click();
    await tab.waitForTimeout(500);
    expect(await stored()).toMatchObject({ analytics: true, maps: false });
    expect(await banner().isVisible()).toBe(false);
    expect(await frame().count()).toBe(0);
    record('analytics allowed, maps declined');
    expect(google()).toEqual([]);
    // "Load map" then asks again, focused on the maps row, and only that row's Accept loads it.
    await tab.getByRole('button', { name: 'Load map' }).click();
    await expect.poll(() => banner().isVisible()).toBe(true);
    await pastGuard();
    expect(await tab.evaluate(() => document.activeElement?.getAttribute('data-fc-consent-row'))).toBe('maps');
    await tab.getByRole('button', { name: MAPS_ROW_ACCEPT }).click();
    await expect.poll(() => frame().count()).toBe(1);
    expect(await stored()).toMatchObject({ analytics: true, maps: true });
    expect(errors).toEqual([]);
  });

  for (const [label, site] of [['a maps-only site', () => mapsOnly], ['a site with analytics and a map', () => withAnalytics]] as const) {
    it(`withdraws maps from a page without a map, on ${label}`, async () => {
      const origin = site();
      await open(`${origin}/map`);
      await tab.getByRole('button', { name: 'Load map' }).click();
      await expect.poll(() => banner().isVisible()).toBe(true);
      await pastGuard();
      const accept = origin === mapsOnly ? banner().getByRole('button', { name: 'Accept' }) : tab.getByRole('button', { name: MAPS_ROW_ACCEPT });
      await accept.click();
      await expect.poll(() => frame().count()).toBe(1);
      await open(`${origin}/other`);
      const link = tab.getByRole('link', { name: 'Cookie settings' });
      expect(await link.isVisible()).toBe(true);
      await link.click();
      await expect.poll(() => banner().isVisible()).toBe(true);
      await pastGuard();
      expect(await banner().textContent()).toContain('Google Maps');
      // Decline answers every category the banner shows: a single "Decline", or "Decline all".
      await banner().getByRole('button', { name: origin === mapsOnly ? 'Decline' : 'Decline all' }).click();
      await tab.waitForTimeout(500);
      expect((await stored())?.maps).toBe(false);
      expect(await mapsCookie()).toBeNull();
      requests = [];
      await open(`${origin}/map`);
      record(`withdrawn from another page, back on the map page (${label})`);
      expect(google()).toEqual([]);
      expect(await frame().count()).toBe(0);
      expect(await placeholder().count()).toBe(1);
      expect(errors).toEqual([]);
    });
  }

  it('the review\'s transparent box: stored rules no longer reach the placeholder, a tap only opens the banner', async () => {
    await open(`${mapsOnly}/jack`);
    await banner().getByRole('button', { name: 'Decline' }).click();
    await tab.waitForTimeout(300);
    // `& * { opacity: 0 }` on the box cannot reach into its shadow tree: the button shows.
    const load = tab.getByRole('button', { name: 'Load map' });
    expect(await load.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    await load.click();
    await tab.waitForTimeout(800);
    expect((await stored())?.maps).toBe(false);
    expect(await mapsCookie()).toBeNull();
    expect(await frame().count()).toBe(0);
    record('clickjack tap');
    expect(google()).toEqual([]);
    expect(await banner().isVisible()).toBe(true);
    expect(await banner().textContent()).toContain('Google Ireland Limited');
    expect(await topAt('#fc-consent [data-fc-consent-accept]')).toBe('top');
    expect(errors).toEqual([]);
  });

  it('the note and the button stay as the platform drew them, whatever a stored rule says', async () => {
    await open(`${mapsOnly}/quiet`);
    await banner().getByRole('button', { name: 'Decline' }).click();
    // `& p { display: none }` does not reach the shadow tree: the note shows.
    const note = placeholder().locator('p', { hasText: 'Google Ireland Limited' });
    expect(await note.isVisible()).toBe(true);
    await tab.getByRole('button', { name: 'Load map' }).click();
    await expect.poll(() => banner().isVisible()).toBe(true);
    const text = banner().locator('#fc-consent-text');
    expect(await text.isVisible()).toBe(true);
    expect(await text.textContent()).toContain('Google Ireland Limited');
    expect(await frame().count()).toBe(0);
    expect(google()).toEqual([]);
    expect(errors).toEqual([]);
  });

  for (const [width, height] of [[390, 844], [1280, 800]] as const) {
    for (const [label, site, acceptName] of [['maps only', () => mapsOnly, 'Accept'], ['analytics and maps', () => withAnalytics, MAPS_ROW_ACCEPT]] as const) {
      it(`N1, two quick taps: the second lands on the real Accept and answers nothing (${width}px, ${label})`, async () => {
        await context.close();
        await start(width, height);
        const origin = site();
        await open(`${origin}/twotap`);
        await banner().getByRole('button', { name: label === 'maps only' ? 'Decline' : 'Decline all' }).click();
        await tab.waitForTimeout(300);
        expect(await banner().isVisible()).toBe(false);
        // The review's payload: the whole box transparent and stretched over a decoy. The
        // box itself is the page's to style; its button is not, so it sits mid-box.
        const loadBox = await tab.getByRole('button', { name: 'Load map' }).boundingBox();
        if (!loadBox) throw new Error('no Load map button');
        // Where the banner's Accept will appear: measured on a first opening, then closed.
        await tab.evaluate(() => (window as unknown as { __lumitraConsent: { open: (c: string) => void } }).__lumitraConsent.open('maps'));
        const acceptBox = await tab.getByRole('button', { name: acceptName }).boundingBox();
        if (!acceptBox) throw new Error('no Accept');
        await tab.keyboard.press('Escape');
        await expect.poll(() => banner().isVisible()).toBe(false);
        // Tap one on "Load map", tap two 120 ms later where Accept appears.
        await tab.mouse.click(loadBox.x + loadBox.width / 2, loadBox.y + loadBox.height / 2);
        await tab.waitForTimeout(120);
        const atSecondTap = await tab.evaluate(([x, y]) => document.elementFromPoint(x, y)?.hasAttribute('data-fc-consent-accept') ?? false, [acceptBox.x + acceptBox.width / 2, acceptBox.y + acceptBox.height / 2]);
        expect(atSecondTap).toBe(true);
        await tab.mouse.click(acceptBox.x + acceptBox.width / 2, acceptBox.y + acceptBox.height / 2);
        await tab.waitForTimeout(800);
        expect((await stored())?.maps).toBe(false);
        expect(await mapsCookie()).toBeNull();
        expect(await frame().count()).toBe(0);
        expect(await banner().isVisible()).toBe(true);
        record(`N1 two taps, ${width}px, ${label}`);
        expect(google()).toEqual([]);
        // A key on the focused Accept answers at once: keyboard users are never held up.
        await tab.getByRole('button', { name: acceptName }).focus();
        await tab.keyboard.press('Enter');
        await expect.poll(() => frame().count()).toBe(1);
        expect((await stored())?.maps).toBe(true);
        expect(errors).toEqual([]);
      });
    }
  }

  it('works at phone width: no sideways scrolling, the button, the link and the banner in reach', async () => {
    await context.close();
    await start(375, 812);
    await open(`${withAnalytics}/map`);
    const bannerBox = await banner().boundingBox();
    expect(bannerBox && bannerBox.y >= 0 && bannerBox.y + bannerBox.height <= 812 && bannerBox.x + bannerBox.width <= 375).toBe(true);
    await banner().getByRole('button', { name: 'Decline all' }).click();
    expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const button = tab.getByRole('button', { name: 'Load map' });
    const box = await button.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 375 && box.height >= 44).toBe(true);
    const link = await tab.getByRole('link', { name: 'Open in Google Maps' }).boundingBox();
    expect(link && link.x >= 0 && link.x + link.width <= 375).toBe(true);
    expect(google()).toEqual([]);
    await button.click();
    await pastGuard();
    await tab.getByRole('button', { name: MAPS_ROW_ACCEPT }).click();
    await expect.poll(() => frame().count()).toBe(1);
    const frameBox = await frame().boundingBox();
    expect(frameBox && frameBox.width <= 375 && frameBox.height >= 240).toBe(true);
    expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect.poll(() => google()).toEqual([SHARE]);
    record('phone width, after the maps Accept');
    expect(errors).toEqual([]);
  });

  it('shows BusBasis home\'s lifted map as the original frame is sized, and after consent the frame itself', async () => {
    for (const width of [1280, 375]) {
      if (width !== 1280) {
        await context.close();
        await start(width, 800);
      }
      await open(`${german}/busbasis-home-map`);
      record(`BusBasis home map at ${width}, no choice`);
      expect(google()).toEqual([]);
      const box = tab.locator('[data-t="e404"]');
      const host = tab.locator('[data-t="e405"]');
      expect(await box.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe('8px');
      // Before consent the placeholder takes the original frame's place, at its height.
      expect((await host.boundingBox())?.height).toBe(busbasis.heights[width]);
      expect((await placeholder().boundingBox())?.height).toBe(busbasis.heights[width]);
      expect(await placeholder().textContent()).toContain('Karte laden');
      await tab.getByRole('button', { name: 'Karte laden' }).click();
      expect(await frame().count()).toBe(0);
      await pastGuard();
      await banner().getByRole('button', { name: 'Akzeptieren' }).click();
      // After consent the frame: the original's address and title, at the original's height.
      await expect.poll(() => frame().count()).toBe(1);
      expect(await frame().getAttribute('title')).toBe(busbasis.title);
      expect(await frame().getAttribute('src')).toBe(busbasis.src);
      expect((await frame().boundingBox())?.height).toBe(busbasis.heights[width]);
      expect((await box.boundingBox())?.height).toBe(busbasis.heights[width]);
      await expect.poll(() => google()).toEqual([busbasis.src]);
      record(`BusBasis home map at ${width}, after Karte laden and Akzeptieren`);
      expect(errors).toEqual([]);
    }
  });
});

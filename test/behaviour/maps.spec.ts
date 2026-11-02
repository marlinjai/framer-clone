// Google Maps embeds on a real build (src/lib/mapEmbed), in real Chromium and WebKit:
// every request the browser makes is watched, Google is answered by a stub so the run
// is hermetic, and the log is the evidence that nothing reaches Google before consent.
// Covered: the placeholder before any choice, Decline keeps it, "Load map" and the
// banner's Accept show the map, revoking from "Cookie settings" takes it out, phone
// width, the report-only policy per consent, and BusBasis home's map case (a 300px box
// with rounded corners, the German title of the original frame).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium, webkit, type Browser, type BrowserContext, type BrowserType, type Page, type Response } from 'playwright';
import { getPrismaClient } from '@/server/db';
import { node, type StoredNode } from './pages';
import { publishPages } from './site';

const SHARE = 'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d2419.6!2d13.2834!3d52.6871!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!5e0!3m2!1sde!2sde!4v1730000000000';
const BUSBASIS_TITLE = 'Karte: Werkstatt in der xxxxxxxxxxx 00, Birkenwerder';
const BUSBASIS_ADDRESS = 'Werkstatt in der xxxxxxxxxxx 00, Birkenwerder';

const map = (id: string, props: Record<string, unknown>) => node(id, 'div', { 'data-map-embed': 'google', ...props });
const footer = () => node('footer', 'footer', {}, node('cookie-link', 'a', { href: '#cookie-settings', children: 'Cookie settings' }));
const page = (...children: StoredNode[]) => () => node('page-root', 'main', { style: { padding: '16px' } }, ...children, footer());

const PAGES = {
  map: page(
    node('title', 'h1', { children: 'Find us' }),
    map('the-map', { mapUrl: SHARE, mapAddress: 'Hauptstraße 1, 16547 Birkenwerder', style: { width: '100%', height: '360px' } }),
  ),
  // BusBasis home (test/score/corpus/busbasis/pages/home.html, e404 and e405): a 300px box
  // with 0.5rem corners and overflow hidden around a full-size frame with this title. The
  // capture dropped the frame's address, so the box searches for the address instead.
  'busbasis-home-map': page(
    node('location', 'section', {}, node('heading', 'h2', { children: 'Unsere Werkstatt' }),
      map('busbasis-map', { mapAddress: BUSBASIS_ADDRESS, mapTitle: BUSBASIS_TITLE, style: { height: '300px', overflow: 'hidden', borderRadius: '0.5rem' } })),
  ),
};

const ENGINES: [string, BrowserType][] = [['chromium', chromium], ['webkit', webkit]];
const SETTLE_MS = 1500;
const LOG = path.join(os.tmpdir(), 'maps-requests.json');
const evidence: Record<string, string[]> = {};

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
  const placeholder = () => tab.locator('[data-fc-map-placeholder]');
  const banner = () => tab.locator('#fc-consent');
  const open = async (url: string): Promise<Response | null> => {
    const response = await tab.goto(url);
    await tab.waitForTimeout(SETTLE_MS);
    return response;
  };

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
    // Nothing for the policy to report either: no frame exists before consent.
    const response = await open(`${mapsOnly}/map`);
    record('first visit, no choice');
    expect(google()).toEqual([]);
    expect(foreign(mapsOnly)).toEqual([]);
    expect(await frame().count()).toBe(0);
    await expect.poll(() => banner().isVisible()).toBe(true);
    expect(await banner().textContent()).toContain('Google Maps');
    expect(await placeholder().textContent()).toContain('Hauptstraße 1, 16547 Birkenwerder');
    expect(await tab.getByRole('button', { name: 'Load map' }).isVisible()).toBe(true);
    const link = tab.getByRole('link', { name: 'Open in Google Maps' });
    expect(await link.getAttribute('href')).toBe(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent('Hauptstraße 1, 16547 Birkenwerder')}`);
    expect(await link.getAttribute('rel')).toBe('noopener noreferrer');
    // The report-only policy: any frame reports for a visitor without maps consent.
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
    expect(await placeholder().count()).toBe(1);
    await open(`${mapsOnly}/map`);
    record('declined, reloaded');
    expect(await banner().isVisible()).toBe(false);
    expect(await frame().count()).toBe(0);
    expect(google()).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('shows the map after "Load map", then takes it out again when consent is revoked', async () => {
    await open(`${mapsOnly}/map`);
    await banner().getByRole('button', { name: 'Decline' }).click();
    expect(google()).toEqual([]);
    await tab.getByRole('button', { name: 'Load map' }).click();
    await expect.poll(() => frame().count()).toBe(1);
    expect(await frame().getAttribute('src')).toBe(SHARE);
    expect(await frame().getAttribute('title')).toBe('Map: Hauptstraße 1, 16547 Birkenwerder');
    await expect.poll(() => google()).toEqual([SHARE]);
    record('after Load map');
    expect((await context.cookies()).find((c) => c.name === 'lumitra-consent-maps')?.value).toBe('1');

    // The page view on which the visitor said yes was served before the choice, so its
    // policy reports the Google frame once (src/lib/site/cspReportOnly.ts says so).
    expect(cspReports.every((line) => line.includes('https://www.google.com'))).toBe(true);
    // A reload with consent recorded: the map comes back, and the policy expects Google now.
    requests = [];
    cspReports = [];
    const response = await open(`${mapsOnly}/map`);
    expect(response?.headers()['content-security-policy-report-only']).toContain("frame-src 'self' https://www.google.com;");
    await expect.poll(() => frame().count()).toBe(1);
    expect(await banner().isVisible()).toBe(false);
    expect(cspReports).toEqual([]);

    // Revoke from the footer's "Cookie settings".
    await tab.getByRole('link', { name: 'Cookie settings' }).click();
    await expect.poll(() => banner().isVisible()).toBe(true);
    await banner().getByRole('button', { name: 'Decline' }).click();
    await expect.poll(() => frame().count()).toBe(0);
    expect(await placeholder().count()).toBe(1);
    expect((await context.cookies()).find((c) => c.name === 'lumitra-consent-maps')).toBeUndefined();
    requests = [];
    await open(`${mapsOnly}/map`);
    record('revoked, reloaded');
    expect(google()).toEqual([]);
    expect(await frame().count()).toBe(0);
    expect(errors).toEqual([]);
  });

  it('shows the map after the banner\'s Accept', async () => {
    await open(`${mapsOnly}/map`);
    expect(google()).toEqual([]);
    await banner().getByRole('button', { name: 'Accept' }).click();
    await expect.poll(() => frame().count()).toBe(1);
    await expect.poll(() => google()).toEqual([SHARE]);
    record('after Accept');
    expect(errors).toEqual([]);
  });

  it('asks about analytics and the map together, and loads nothing from Google before', async () => {
    await open(`${withAnalytics}/map`);
    record('analytics and map, no choice');
    expect(google()).toEqual([]);
    const text = await banner().textContent();
    expect(text).toContain('Lumitra Analytics');
    expect(text).toContain('Google Maps');
    // "Load map" answers maps alone: the analytics question stays open.
    await tab.getByRole('button', { name: 'Load map' }).click();
    await expect.poll(() => frame().count()).toBe(1);
    expect(await banner().isVisible()).toBe(true);
    const stored = await tab.evaluate(() => JSON.parse(window.localStorage.getItem('lumitra-consent') ?? 'null'));
    expect(stored).toMatchObject({ maps: true });
    expect(stored).not.toHaveProperty('analytics');
    expect(errors).toEqual([]);
  });

  it('works at phone width: no sideways scrolling, the button and the link in reach', async () => {
    await context.close();
    await start(375, 812);
    await open(`${mapsOnly}/map`);
    await banner().getByRole('button', { name: 'Decline' }).click();
    const fits = await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(fits).toBe(true);
    const button = tab.getByRole('button', { name: 'Load map' });
    const box = await button.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 375 && box.height >= 44).toBe(true);
    const link = await tab.getByRole('link', { name: 'Open in Google Maps' }).boundingBox();
    expect(link && link.x >= 0 && link.x + link.width <= 375).toBe(true);
    expect(google()).toEqual([]);
    await button.click();
    await expect.poll(() => frame().count()).toBe(1);
    const frameBox = await frame().boundingBox();
    expect(frameBox && frameBox.width <= 375 && frameBox.height >= 240).toBe(true);
    expect(await tab.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect.poll(() => google()).toEqual([SHARE]);
    record('phone width, after Load map');
    expect(errors).toEqual([]);
  });

  it('covers BusBasis home\'s map: the 300px box, German copy, the original frame\'s title', async () => {
    await open(`${german}/busbasis-home-map`);
    record('BusBasis home map, no choice');
    expect(google()).toEqual([]);
    const box = tab.locator('[data-t="busbasis-map"]');
    expect((await box.boundingBox())?.height).toBe(300);
    expect(await box.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe('8px');
    expect(await placeholder().textContent()).toContain(BUSBASIS_ADDRESS);
    expect(await banner().textContent()).toContain('Google Maps');
    await tab.getByRole('button', { name: 'Karte laden' }).click();
    await expect.poll(() => frame().count()).toBe(1);
    expect(await frame().getAttribute('title')).toBe(BUSBASIS_TITLE);
    expect(await frame().getAttribute('src')).toBe(`https://www.google.com/maps?q=${encodeURIComponent(BUSBASIS_ADDRESS)}&output=embed`);
    expect((await box.boundingBox())?.height).toBe(300);
    const inner = await frame().boundingBox();
    expect(inner?.height).toBe(300);
    await expect.poll(() => google()).toEqual([`https://www.google.com/maps?q=${encodeURIComponent(BUSBASIS_ADDRESS)}&output=embed`]);
    record('BusBasis home map, after Karte laden');
    expect(errors).toEqual([]);
  });
});

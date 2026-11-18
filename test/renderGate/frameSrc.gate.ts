// The enforced frame policy in real browsers (decision D6 of
// docs/plans/2026-11-02-sandboxed-custom-code.md, slice C2). The headers come from a
// real call of the middleware, for a published page and for the editor host's
// standalone preview, with and without maps consent; a page served with exactly
// those headers then tries three frames: the box, the Google map as its island
// builds it, and another host. Each frame either loads (its document posts a
// message to the page) or is refused (the page sees a violation of the enforced
// policy). Nothing is waited on blindly: every frame's outcome is collected, and
// what the browser did is compared with what the policy allows.

import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { chromium, webkit, type BrowserType, type Page } from 'playwright';
import { middleware } from '@/middleware';
import { MAPS_CONSENT_COOKIE } from '@/lib/site/cspReportOnly';
import { parseMapEmbed } from '@/lib/mapEmbed/mapEmbed';
import { MAP_FRAME_SANDBOX } from '@/lib/renderer/mapEmbed/mapEmbedElement';
import { CONSENT_BANNER_ID, consentRuntimeScript } from '@/lib/consent/consent';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderPublishedPage } from '@/lib/renderer/server/renderPublishedPage';
import { MAP_EMBED_ATTR, MAP_EMBED_MARKER } from '@/lib/mapEmbed/mapEmbed';
import type { CmsReadRepository } from '@/server/cms';

const EDITOR = 'app.editor.test';
const SITE = 'acme.sites.test';
const BOX_ORIGIN = 'https://run.box.test';
const BOX_FRAME = `${BOX_ORIGIN}/box/0b9e2f4a-1c2d-4e5f-8a9b-0c1d2e3f4a5b/${'0123456789abcdef'.repeat(4)}`;
const SHARE = 'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d2419.6!2d13.2834!3d52.6871!5e0';
const parsedMap = parseMapEmbed(SHARE);
if (!parsedMap.ok) throw new Error(parsedMap.error);
const MAP_FRAME = parsedMap.map.src;
const OTHER_FRAME = 'https://other.frame.test/page';

type Outcome = 'loaded' | 'refused' | 'pending';

afterEach(() => {
  delete process.env.EDITOR_HOST;
  delete process.env.CUSTOM_CODE_DISABLED;
  delete process.env.SANDBOX_ORIGIN;
});

/** The headers the middleware gives this request, as the server would send them with the document. */
async function headersFor(url: string, cookie: string): Promise<Record<string, string>> {
  process.env.EDITOR_HOST = EDITOR;
  process.env.CUSTOM_CODE_DISABLED = '0';
  process.env.SANDBOX_ORIGIN = BOX_ORIGIN;
  const response = await middleware(new NextRequest(url, { headers: { host: new URL(url).host, cookie } }));
  const out: Record<string, string> = {};
  for (const name of ['content-security-policy', 'content-security-policy-report-only', 'x-frame-options']) {
    const value = response.headers.get(name);
    if (value !== null) out[name] = value;
  }
  return out;
}

const FRAME_DOCUMENT = (name: string) =>
  `<!doctype html><meta charset="utf-8"><script>parent.postMessage({ frame: ${JSON.stringify(name)} }, '*');</script>`;

// The map frame as MapEmbedIsland draws it, the box frame as the broker of slice C3 will.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script>
  window.__outcomes = { box: 'pending', map: 'pending', other: 'pending' };
  const frames = {
    box: { src: ${JSON.stringify(BOX_FRAME)}, sandbox: 'allow-scripts' },
    map: { src: ${JSON.stringify(MAP_FRAME)}, sandbox: ${JSON.stringify(MAP_FRAME_SANDBOX)} },
    other: { src: ${JSON.stringify(OTHER_FRAME)}, sandbox: 'allow-scripts' },
  };
  window.addEventListener('message', (event) => {
    const name = event.data && event.data.frame;
    if (name in window.__outcomes) window.__outcomes[name] = 'loaded';
  });
  document.addEventListener('securitypolicyviolation', (event) => {
    if (event.disposition !== 'enforce') return;
    for (const [name, frame] of Object.entries(frames)) {
      // A browser may name only the origin it refused, which two box frames share: a frame that loaded stays loaded.
      if (event.blockedURI && frame.src.startsWith(event.blockedURI) && window.__outcomes[name] !== 'loaded') window.__outcomes[name] = 'refused';
    }
  });
  for (const [name, frame] of Object.entries(frames)) {
    const element = document.createElement('iframe');
    element.setAttribute('sandbox', frame.sandbox);
    element.title = name;
    element.src = frame.src;
    document.body.appendChild(element);
  }
</script></body></html>`;

async function outcomes(page: Page, headers: Record<string, string>, documentUrl: string, body = PAGE): Promise<Record<string, Outcome>> {
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url === documentUrl) return route.fulfill({ status: 200, contentType: 'text/html', headers, body });
    if (url === BOX_FRAME) return route.fulfill({ status: 200, contentType: 'text/html', body: FRAME_DOCUMENT('box') });
    if (url === MAP_FRAME) return route.fulfill({ status: 200, contentType: 'text/html', body: FRAME_DOCUMENT('map') });
    if (url === OTHER_FRAME) return route.fulfill({ status: 200, contentType: 'text/html', body: FRAME_DOCUMENT('other') });
    // Another site's box path (the per-site policy's case below).
    if (url.startsWith(`${BOX_ORIGIN}/box/`)) return route.fulfill({ status: 200, contentType: 'text/html', body: FRAME_DOCUMENT('stranger') });
    // The report-only policy's reports, and anything else: answered, never sent anywhere.
    return route.fulfill({ status: 204 });
  });
  await page.goto(documentUrl, { waitUntil: 'domcontentloaded' });
  // Every frame ends loaded or refused; give the browser up to ten seconds, then read what happened.
  await page
    .waitForFunction(() => Object.values((window as unknown as { __outcomes: Record<string, string> }).__outcomes).every((o) => o !== 'pending'), undefined, { timeout: 10_000 })
    .catch(() => {});
  return page.evaluate(() => (window as unknown as { __outcomes: Record<string, Outcome> }).__outcomes);
}

const CASES: { name: string; url: string; cookie: string; expected: Record<string, Outcome> }[] = [
  {
    name: 'a published page without maps consent',
    url: `https://${SITE}/about`,
    cookie: '',
    expected: { box: 'loaded', map: 'refused', other: 'refused' },
  },
  {
    name: 'a published page after maps consent',
    url: `https://${SITE}/about`,
    cookie: `${MAPS_CONSENT_COOKIE}=1`,
    expected: { box: 'loaded', map: 'loaded', other: 'refused' },
  },
  {
    name: 'the standalone preview without maps consent',
    url: `https://${EDITOR}/projects/site-1/preview`,
    cookie: 'lumitra_session=s1',
    expected: { box: 'loaded', map: 'refused', other: 'refused' },
  },
  {
    name: 'the standalone preview after maps consent',
    url: `https://${EDITOR}/projects/site-1/preview`,
    cookie: `lumitra_session=s1; ${MAPS_CONSENT_COOKIE}=1`,
    expected: { box: 'loaded', map: 'loaded', other: 'refused' },
  },
];

describe('the enforced frame policy', () => {
  for (const [browserName, type] of [['chromium', chromium], ['webkit', webkit]] as [string, BrowserType][]) {
    it.each(CASES)(`in ${browserName}: $name`, async ({ url, cookie, expected }) => {
      const headers = await headersFor(url, cookie);
      expect(headers['content-security-policy']).toMatch(/frame-src /);
      const browser = await type.launch();
      try {
        const page = await browser.newPage();
        expect(await outcomes(page, headers, url)).toEqual(expected);
      } finally {
        await browser.close();
      }
    }, 60_000);
  }

  it('lets the map load after consent and refuses it before, read from the document the browser received', async () => {
    const browser = await chromium.launch();
    try {
      const url = `https://${SITE}/contact`;
      const before = await browser.newPage();
      const refused = await outcomes(before, await headersFor(url, ''), url);
      const after = await browser.newPage();
      const loaded = await outcomes(after, await headersFor(url, `${MAPS_CONSENT_COOKIE}=1`), url);
      expect([refused.map, loaded.map]).toEqual(['refused', 'loaded']);
      // What the browser holds is the header the middleware sent.
      const response = await after.goto(url);
      expect(response?.headers()['content-security-policy']).toBe(`frame-src ${BOX_ORIGIN}/box/ https://www.google.com; object-src 'none'`);
    } finally {
      await browser.close();
    }
  }, 60_000);
});

// Slice C3 (D67): a published page with a block carries a `<meta>` that narrows `frame-src` to
// its own site's box path, and keeps Google only when the page has a map. Taken here from a
// real render of such a page, it must leave the header's decision about the map alone and
// refuse another site's box path, which the header alone allows.
describe("the per-site policy of a page with custom code", () => {
  const SITE_ID = BOX_FRAME.split('/')[4];
  const OTHER_SITE_BOX = BOX_FRAME.replace(SITE_ID, 'ffffffff-1c2d-4e5f-8a9b-0c1d2e3f4a5b');

  async function siteMeta(): Promise<string> {
    const cmsRepo = { listRows: async () => ({ rows: [], total: 0 }), getRow: async () => null } as unknown as CmsReadRepository;
    const hash = BOX_FRAME.slice(-64);
    const rendered = await renderPublishedPage({
      root: {
        type: 'div',
        id: 'root',
        children: [
          { type: 'div', id: 'b', props: { customCode: { sha256: hash, title: 'Block' } } },
          { type: 'div', id: 'm', props: { [MAP_EMBED_ATTR]: MAP_EMBED_MARKER, mapAddress: 'Berlin' } },
        ],
      },
      pageParams: {},
      cmsRepo,
      customCode: {
        siteId: SITE_ID,
        origin: BOX_ORIGIN,
        blobs: new Map([[hash, { reads: [], writes: [], emits: [], sizing: 'fixed', interactive: true }]]),
      },
    });
    const meta = renderToStaticMarkup(React.createElement(React.Fragment, null, rendered.body)).match(/<meta http-equiv="Content-Security-Policy"[^>]*>/);
    if (!meta) throw new Error('the page carries no per-site policy');
    return meta[0];
  }

  const pageWith = (meta: string) =>
    PAGE.replace('<meta charset="utf-8">', `<meta charset="utf-8">${meta}`)
      .replace("other: { src: ", `stranger: { src: ${JSON.stringify(OTHER_SITE_BOX)}, sandbox: 'allow-scripts' },\n    other: { src: `)
      .replace("{ box: 'pending', map: 'pending', other: 'pending' }", "{ box: 'pending', map: 'pending', other: 'pending', stranger: 'pending' }");

  for (const [browserName, type] of [['chromium', chromium], ['webkit', webkit]] as [string, BrowserType][]) {
    it(`in ${browserName}: the map follows consent, and another site's box is refused`, async () => {
      const meta = await siteMeta();
      expect(meta).toContain(`frame-src ${BOX_ORIGIN}/box/${SITE_ID}/ https://www.google.com`);
      const url = `https://${SITE}/contact`;
      const browser = await type.launch();
      try {
        const page = await browser.newPage();
        const before = await outcomes(page, await headersFor(url, ''), url, pageWith(meta));
        const second = await browser.newPage();
        const after = await outcomes(second, await headersFor(url, `${MAPS_CONSENT_COOKIE}=1`), url, pageWith(meta));
        expect(before).toEqual({ box: 'loaded', map: 'refused', other: 'refused', stranger: 'refused' });
        expect(after).toEqual({ box: 'loaded', map: 'loaded', other: 'refused', stranger: 'refused' });
      } finally {
        await browser.close();
      }
    }, 60_000);
  }
});

// A page with the consent runtime and a map as MapEmbedIsland behaves: the frame is
// drawn when the stored answer is yes as the page starts, or when the banner's yes is
// announced. Served each time with the headers the middleware gives that request.
const CONSENT_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="${CONSENT_BANNER_ID}" data-fc-consent="">
  <button type="button" data-fc-consent-decline="">No</button>
  <button type="button" id="yes" data-fc-consent-accept="">Yes</button>
</div>
<script>${consentRuntimeScript({ tracker: null, categories: ['maps'] })}</script>
<script>
  window.__map = 'none';
  addEventListener('message', (event) => { if (event.data && event.data.frame === 'map') window.__map = 'loaded'; });
  document.addEventListener('securitypolicyviolation', (event) => {
    if (event.disposition === 'enforce' && ${JSON.stringify(MAP_FRAME)}.startsWith(event.blockedURI)) window.__map = 'refused';
  });
  function draw() {
    if (document.querySelector('iframe')) return;
    window.__map = 'pending';
    const element = document.createElement('iframe');
    element.setAttribute('sandbox', ${JSON.stringify(MAP_FRAME_SANDBOX)});
    element.title = 'map';
    element.src = ${JSON.stringify(MAP_FRAME)};
    document.body.appendChild(element);
  }
  if (window.__lumitraConsent.get('maps') === 'granted') draw();
  addEventListener('lumitra:consent', (event) => { if (event.detail && event.detail.maps === true) draw(); });
</script></body></html>`;

describe('maps consent given on a page already loaded', () => {
  it.each([['chromium', chromium], ['webkit', webkit]] as [string, BrowserType][])(
    'in %s: the yes loads a new document whose policy allows the map, and the map loads',
    async (_name, type) => {
      const url = `https://${SITE}/contact`;
      const browser = await type.launch();
      try {
        const page = await browser.newPage();
        const served: string[] = [];
        await page.route('**/*', async (route) => {
          const request = route.request();
          if (request.url() === url) {
            // The browser's cookie jar, not the request's header: Playwright's WebKit leaves page-set
            // cookies out of an intercepted request's headers, although the browser holds them.
            const jar = await page.context().cookies(url);
            const headers = await headersFor(url, jar.map((c) => `${c.name}=${c.value}`).join('; '));
            served.push(headers['content-security-policy']);
            return route.fulfill({ status: 200, contentType: 'text/html', headers, body: CONSENT_PAGE });
          }
          if (request.url() === MAP_FRAME) return route.fulfill({ status: 200, contentType: 'text/html', body: FRAME_DOCUMENT('map') });
          return route.fulfill({ status: 204 });
        });
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        expect(await page.evaluate(() => (window as unknown as { __map: string }).__map)).toBe('none');
        await Promise.all([page.waitForEvent('load'), page.click('#yes')]);
        await page
          .waitForFunction(() => (window as unknown as { __map: string }).__map !== 'pending', undefined, { timeout: 10_000 })
          .catch(() => {});
        expect(await page.evaluate(() => (window as unknown as { __map: string }).__map)).toBe('loaded');
        expect(served).toEqual([`frame-src ${BOX_ORIGIN}/box/; object-src 'none'`, `frame-src ${BOX_ORIGIN}/box/ https://www.google.com; object-src 'none'`]);
      } finally {
        await browser.close();
      }
    },
    60_000,
  );
});

// An object or an embed is not a frame for frame-src in WebKit: object-src 'none' refuses both.
const PLUGIN_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script>
  window.__plugins = { object: 'pending', embed: 'pending' };
  addEventListener('message', (event) => { const n = event.data && event.data.frame; if (n in window.__plugins) window.__plugins[n] = 'loaded'; });
  window.__violations = [];
  document.addEventListener('securitypolicyviolation', (event) => {
    window.__violations.push(event.disposition + ' ' + event.effectiveDirective + ' ' + event.blockedURI);
    if (event.disposition !== 'enforce' || event.effectiveDirective !== 'object-src') return;
    // The blocked address may be reported as its origin only: each element has its own host.
    if (event.blockedURI.startsWith('https://object.frame.test')) window.__plugins.object = 'refused';
    if (event.blockedURI.startsWith('https://embed.frame.test')) window.__plugins.embed = 'refused';
  });
  const object = document.createElement('object');
  object.type = 'text/html';
  object.data = 'https://object.frame.test/object';
  document.body.appendChild(object);
  const embed = document.createElement('embed');
  embed.type = 'text/html';
  embed.src = 'https://embed.frame.test/embed';
  document.body.appendChild(embed);
</script></body></html>`;

describe('objects and embeds under the enforced policy', () => {
  it.each([['chromium', chromium], ['webkit', webkit]] as [string, BrowserType][])('in %s: a published page refuses both', async (_name, type) => {
    const url = `https://${SITE}/about`;
    const headers = await headersFor(url, '');
    expect(headers['content-security-policy']).toContain("object-src 'none'");
    const browser = await type.launch();
    try {
      const page = await browser.newPage();
      await page.route('**/*', (route) => {
        const target = route.request().url();
        if (target === url) return route.fulfill({ status: 200, contentType: 'text/html', headers, body: PLUGIN_PAGE });
        if (target.endsWith('/object')) return route.fulfill({ status: 200, contentType: 'text/html', body: FRAME_DOCUMENT('object') });
        if (target.endsWith('/embed')) return route.fulfill({ status: 200, contentType: 'text/html', body: FRAME_DOCUMENT('embed') });
        return route.fulfill({ status: 204 });
      });
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page
        .waitForFunction(() => Object.values((window as unknown as { __plugins: Record<string, string> }).__plugins).every((o) => o !== 'pending'), undefined, { timeout: 10_000 })
        .catch(() => {});
      const seen = await page.evaluate(() => {
        const w = window as unknown as { __plugins: Record<string, string>; __violations: string[] };
        return { __plugins: w.__plugins, __violations: w.__violations };
      });
      // The violations the page saw, as the message when it fails.
      expect(seen.__plugins, seen.__violations.join('\n')).toEqual({ object: 'refused', embed: 'refused' });
    } finally {
      await browser.close();
    }
  }, 60_000);
});

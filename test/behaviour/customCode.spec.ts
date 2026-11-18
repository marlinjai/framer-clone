// A sandboxed custom code block where it really runs (slice C3 of
// docs/plans/2026-11-02-sandboxed-custom-code.md): a stored page with a block, published
// through the real repository, the blob row and the site's switch in the real database,
// served by the real route of a real production build with the box's origin configured.
// The box is the one thing that is not real: nothing answers on BOX_ORIGIN, so the browser
// is given its answer here, with the real headers (boxDocumentHeaders) and the real shell
// (composeBoxDocument). Only `frame-ancestors` names the test page's own origin, as the
// test server speaks http on a port and the real header names https hosts.
//
// What this proves, beyond the bridge gate (test/renderGate/customCodeBridge.gate.ts, which
// starts the runtime and the broker by hand): BehaviourIsland fetches the broker chunk and
// starts it from `program.broker`, the island and the broker share one registry across
// Next's chunks, React keeps the broker's frame in the island through both of its settles,
// the blob read finds the row, and the per-site <meta> lands in <head>, where a browser
// obeys it.

import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { chromium, webkit, type Browser, type BrowserContext, type BrowserType, type Page } from 'playwright';
import { getPrismaClient } from '@/server/db';
import { boxDocumentHeaders, composeBoxDocument } from '@/lib/customCode/contract';
import { BOX_ORIGIN } from './box';
import { node, type StoredNode } from './pages';
import { publishPages } from './site';

/** In the custom code broker's chunk and nowhere else (src/lib/customCode/broker.ts). */
const BROKER_MARK = 'took the keyboard';

/** The author's document: once connected, it writes the page's number. */
const DOCUMENT = `<p>block</p><script>lumitra.ready().then(function () { lumitra.setState('n', 7); });</script>`;
const HASH = createHash('sha256').update(DOCUMENT).digest('hex');
const STRANGER = createHash('sha256').update('another site').digest('hex');

const blockPage = (): StoredNode =>
  node('area', 'div', { behaviour: { state: [{ id: 'n', name: 'n', type: 'number', initial: 0, min: 0, max: 9 }] } },
    node('count', 'output', { children: '0', behaviour: { bind: [{ text: { get: 'n' } }] } }),
    node('block', 'div', { customCode: { sha256: HASH, title: 'Counter' }, style: { height: '200px' } },
      node('fallback', 'p', { children: 'Fallback' })));

let origin: string;
let siteId: string;

beforeAll(async () => {
  siteId = randomUUID();
  origin = await publishPages(process.env.BEHAVIOUR_PORT as string, { siteId, pages: { block: blockPage } });
  const prisma = getPrismaClient();
  await prisma.site.update({ where: { id: siteId }, data: { customCodeEnabled: true } });
  await prisma.customCodeBlob.create({
    data: {
      siteId,
      sha256: HASH,
      document: DOCUMENT,
      title: 'Counter',
      declaration: { reads: [], writes: ['n'], emits: [], sizing: 'fixed', interactive: false },
      createdBy: 'behaviour-suite',
    },
  });
});

afterAll(async () => {
  await getPrismaClient().$disconnect();
});

const ENGINES: [string, BrowserType][] = [['chromium', chromium], ['webkit', webkit]];

describe.each(ENGINES)('a custom code block on a published page in %s', (_name, engine) => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let scripts: Promise<string>[];
  let boxRequests: string[];

  beforeAll(async () => {
    browser = await engine.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    context = await browser.newContext();
    page = await context.newPage();
    scripts = [];
    boxRequests = [];
    page.on('response', (response) => {
      if (response.url().includes('/_next/static/chunks/')) scripts.push(response.text());
    });
    await context.route(`${BOX_ORIGIN}/**`, (route) => {
      const url = route.request().url();
      boxRequests.push(url);
      if (url === `${BOX_ORIGIN}/box/${siteId}/${HASH}`) {
        const headers = boxDocumentHeaders(['example.invalid'], 'editor.invalid');
        headers['Content-Security-Policy'] = headers['Content-Security-Policy'].replace(/frame-ancestors [^;]+/, `frame-ancestors ${origin}`);
        return route.fulfill({ status: 200, headers, body: composeBoxDocument(DOCUMENT) });
      }
      return route.fulfill({ status: 204 });
    });
  });
  afterEach(async () => {
    await context?.close();
  });

  const island = () => page.locator('[data-fc-custom-code-state]');

  it('frames the block through the broker, which the page fetched once, and the frame writes the state', async () => {
    const response = await page.goto(`${origin}/block`);
    expect(response?.status()).toBe(200);
    expect(response?.headers()['content-security-policy']).toContain(`${BOX_ORIGIN}/box/`);

    await expect.poll(() => island().getAttribute('data-fc-custom-code-state'), { timeout: 15_000 }).toBe('shown');
    await expect.poll(() => page.locator('[data-t="count"]').textContent(), { timeout: 5_000 }).toBe('7');

    const frame = island().locator('iframe');
    expect(await frame.count()).toBe(1);
    const attrs = await frame.evaluate((el) => Object.fromEntries([...el.attributes].map((a) => [a.name, a.value])));
    expect(attrs).toMatchObject({
      src: `${BOX_ORIGIN}/box/${siteId}/${HASH}`,
      sandbox: 'allow-scripts',
      referrerpolicy: 'no-referrer',
      loading: 'lazy',
      allow: '',
      title: 'Counter',
    });
    // The fallback is React's, and gone once the block is shown; the frame stays.
    expect(await page.getByText('Fallback').count()).toBe(0);
    expect(boxRequests).toEqual([`${BOX_ORIGIN}/box/${siteId}/${HASH}`]);

    await page.waitForLoadState('networkidle');
    const bodies = await Promise.all(scripts);
    expect(bodies.filter((body) => body.includes(BROKER_MARK))).toHaveLength(1);
  });

  it("carries the site's frame policy in <head>, where the browser obeys it: another site's box path is refused", async () => {
    await page.goto(`${origin}/block`);
    await expect.poll(() => island().getAttribute('data-fc-custom-code-state'), { timeout: 15_000 }).toBe('shown');
    const metas = await page.evaluate(() =>
      [...document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]')].map((meta) => ({
        inHead: meta.parentElement === document.head,
        content: meta.getAttribute('content'),
      })),
    );
    expect(metas).toEqual([{ inHead: true, content: `frame-src ${BOX_ORIGIN}/box/${siteId}/` }]);

    // The header admits every site's box path; the page's own policy narrows it to this site's. A frame
    // of another site's path is never requested, while one of this site's path, appended the same way
    // after it, is: so the missing request is the policy, not a frame that had not loaded yet.
    const stranger = `${BOX_ORIGIN}/box/${randomUUID()}/${STRANGER}`;
    const control = `${BOX_ORIGIN}/box/${siteId}/${STRANGER}`;
    await page.evaluate((sources) => {
      for (const src of sources) {
        const frame = document.createElement('iframe');
        frame.src = src;
        document.body.append(frame);
      }
    }, [stranger, control]);
    await expect.poll(() => boxRequests.includes(control), { timeout: 5_000 }).toBe(true);
    expect(boxRequests).not.toContain(stranger);
  });
});

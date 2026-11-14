// The Head panel in the real editor (docs/plans/2026-11-02-theme-and-head.md, slice H3): the real
// EditorApp in Chromium and WebKit, its controls driven by a pointer and a keyboard, then the
// project it holds published through the repository and the raw HTML a visitor gets read back.
// (The publish route needs a signed-in session, so the publish goes through the repository, as
// the other behaviour specs do; the editor itself is the real one with its server edge stubbed.)
//
// Forward: a verification code added in well under a minute; one of each kind. Backtrack: invalid
// structured data keeps the last valid one and says why; undo through the editor's own undo.
// Resume: a half-typed structured data is gone when the dialog is closed and opened again; the
// settings dialog's Save does not erase the list. Re-entry: a refused item stored by hand shows as
// refused and is deleted.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, webkit, type Browser, type BrowserType, type Locator, type Page } from 'playwright';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { getPrismaClient } from '@/server/db';
import { getSiteRepository, type TenantScope } from '@/server/sites';
import { bundleEditor, openEditor } from '../score/lib/canvasBundle';

const SCOPE: TenantScope = {
  workspaceId: `ws_headpanel_${randomUUID().slice(0, 8)}`,
  tenantGroupId: '018f9c10-0000-7000-8000-0000000051c7',
};
const ENGINES: [string, BrowserType][] = [['chromium', chromium], ['webkit', webkit]];

interface Probe {
  __editor: { projectJson: () => string; undo: () => void; addPage: (title: string) => string; setSiteHead: (items: unknown[]) => void };
}
type Stored = { siteSettings?: { head?: Array<Record<string, unknown>> }; pages: Record<string, { slug: string; metadata: { head?: Array<Record<string, unknown>>; ogType?: string } }> };

/** Text and state read with a poll, since vitest's expect has no locator matchers. */
const textOf = (locator: Locator) => () => locator.textContent();
const disabled = (locator: Locator) => () => locator.isDisabled();
const valueOf = (locator: Locator) => () => locator.inputValue();
const project = (page: Page): Promise<Stored> => page.evaluate(() => JSON.parse((window as unknown as Probe).__editor.projectJson()));

/** Types into the open Head dialog's new-item form and presses Add. */
async function addMeta(page: Page, name: string, content: string) {
  const form = page.getByTestId('head-new');
  await form.getByLabel('Name').fill(name);
  await form.getByLabel('Content').fill(content);
  await form.getByRole('button', { name: 'Add item' }).click();
}

let bundle: string;
beforeAll(async () => {
  bundle = await bundleEditor();
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

  async function editor() {
    const { page, crashes } = await openEditor(browser, bundle);
    page.setDefaultTimeout(8000);
    return { page, crashes };
  }

  /** The new-item form stays open after an add; a list that began with items opens it with the button. */
  async function ensureNewForm(page: Page) {
    if ((await page.getByTestId('head-new').count()) === 0) await page.getByRole('button', { name: 'Add head item' }).click();
  }

  async function openSiteHead(page: Page) {
    await page.getByRole('button', { name: 'Site settings' }).click();
    await page.getByTestId('site-head-section-open').click();
    await page.getByTestId('head-dialog').waitFor();
  }

  it('adds a verification code in under a minute, and the saved Site settings keep it', async () => {
    const { page, crashes } = await editor();
    try {
      const started = Date.now();
      await openSiteHead(page);
      await addMeta(page, 'google-site-verification', 'abc123');
      expect(Date.now() - started).toBeLessThan(60_000);
      expect((await project(page)).siteSettings?.head).toEqual([{ kind: 'meta', name: 'google-site-verification', content: 'abc123' }]);
      await expect.poll(textOf(page.getByTestId('head-item').getByTestId('head-status'))).toBe('Published');
      // Close the head dialog, change another setting in the open one and Save: the list stays.
      await page.keyboard.press('Escape');
      await page.getByTestId('site-settings-dialog').waitFor();
      await page.getByTestId('site-head-section-summary').waitFor();
      expect(await page.getByTestId('site-head-section-summary').textContent()).toBe('1 item');
      await page.getByLabel('Site name').fill('Bakery');
      await page.getByRole('button', { name: 'Save' }).click();
      await page.getByTestId('site-settings-dialog').waitFor({ state: 'detached' });
      const saved = await project(page);
      expect(saved.siteSettings?.head).toHaveLength(1);
      expect(saved.siteSettings).toMatchObject({ siteName: 'Bakery' });
      expect(crashes).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('refuses an owned name in the words of the field to use, and a half-typed structured data is a draft', async () => {
    const { page } = await editor();
    try {
      await openSiteHead(page);
      const form = page.getByTestId('head-new');
      await form.getByLabel('Name').fill('description');
      await form.getByLabel('Content').fill('x');
      await expect.poll(textOf(form.getByTestId('head-message'))).toContain("page's Description");
      await expect.poll(disabled(form.getByRole('button', { name: 'Add item' }))).toBe(true);

      await form.getByLabel('Kind').selectOption('jsonld');
      await form.getByLabel('JSON-LD').fill('{"@context": "https://sch');
      await expect.poll(textOf(form.getByTestId('head-message'))).toContain('Not valid JSON');
      await expect.poll(disabled(form.getByRole('button', { name: 'Add item' }))).toBe(true);
      expect((await project(page)).siteSettings?.head ?? []).toEqual([]);
      // Close and open again: the draft is gone and nothing was stored.
      await page.keyboard.press('Escape');
      await page.getByTestId('site-head-section-open').click();
      await expect.poll(textOf(page.getByTestId('head-count'))).toBe('0 of 20 items on the site.');
      await expect.poll(valueOf(page.getByTestId('head-new').getByLabel('Kind'))).toBe('meta');
      expect((await project(page)).siteSettings?.head ?? []).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('invalid structured data keeps the last valid one and shows why; undo takes an item back', async () => {
    const { page } = await editor();
    try {
      await openSiteHead(page);
      const form = page.getByTestId('head-new');
      await form.getByLabel('Kind').selectOption('jsonld');
      const valid = '{"@context":"https://schema.org","@type":"Organization","name":"Bakery"}';
      await form.getByLabel('JSON-LD').fill(valid);
      await form.getByRole('button', { name: 'Add item' }).click();
      const row = page.getByTestId('head-row');
      await row.getByLabel('JSON-LD').fill('{"@context":"https://schema.org","@type":');
      await row.getByLabel('JSON-LD').blur();
      await expect.poll(textOf(row.getByTestId('head-message'))).toContain('last saved version is kept');
      expect((await project(page)).siteSettings?.head).toEqual([{ kind: 'jsonld', data: JSON.parse(valid) }]);

      await ensureNewForm(page);
      await addMeta(page, 'author', 'Marlin');
      expect((await project(page)).siteSettings?.head).toHaveLength(2);
      await page.evaluate(() => (window as unknown as Probe).__editor.undo());
      expect((await project(page)).siteSettings?.head).toHaveLength(1);
    } finally {
      await page.close();
    }
  });

  it('shows a refused stored item as refused, keeps its neighbours, and deletes it', async () => {
    const { page } = await editor();
    try {
      // A list written by hand, as an older build or an edit of the JSON could leave it.
      await page.evaluate(() =>
        (window as unknown as Probe).__editor.setSiteHead([
          { kind: 'meta', name: 'viewport', content: 'width=1' },
          { kind: 'meta', name: 'author', content: 'ok' },
        ]),
      );
      await page.getByRole('button', { name: 'Site settings' }).click();
      await page.getByTestId('site-head-section-summary').waitFor();
      expect(await page.getByTestId('site-head-section-summary').textContent()).toBe('2 items, 1 not published');
      await page.getByTestId('site-head-section-open').click();
      const rows = page.getByTestId('head-item');
      expect(await rows.count()).toBe(2);
      expect(await rows.nth(0).getByTestId('head-status').textContent()).toMatch(/^Refused, not published: .*viewport/);
      expect(await rows.nth(1).getByTestId('head-status').textContent()).toBe('Published');
      await page.getByRole('button', { name: 'Delete head item 1' }).click();
      expect((await project(page)).siteSettings?.head).toEqual([{ kind: 'meta', name: 'author', content: 'ok' }]);
      expect(await page.getByTestId('head-item').count()).toBe(1);
    } finally {
      await page.close();
    }
  });

  it('adds one of each kind on a page, publishes, and the head holds them', async () => {
    const { page } = await editor();
    try {
      await page.getByRole('button', { name: /Page settings for/ }).first().click({ force: true });
      await page.getByTestId('page-head-section-open').click();
      await page.getByTestId('head-dialog').waitFor();
      await page.getByLabel('Content type').selectOption('article');
      const form = () => page.getByTestId('head-new');
      await addMeta(page, 'author', 'Marlin');
      await ensureNewForm(page);
      await form().getByLabel('Kind').selectOption('property');
      await form().getByLabel('Property').fill('article:tag');
      await form().getByLabel('Content').fill('news');
      await form().getByRole('button', { name: 'Add item' }).click();
      await ensureNewForm(page);
      await form().getByLabel('Kind').selectOption('link');
      await form().getByLabel('Relation').selectOption('me');
      await form().getByLabel('Address').fill('https://example.org/me');
      await form().getByRole('button', { name: 'Add item' }).click();
      await ensureNewForm(page);
      await form().getByLabel('Kind').selectOption('jsonld');
      await form().getByLabel('JSON-LD').fill('{"@context":"https://schema.org","@type":"Organization","name":"Bakery"}');
      await form().getByRole('button', { name: 'Add item' }).click();
      await expect.poll(textOf(page.getByTestId('head-count'))).toBe('4 of 30 items on the page.');

      // Publish what the editor holds, then read the raw HTML a visitor gets.
      const held = (await page.evaluate(() => (window as unknown as Probe).__editor.projectJson())) as string;
      const siteId = randomUUID();
      const repo = getSiteRepository();
      const doc = { ...JSON.parse(held), id: siteId } as never;
      const saved = await repo.saveProject(SCOPE, doc);
      await repo.publishProject(SCOPE, doc, { expectedVersion: saved.version });
      const { subdomain } = await repo.ensureSiteDomain(SCOPE, siteId);
      const res = await fetch(`http://${subdomain}.sites.localhost:${process.env.BEHAVIOUR_PORT}/`, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; bingbot/2.0)' } });
      const html = await res.text();
      const head = html.slice(0, html.indexOf('</head>'));
      expect(head).toContain('<meta name="author" content="Marlin"/>');
      expect(head).toContain('<meta property="article:tag" content="news"/>');
      expect(head).toContain('<link rel="me" href="https://example.org/me"/>');
      expect(head).toContain('<meta property="og:type" content="article"/>');
      const ld = /<script type="application\/ld\+json" data-head-jsonld="">([\s\S]*?)<\/script>/.exec(html);
      expect(JSON.parse(ld![1])).toEqual({ '@context': 'https://schema.org', '@type': 'Organization', name: 'Bakery' });
    } finally {
      await page.close();
    }
  });
});

// The editor of the real production build, which the server answers on its editor host (the
// unsaved demo project, no sign-in). The browser cannot resolve that host, so a route hands each
// request to the server with the host header set. This is the product's own stylesheet, scripts
// and dialogs, not the harness's: it is what shows that a dialog sits where it should in WebKit.
const PORT = () => Number(process.env.BEHAVIOUR_PORT);
const EDITOR_HOST = 'editor.invalid';

describe.each(ENGINES)('on the real build\'s editor, in %s', (_name, engine) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await engine.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });

  async function realEditor(): Promise<Page> {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    await context.route(`http://${EDITOR_HOST}:${PORT()}/**`, async (route) => {
      const url = new URL(route.request().url());
      const answer = await new Promise<{ status: number; headers: http.IncomingHttpHeaders; data: Buffer }>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: PORT(), path: url.pathname + url.search, method: route.request().method(), headers: { host: EDITOR_HOST } }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, data: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
        req.end();
      });
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(answer.headers)) {
        if (typeof value === 'string' && !['content-length', 'transfer-encoding', 'content-encoding', 'connection'].includes(key)) headers[key] = value;
      }
      // A redirect (to the sign-in page) cannot be fulfilled; the demo editor asks for none it needs.
      if (answer.status >= 300 && answer.status < 400) return route.abort();
      return route.fulfill({ status: answer.status, headers, body: answer.data });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(`http://${EDITOR_HOST}:${PORT()}/`);
    await page.getByRole('button', { name: 'Site settings' }).first().waitFor();
    return page;
  }

  /** Every part of the element is inside the window: a pointer can reach it. */
  const inWindow = (page: Page, testId: string) =>
    page.evaluate((id) => {
      const r = (document.querySelector(`[data-testid="${id}"]`) as HTMLElement).getBoundingClientRect();
      return r.x >= 0 && r.y >= 0 && r.x + r.width <= innerWidth && r.y + r.height <= innerHeight;
    }, testId);

  it('places the Site settings and Head dialogs inside the window, and adds an item through them', async () => {
    const page = await realEditor();
    try {
      await page.getByRole('button', { name: 'Site settings' }).first().click();
      await page.getByTestId('site-settings-dialog').waitFor();
      await expect.poll(() => inWindow(page, 'site-settings-dialog')).toBe(true);
      await page.getByTestId('site-head-section-open').click();
      await page.getByTestId('head-dialog').waitFor();
      await expect.poll(() => inWindow(page, 'head-dialog')).toBe(true);
      await addMeta(page, 'google-site-verification', 'abc123');
      await expect.poll(textOf(page.getByTestId('head-item').getByTestId('head-status'))).toBe('Published');
      await page.keyboard.press('Escape');
      await page.getByTestId('site-head-section-summary').waitFor();
      expect(await page.getByTestId('site-head-section-summary').textContent()).toBe('1 item');
      // Save reaches the project and the list stays.
      await page.getByRole('button', { name: 'Save' }).click();
      await page.getByTestId('site-settings-dialog').waitFor({ state: 'detached' });
      await page.getByRole('button', { name: 'Site settings' }).first().click();
      await page.getByTestId('site-head-section-summary').waitFor();
      expect(await page.getByTestId('site-head-section-summary').textContent()).toBe('1 item');
    } finally {
      await page.context().close();
    }
  });

  it('opens the page\'s Head dialog from Page settings, inside the window, and refuses an owned name', async () => {
    const page = await realEditor();
    try {
      await page.getByRole('button', { name: /Page settings for/ }).first().click({ force: true });
      await page.getByTestId('page-head-section-open').click();
      await page.getByTestId('head-dialog').waitFor();
      await expect.poll(() => inWindow(page, 'head-dialog')).toBe(true);
      const form = page.getByTestId('head-new');
      await form.getByLabel('Name').fill('og:title');
      await form.getByLabel('Content').fill('x');
      await expect.poll(textOf(form.getByTestId('head-message'))).toContain('Social title');
      await expect.poll(disabled(form.getByRole('button', { name: 'Add item' }))).toBe(true);
    } finally {
      await page.context().close();
    }
  });
});

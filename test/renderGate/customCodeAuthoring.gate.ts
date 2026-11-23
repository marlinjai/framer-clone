// Writing a custom code block end to end in real browsers (slice C4 of
// docs/plans/2026-11-02-sandboxed-custom-code.md): the real editor, bundled from
// customCodeAuthoring.entry.tsx, opened on a server project. A person adds the block from the
// Components panel, gives it a title, types its code with the keyboard into the CodeMirror
// field, and saves. The page answers through Playwright routes that stand in for the server
// with its contract: `/api/projects/save` keeps the page and answers a version, and the custom
// code route refuses a block the saved page does not hold (`node_not_saved`, D108), computes the
// hash with the real `customCodeHash`, and answers 201. The block must then name exactly that
// hash, and Layers must mark it. One refusal from the route reaches the person as its sentence,
// and the block stays as it was. Chromium and WebKit; every case ends on an expectation.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSnapshot } from 'mobx-state-tree';
import { chromium, webkit, type Browser, type BrowserType, type Page } from 'playwright';
import { createRootStore } from '@/stores/RootStore';
import { customCodeHash, type CustomCodeDeclaration } from '@/lib/customCode/contract';
import { bundleEditor, openBundle } from '../score/lib/canvasBundle';

const STATUS = {
  enabled: true, branch: false, canManage: true, serving: true, usedBytes: 0,
  limits: { blockBytes: 262144, siteBytes: 1048576, blocksPerPage: 4, writesPerHour: 30 },
};
const RATE_LIMITED = 'This site saved new code 30 times in the last hour, the most allowed. Try again in 50 minutes.';

let bundle = '';
let snapshot: Record<string, unknown>;

beforeAll(async () => {
  bundle = await bundleEditor('test/renderGate/customCodeAuthoring.entry.tsx', 'custom-code-authoring-bundle');
  const store = createRootStore();
  store.projectStore.createProject('Custom code gate');
  const project = store.projectStore.findProjectByTitle('Custom code gate')!;
  snapshot = JSON.parse(JSON.stringify(getSnapshot(project))) as Record<string, unknown>;
}, 300_000);

interface Server {
  saves: Record<string, unknown>[];
  posts: Record<string, unknown>[];
  refuse: boolean;
}

/** True when the saved project holds a node of this id on any page. */
function holds(saved: Record<string, unknown> | undefined, nodeId: string): boolean {
  return !!saved && JSON.stringify(saved).includes(`"id":"${nodeId}"`);
}

async function open(browser: Browser, server: Server): Promise<Page> {
  const { page, crashes } = await openBundle(browser, bundle, {}, async (p) => {
    let version = 1;
    // The open editor's live stream (another tab's saves): open, and quiet.
    await p.route('**/api/projects/*/events?*', (route) => route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': quiet\n\n' }));
    await p.route('**/api/projects/save', async (route) => {
      const body = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
      server.saves.push(body);
      version += 1;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ version }) });
    });
    await p.route('**/api/projects/*/custom-code**', async (route) => {
      const request = route.request();
      if (request.method() === 'GET') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(STATUS) });
        return;
      }
      const body = JSON.parse(request.postData() ?? '{}') as { nodeId: string; document: string; declaration: CustomCodeDeclaration };
      server.posts.push(body);
      const answer = (status: number, json: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) });
      if (server.refuse) return answer(429, { error: { code: 'rate_limited', message: RATE_LIMITED } });
      const saved = server.saves.at(-1);
      if (!holds(saved, body.nodeId)) {
        return answer(409, { error: { code: 'node_not_saved', message: 'The saved page does not hold this block yet.' } });
      }
      return answer(201, { sha256: await customCodeHash(body.document, body.declaration), created: true });
    });
  // The editor runs on https, where the panel's hash (Web Crypto) is available.
  }, 'https://canvas-probe.local');
  page.setDefaultTimeout(20_000);
  await page.evaluate((s) => (window as unknown as { __mount(s: unknown, v: number): void }).__mount(s, 1), snapshot);
  await page.locator('[data-ground]').first().waitFor({ state: 'attached' });
  (page as unknown as { __crashes: string[] }).__crashes = crashes;
  return page;
}

/** Adds a block from the Components panel and waits for its section with the rich field. */
async function insertBlock(page: Page): Promise<string> {
  await page.getByRole('tab', { name: /Components/i }).first().click();
  await page.getByTestId('insert-custom-code').click();
  const section = page.getByTestId('custom-code-section');
  await section.waitFor();
  await section.locator('[data-custom-code-editor="rich"] .cm-content').waitFor();
  const id = await page.evaluate(() => (window as unknown as { __selectedId(): string | undefined }).__selectedId());
  expect(id).toMatch(/^custom-code-/);
  return id!;
}

async function write(page: Page, title: string, code: string) {
  const section = page.getByTestId('custom-code-section');
  await section.getByLabel('Title of the custom code block').fill(title);
  const field = section.locator('.cm-content');
  await expect.poll(() => field.getAttribute('aria-label')).toBe(`Code of ${title}`);
  await field.click();
  await page.keyboard.type(code);
}

const customCodeOf = (page: Page, id: string) =>
  page.evaluate((nodeId) => (window as unknown as { __customCodeOf(id: string): unknown }).__customCodeOf(nodeId), id);

describe.each([
  ['chromium', chromium],
  ['webkit', webkit],
] as [string, BrowserType][])('writing a custom code block in %s', (_name, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch();
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
  });

  it('inserts, types, saves the page and then the code, and the block names the returned hash', async () => {
    const server: Server = { saves: [], posts: [], refuse: false };
    const page = await open(browser, server);
    const id = await insertBlock(page);
    expect(await customCodeOf(page, id)).toBeNull();
    await write(page, 'Clock', 'tick');
    const section = page.getByTestId('custom-code-section');
    await section.getByRole('button', { name: 'Save code' }).click();
    await expect.poll(() => customCodeOf(page, id), { timeout: 15_000 }).not.toBeNull();

    // The page was saved with the block before the code was posted (D108).
    expect(server.posts).toHaveLength(1);
    expect(holds(server.saves.at(-1), id)).toBe(true);
    const post = server.posts[0] as { nodeId: string; title: string; document: string; declaration: CustomCodeDeclaration };
    expect(post).toMatchObject({ nodeId: id, title: 'Clock', document: 'tick' });
    const sha256 = await customCodeHash('tick', post.declaration);
    expect(await customCodeOf(page, id)).toEqual({ sha256, title: 'Clock' });
    await expect.poll(() => page.locator('[data-custom-code-announcement]').textContent()).toBe('Code saved. Publish the page to put it live.');

    // Layers marks the block as one with code.
    await page.getByRole('tab', { name: /Layers/i }).first().click();
    const badge = page.locator(`[data-layer-row="${id}"] [data-layer-custom-code-badge]`).first();
    await expect.poll(() => badge.textContent()).toBe('Custom code block: Code');
    expect((page as unknown as { __crashes: string[] }).__crashes).toEqual([]);
    await page.close();
  }, 180_000);

  it('shows the route\'s refusal to the person, in an alert, and leaves the block as it was', async () => {
    const server: Server = { saves: [], posts: [], refuse: true };
    const page = await open(browser, server);
    const id = await insertBlock(page);
    await write(page, 'Clock', 'tick');
    const section = page.getByTestId('custom-code-section');
    await section.getByRole('button', { name: 'Save code' }).click();
    const alert = section.locator('[data-custom-code-problem]');
    await expect.poll(() => alert.textContent(), { timeout: 15_000 }).toBe(RATE_LIMITED);
    expect(await alert.getAttribute('role')).toBe('alert');
    expect(server.posts).toHaveLength(1);
    expect(await customCodeOf(page, id)).toBeNull();
    // The draft is kept for the next try.
    expect(await section.locator('.cm-content').textContent()).toBe('tick');
    await page.close();
  }, 180_000);
});

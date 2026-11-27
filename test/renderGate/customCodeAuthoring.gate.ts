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
import { selectEngines, selection } from './selection';
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
  /** The hashes the editor read back from the blob route. */
  reads?: string[];
  posts: Record<string, unknown>[];
  refuse: boolean;
  /** While set, the custom code post waits for it. */
  hold?: Promise<void>;
}

/** True when the saved project holds a node of this id on any page. */
function holds(saved: Record<string, unknown> | undefined, nodeId: string): boolean {
  return !!saved && JSON.stringify(saved).includes(`"id":"${nodeId}"`);
}

async function open(browser: Browser, server: Server): Promise<Page> {
  const { page, crashes } = await openBundle(browser, bundle, {}, async (p) => {
    let version = 1;
    // What the route stored, by hash, read back as the blob read answers it.
    const blobs = new Map<string, { title: string; document: string; declaration: CustomCodeDeclaration }>();
    // The open editor's live stream (another tab's saves): open, and quiet.
    await p.route('**/api/projects/*/events?*', (route) => route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': quiet\n\n' }));
    // The stream above ends with its answer, so after a reconnect the editor's live sync falls
    // back to polling the document. This stands in for the real route
    // (src/app/api/projects/[projectId]/document/route.ts): GET only, answering the stored version
    // with its snapshot, the last page this test's save route kept. The real route answers 304
    // when If-None-Match already names that version; Playwright cannot fulfill a 304, so that case
    // gets the same version with 200, which live sync drops as nothing newer (take's version check).
    // Before this route the catch-all answered 200 with `{}`, which live sync took for a newer
    // copy without a snapshot. On a loaded runner the poll came while the inserted block was
    // unsaved, the copy was held, and the conflict sentence read its pages during render, which
    // took the whole editor down (the WebKit timeout on main after #459, the slice that added
    // this gate).
    await p.route('**/api/projects/*/document', async (route) => {
      if (route.request().method() !== 'GET') return route.fulfill({ status: 405 });
      const kept = server.saves.at(-1)?.project ?? snapshot;
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { etag: `"${version}"` }, body: JSON.stringify({ version, snapshot: kept }) });
    });
    await p.route('**/api/projects/save', async (route) => {
      const body = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
      server.saves.push(body);
      version += 1;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ version }) });
    });
    await p.route('**/api/projects/*/custom-code**', async (route) => {
      const request = route.request();
      if (request.method() === 'GET') {
        const sha256 = new URL(request.url()).searchParams.get('sha256');
        if (sha256) (server.reads ??= []).push(sha256);
        const blob = sha256 ? blobs.get(sha256) : undefined;
        const json = !sha256 ? STATUS : blob ? { sha256, ...blob, createdAt: '2026-11-23T00:00:00.000Z', blocked: false } : null;
        await route.fulfill(json
          ? { status: 200, contentType: 'application/json', body: JSON.stringify(json) }
          : { status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'blob_not_found', message: 'No such code.' } }) });
        return;
      }
      const body = JSON.parse(request.postData() ?? '{}') as { nodeId: string; title: string; document: string; declaration: CustomCodeDeclaration };
      server.posts.push(body);
      if (server.hold) await server.hold;
      const answer = (status: number, json: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) });
      if (server.refuse) return answer(429, { error: { code: 'rate_limited', message: RATE_LIMITED } });
      const saved = server.saves.at(-1);
      if (!holds(saved, body.nodeId)) {
        return answer(409, { error: { code: 'node_not_saved', message: 'The saved page does not hold this block yet.' } });
      }
      const sha256 = await customCodeHash(body.document, body.declaration);
      blobs.set(sha256, { title: body.title, document: body.document, declaration: body.declaration });
      return answer(201, { sha256, created: true });
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

describe.each(selectEngines([
  ['chromium', chromium],
  ['webkit', webkit],
] as [string, BrowserType][], selection))('writing a custom code block in %s', (_name, type) => {
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

    // A title-only change (D105) is written on the node, and the panel shows the code it already had: no read back.
    await section.getByLabel('Title of the custom code block').fill('Clock face');
    await section.getByRole('button', { name: 'Save code' }).click();
    await expect.poll(() => customCodeOf(page, id)).toEqual({ sha256, title: 'Clock face' });
    await expect.poll(() => section.locator('[data-custom-code-notice]').textContent()).toBe('Title saved.');
    expect(await section.locator('.cm-content').textContent()).toBe('tick');
    expect(server.reads ?? []).toEqual([]);

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
    expect((page as unknown as { __crashes: string[] }).__crashes).toEqual([]);
    await page.close();
  }, 180_000);

  it('takes no typing in the real code field while a save runs, also after selecting away and back', async () => {
    let release = () => {};
    const server: Server = { saves: [], posts: [], refuse: false, hold: new Promise<void>((resolve) => { release = resolve; }) };
    const page = await open(browser, server);
    const id = await insertBlock(page);
    await write(page, 'Clock', 'tick');
    const section = page.getByTestId('custom-code-section');
    await section.getByRole('button', { name: 'Save code' }).click();
    await expect.poll(() => server.posts.length, { timeout: 15_000 }).toBe(1);
    const field = section.locator('.cm-content');
    await expect.poll(() => field.getAttribute('aria-readonly')).toBe('true');
    await field.click();
    await page.keyboard.type(' tock');
    expect(await field.textContent()).toBe('tick');

    // Away and back while the post is still held (review 2 of #459, M1): still locked.
    await page.evaluate(() => (window as unknown as { __select(id: string): void }).__select('root'));
    await section.waitFor({ state: 'detached' });
    await page.evaluate((nodeId) => (window as unknown as { __select(id: string): void }).__select(nodeId), id);
    await section.locator('[data-custom-code-editor="rich"] .cm-content').waitFor();
    await expect.poll(() => field.getAttribute('aria-readonly')).toBe('true');
    expect(await section.getByRole('button', { name: 'Saving code…' }).isDisabled()).toBe(true);
    await field.click();
    await page.keyboard.type(' tock');
    expect(await field.textContent()).toBe('tick');

    // Every text the field shows from here on. A poll reads it at one moment only, so a field that
    // goes empty for a few milliseconds as the save lands would pass or fail by chance. This section
    // is not the one that pressed Save, so it has the code from the save's record or not at all.
    await page.evaluate(() => {
      const shown: string[] = ((window as unknown as { __shown: string[] }).__shown = []);
      new MutationObserver(() => {
        const text = document.querySelector('[data-testid="custom-code-section"] .cm-content')?.textContent;
        if (typeof text === 'string' && shown.at(-1) !== text) shown.push(text);
      }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    });
    release();
    await expect.poll(() => customCodeOf(page, id), { timeout: 15_000 }).not.toBeNull();
    await expect.poll(() => section.locator('[data-custom-code-notice]').textContent()).toBe('Code saved. Publish the page to put it live.');
    await expect.poll(() => field.getAttribute('aria-readonly')).toBeNull();
    expect(await field.textContent()).toBe('tick');
    // It never read the code back: a freshly inserted block has no stored code, so any read is a read back.
    expect(server.reads ?? [], 'blob reads after its own save').toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { __shown: string[] }).__shown.filter((text) => text !== 'tick'))).toEqual([]);
    expect(await page.locator('[data-custom-code-announcement]').textContent()).toBe('Code saved. Publish the page to put it live.');
    expect(server.posts).toHaveLength(1);
    expect((page as unknown as { __crashes: string[] }).__crashes).toEqual([]);
    await page.close();
  }, 180_000);
});

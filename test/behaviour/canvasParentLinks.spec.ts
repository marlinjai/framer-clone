// A page stored without parent links, on the mounted editor in real Chromium and WebKit
// with a real mouse. Reported on a private draft written by a script: a click on any
// element selected the whole desktop frame. No node had an `onPointerDown`, so the
// frame's drag source took the press, captured the pointer, and the click went to it.
// jsdom has no pointer capture, so only a browser shows this.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, webkit, type Browser, type BrowserType, type Page } from 'playwright';
import { bundleEditor, openEditor, toSnapshot } from '../score/lib/canvasBundle';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';

const ENGINES: [string, BrowserType][] = [['chromium', chromium], ['webkit', webkit]];

const node = (id: string, type: string, props: Record<string, unknown> = {}, ...children: ComponentNode[]): ComponentNode => ({ id, type, props, children });

const tree = node(
  'wrap',
  'div',
  { style: { padding: '40px' } },
  node('section', 'section', { style: { padding: '24px' } }, node('title', 'h1', { children: 'A heading', style: { width: 'fit-content' } }), node('copy', 'p', { children: 'Some copy', style: { width: 'fit-content', marginTop: '80px' } })),
);

/** As a script posts it to the save route: no node names its parent. */
const unlinked = (snapshot: Record<string, unknown>): Record<string, unknown> => {
  const { parentId: _parentId, children, ...rest } = snapshot;
  void _parentId;
  return { ...rest, children: (children as Record<string, unknown>[]).map(unlinked) };
};

interface EditorWindow {
  __placeTree: (snapshot: unknown, options: { allFrames?: boolean }) => void;
  __editor: { selectedId: () => string | undefined; projectJson: () => string };
}

const selected = (page: Page) => page.evaluate(() => (window as unknown as EditorWindow).__editor.selectedId());
const frames = (page: Page) => page.evaluate(() => {
  const project = JSON.parse((window as unknown as EditorWindow).__editor.projectJson()) as { pages: Record<string, { canvasNodes: Record<string, { canvasX?: number; canvasY?: number }> }> };
  return Object.values(project.pages).flatMap((p) => Object.values(p.canvasNodes).map((n) => [n.canvasX, n.canvasY]));
});

let bundle: string;

beforeAll(async () => {
  bundle = await bundleEditor();
}, 120_000);

describe.each(ENGINES)('in %s', (_name, engine) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await engine.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('a click selects the element under the pointer, and a drag on it leaves the frames where they are', async () => {
    const { page, crashes } = await openEditor(browser, bundle);
    await page.evaluate((snapshot) => (window as unknown as EditorWindow).__placeTree(snapshot, { allFrames: true }), unlinked(toSnapshot(tree)));
    const first = (id: string) => page.locator(`[data-viewport-content-id] [data-inner-component-id="${id}"]`).first();

    for (const id of ['title', 'copy']) {
      await first(id).click();
      await expect.poll(() => selected(page)).toBe(id);
    }

    const before = await frames(page);
    const box = (await first('title').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 90, { steps: 8 });
    await page.mouse.up();
    expect(await frames(page)).toEqual(before);
    expect(crashes).toEqual([]);
    await page.close();
  });
});
// ci-replay touch

// props.rules on the mounted editor: the real EditorApp in real Chromium with stored
// rules on its canvas (lib/canvasBundle.ts). The matrix can only say a rule reached
// the canvas sheet. What matters is what that sheet does to an editor sharing the
// document with it: a stored rule must never stop a node being selected or edited,
// the real pointer does nothing, and a previewed state looks as it does when published.
// It counts for no row, on purpose: a failure stops the score, it does not lower it.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { HOVER_GATE } from '@/lib/rules/states';
import { bundleEditor, mountOnCanvas, openEditor, placeTree, type MountOptions } from './lib/canvasBundle';
import { publishedDocument, renderPublished } from './lib/published';
import { FIXTURES } from './corpus/fixtures';

interface EditorHooks {
  frames: () => { breakpointId: string; label: string }[];
  setPreviewRule: (preview: { componentId: string; ruleId: string } | null) => void;
  setPreviewOpen: (open: boolean) => void;
  setRuleStyle: (componentId: string, ruleId: string, style: Record<string, unknown>) => void;
  setStyle: (componentId: string, style: Record<string, unknown>) => void;
  toggleLock: (componentId: string) => void;
  selectedId: () => string | undefined;
  editingId: () => string | undefined;
  propsOf: (componentId: string) => Record<string, unknown> | undefined;
}

type Rule = Record<string, unknown>;

const NORMAL = 'rgb(1, 1, 1)';
const RULE = 'rgb(9, 9, 9)';
const BOX = { width: '160px', height: '80px', background: 'rgb(200, 200, 200)' };

const node = (id: string, props: Record<string, unknown>, ...children: ComponentNode[]): ComponentNode => ({
  id,
  type: 'div',
  props: props as ComponentNode['props'],
  children,
});

/** Parents a node, so a click that misses it lands on something that says so. */
const pageOf = (...children: ComponentNode[]): ComponentNode => node('page', { style: { padding: '40px', minHeight: '600px' } }, ...children);

const preview = (page: Page, componentId: string | null, ruleId = ''): Promise<void> =>
  page.evaluate(([id, rule]) => (window as unknown as { __editor: EditorHooks }).__editor.setPreviewRule(id ? { componentId: id, ruleId: rule } : null), [componentId, ruleId] as const);

const hook = <T,>(page: Page, name: 'selectedId' | 'editingId'): Promise<T> =>
  page.evaluate((key) => (window as unknown as { __editor: EditorHooks }).__editor[key]() as T, name);

const framesOf = (page: Page) => page.evaluate(() => (window as unknown as { __editor: EditorHooks }).__editor.frames());

/** The copy of a node in the frame of this breakpoint, or in the only frame. */
const copy = (page: Page, id: string, breakpointId?: string) =>
  page.locator(`${breakpointId ? `[data-breakpoint-id="${breakpointId}"] ` : ''}[data-inner-component-id="${id}"]`).first();

const computed = (page: Page, id: string, property: string, breakpointId?: string, pseudo?: string): Promise<string> =>
  copy(page, id, breakpointId).evaluate(
    (el, [name, pseudoElement]) => getComputedStyle(el, pseudoElement || undefined).getPropertyValue(name as string),
    [property, pseudo] as const,
  );

/** The centre of a node as the mouse reaches it. */
const centre = async (page: Page, id: string): Promise<{ x: number; y: number }> => {
  const box = await copy(page, id).boundingBox();
  if (!box) throw new Error(`${id} has no box on the canvas`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

/** A real click on the canvas: what the person does, through what the browser hit-tests. */
const click = async (page: Page, id: string): Promise<void> => {
  const { x, y } = await centre(page, id);
  await page.mouse.click(x, y);
};

describe('stored rules on the mounted editor', () => {
  let browser: Browser;
  let bundle: string;

  const mounted = (tree: ComponentNode, options?: MountOptions) => mountOnCanvas(browser, bundle, tree, options);

  beforeAll(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    browser = await chromium.launch();
    bundle = await bundleEditor();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('does not react to the real pointer', async () => {
    const page = await mounted(
      pageOf(
        node('a', {
          style: { ...BOX, color: NORMAL },
          rules: [
            { id: 'hover', selector: '&:hover', at: [HOVER_GATE], style: { color: RULE } },
            { id: 'plain', selector: '&:HOVER', style: { color: RULE } },
            { id: 'within', selector: '&:focus-within', style: { color: RULE } },
            { id: 'nested', selector: '&:is(:active)', style: { color: RULE } },
          ],
        }),
      ),
    );
    const { x, y } = await centre(page, 'a');
    await page.mouse.move(x, y);
    expect(await copy(page, 'a').evaluate((el) => el.matches(':hover'))).toBe(true);
    expect(await computed(page, 'a', 'color')).toBe(NORMAL);
    await page.mouse.down();
    expect(await computed(page, 'a', 'color')).toBe(NORMAL);
    await page.mouse.up();
    expect(await computed(page, 'a', 'color')).toBe(NORMAL);
    await page.close();
  });

  it('shows a previewed Hover in two frames, each with its own value', async () => {
    const { page, crashes } = await openEditor(browser, bundle);
    const [desktop, tablet, phone] = await framesOf(page);
    await placeTree(
      page,
      crashes,
      pageOf(
        node('a', {
          style: { ...BOX, color: NORMAL },
          rules: [{ id: 'hover', selector: '&:hover', at: [HOVER_GATE], style: { color: { base: RULE, [tablet.breakpointId]: 'rgb(0, 9, 0)' } } }],
        }),
      ),
      { allFrames: true },
    );
    expect(await computed(page, 'a', 'color', desktop.breakpointId)).toBe(NORMAL);
    await preview(page, 'a', 'hover');
    expect(await computed(page, 'a', 'color', desktop.breakpointId)).toBe(RULE);
    expect(await computed(page, 'a', 'color', tablet.breakpointId)).toBe('rgb(0, 9, 0)');
    // A Hover set on Tablet reaches the smaller frame, as the cascade says.
    expect(await computed(page, 'a', 'color', phone.breakpointId)).toBe('rgb(0, 9, 0)');
    await preview(page, null);
    expect(await computed(page, 'a', 'color', tablet.breakpointId)).toBe(NORMAL);
    await page.close();
  });

  it('shows Hover too when Pressed is previewed, by state or by stored id', async () => {
    const page = await mounted(
      pageOf(
        node('a', {
          style: { ...BOX, color: NORMAL },
          rules: [
            { id: 'r-hover', selector: '&:hover', at: [HOVER_GATE], style: { backgroundColor: 'rgb(5, 5, 5)' } },
            { id: 'r-press', selector: '&:active', style: { color: RULE } },
          ],
        }),
      ),
    );
    for (const ruleId of ['pressed', 'r-press']) {
      await preview(page, 'a', ruleId);
      expect(await computed(page, 'a', 'color')).toBe(RULE);
      expect(await computed(page, 'a', 'background-color')).toBe('rgb(5, 5, 5)');
    }
    await preview(page, 'a', 'hover');
    expect(await computed(page, 'a', 'color')).toBe(NORMAL);
    expect(await computed(page, 'a', 'background-color')).toBe('rgb(5, 5, 5)');
    await page.close();
  });

  it('beats the inline style of a node, as a rule beats Normal when published', async () => {
    const page = await mounted(pageOf(node('a', { style: { ...BOX, color: NORMAL }, rules: [{ id: 'first', selector: '&:first-child', style: { color: `${RULE} !important` } }] })));
    expect(await copy(page, 'a').evaluate((el) => (el as HTMLElement).style.color)).toBe(NORMAL);
    expect(await computed(page, 'a', 'color')).toBe(RULE);
    await page.close();
  });

  describe('a rule cannot take the node away from the editor', () => {
    const lock: Rule = { id: 'lock', define: '@keyframes u-lock', blocks: [{ selector: 'from, to', style: { pointerEvents: 'none', userSelect: 'none', cursor: 'wait', all: 'unset' } }] };
    const HOSTILE: Record<string, Rule[]> = {
      // The control: this test must select a node with nothing in its way.
      'no rule at all': [],
      'pointer-events': [{ id: 'r', selector: '&', style: { pointerEvents: 'none' } }],
      'a stored !important': [{ id: 'r', selector: '&', style: { pointerEvents: 'none !important' } }],
      'a responsive map': [{ id: 'r', selector: '&', style: { pointerEvents: { base: 'none' } } }],
      'the all shorthand': [{ id: 'r', selector: '&', style: { all: 'unset' } }],
      'interactivity': [{ id: 'r', selector: '&', style: { interactivity: 'inert' } }],
      'an always-true state': [{ id: 'r', selector: '&:not(:checked)', style: { pointerEvents: 'none' } }],
      'a keyframe held at its end': [{ id: 'r', selector: '&', style: { animation: 'u-lock 1s forwards' } }, lock],
      'a keyframe with no rule around it': [lock],
    };

    it.each(Object.keys(HOSTILE))('%s: a click still selects it', async (name) => {
      const style = { ...BOX, ...(name.includes('no rule around') ? { animation: 'u-lock 1s forwards' } : {}) };
      const page = await mounted(pageOf(node('a', { style, rules: HOSTILE[name] })));
      await click(page, 'a');
      expect(await hook(page, 'selectedId')).toBe('a');
      await page.close();
    });

    it('a locked node stays locked under a rule that sets the pointer back', async () => {
      const page = await mounted(
        pageOf(
          node('a', {
            style: BOX,
            rules: [
              { id: 'r', selector: '&', style: { pointerEvents: 'auto', all: 'revert', interactivity: 'auto' } },
              { id: 'k', define: '@keyframes u-free', blocks: [{ selector: 'to', style: { pointerEvents: 'auto' } }] },
              { id: 's', selector: '&:first-child', style: { animation: 'u-free 1s forwards' } },
            ],
          }),
        ),
      );
      await page.evaluate(() => (window as unknown as { __editor: EditorHooks }).__editor.toggleLock('a'));
      await page.waitForFunction(() => document.querySelector<HTMLElement>('[data-inner-component-id="a"]')?.style.pointerEvents === 'none');
      expect(await computed(page, 'a', 'pointer-events')).toBe('none');
      await click(page, 'a');
      expect(await hook(page, 'selectedId')).toBe('page');
      await page.close();
    });

    const STOPS_EDITING: Record<string, Rule['style']> = {
      'no rule at all (the control)': undefined,
      'user-select': { userSelect: 'none' },
      '-webkit-user-select': { WebkitUserSelect: 'none' },
      '-webkit-touch-callout': { WebkitTouchCallout: 'none' },
      '-webkit-user-modify': { WebkitUserModify: 'read-only' },
      cursor: { cursor: 'wait' },
      'pointer-events': { pointerEvents: 'none' },
      all: { all: 'unset' },
      interactivity: { interactivity: 'inert' },
    };

    it.each(Object.keys(STOPS_EDITING))('text stays editable under %s', async (name) => {
      const style = STOPS_EDITING[name];
      const rules: Rule[] = style ? [{ id: 'r', selector: '&', style }] : [];
      const page = await mounted(pageOf(node('t', { children: 'Before', style: { ...BOX, color: NORMAL }, rules })));
      const { x, y } = await centre(page, 't');
      await page.mouse.dblclick(x, y);
      expect(await hook(page, 'editingId')).toBe('t');
      expect(await computed(page, 't', 'user-select')).toBe('text');
      expect(await computed(page, 't', 'cursor')).toBe('text');
      await page.keyboard.type('After');
      await page.keyboard.press('Enter');
      const props = await page.evaluate(() => (window as unknown as { __editor: EditorHooks }).__editor.propsOf('t'));
      expect(props?.children).toBe('After');
      await page.close();
    });
  });

  describe('animations stay at rest', () => {
    const reveal: Rule = { id: 'k', define: '@keyframes u-reveal', blocks: [{ selector: 'to', style: { opacity: 1 } }] };
    const spin: Rule = { id: 's', define: '@keyframes u-spin', blocks: [{ selector: 'to', style: { rotate: '180deg' } }] };
    const before: Rule = { id: 'b', selector: '&::before', style: { content: '"x"', display: 'block', opacity: 0, animation: 'u-reveal 5s forwards' } };
    const timed: Rule = { id: 't', selector: '&', style: { animationDuration: '7s' } };

    const revealing = (id: string) =>
      node(id, {
        style: { ...BOX, opacity: 0, animation: 'u-reveal 5s 2s forwards' },
        rules: [reveal, before, timed],
      });

    it('a forwards reveal sits at its end, on an element, a pseudo-element and a floating element', async () => {
      const page = await mounted(pageOf(revealing('a'), node('b', { style: { ...BOX, animation: 'u-spin 1s linear infinite' }, rules: [spin] })), {
        floating: [revealing('f')],
      });
      expect(await computed(page, 'a', 'opacity')).toBe('1');
      expect(await computed(page, 'a', 'animation-duration')).toBe('0s');
      expect(await computed(page, 'a', 'animation-delay')).toBe('0s');
      expect(await computed(page, 'a', 'opacity', undefined, '::before')).toBe('1');
      expect(await computed(page, 'b', 'animation-iteration-count')).toBe('1');
      expect(await computed(page, 'b', 'rotate')).toBe('none');
      const floating = page.locator('[data-floating-root-id] [data-inner-component-id="f"]');
      expect(await floating.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
      expect(await floating.evaluate((el) => getComputedStyle(el, '::before').opacity)).toBe('1');
      await page.close();
    });

    it('a previewed node plays', async () => {
      const page = await mounted(pageOf(revealing('a')));
      expect(await computed(page, 'a', 'animation-duration')).toBe('0s');
      await preview(page, 'a', 't');
      expect(await computed(page, 'a', 'animation-duration')).toBe('7s');
      await preview(page, null);
      expect(await computed(page, 'a', 'animation-duration')).toBe('0s');
      await page.close();
    });
  });

  describe('conditions on the frame and on the editor', () => {
    const wide: Rule = { id: 'wide', selector: '&', at: ['@media (width >= 64rem)'], style: { color: RULE } };
    const narrow: Rule = { id: 'narrow', selector: '&', at: ['@media (width < 600px)'], style: { backgroundColor: 'rgb(5, 5, 5)' } };
    const dark: Rule = { id: 'dark', selector: '&', at: ['@media (prefers-color-scheme: dark)'], style: { outlineColor: 'rgb(7, 7, 7)' } };
    const print: Rule = { id: 'print', selector: '&', at: ['@media print'], style: { borderTopColor: 'rgb(8, 8, 8)' } };

    it('answers a width from the frame rather than the window', async () => {
      const { page, crashes } = await openEditor(browser, bundle);
      const [desktop, , phone] = await framesOf(page);
      await placeTree(page, crashes, pageOf(node('a', { style: { ...BOX, color: NORMAL }, rules: [wide, narrow] })), { allFrames: true });
      expect(await computed(page, 'a', 'color', desktop.breakpointId)).toBe(RULE);
      expect(await computed(page, 'a', 'color', phone.breakpointId)).toBe(NORMAL);
      expect(await computed(page, 'a', 'background-color', phone.breakpointId)).toBe('rgb(5, 5, 5)');
      expect(await computed(page, 'a', 'background-color', desktop.breakpointId)).toBe(BOX.background);
      await page.close();
    });

    it('ignores the system until previewed, and then shows print and dark the same way', async () => {
      const { page, crashes } = await openEditor(browser, bundle, { colorScheme: 'dark' });
      await placeTree(page, crashes, pageOf(node('a', { style: { ...BOX, outline: '1px solid rgb(1, 1, 1)', border: '1px solid rgb(2, 2, 2)' }, rules: [dark, print] })));
      expect(await computed(page, 'a', 'outline-color')).toBe('rgb(1, 1, 1)');
      expect(await computed(page, 'a', 'border-top-color')).toBe('rgb(2, 2, 2)');
      await preview(page, 'a', 'dark');
      expect(await computed(page, 'a', 'outline-color')).toBe('rgb(7, 7, 7)');
      await preview(page, 'a', 'print');
      expect(await computed(page, 'a', 'border-top-color')).toBe('rgb(8, 8, 8)');
      await page.close();
    });
  });

  // The same stored page reads the document it is in. On a published page that is the
  // page itself, which is the control: each form really reports there. In the editor it
  // would read the signed-in document, so it must have one result whatever that holds.
  describe('a stored page cannot read the editor', () => {
    const SPY = 'https://evil.test/spy';
    const hidden = { ...BOX, display: 'none', backgroundImage: `url(${SPY})` };
    const shown = { display: 'block' };
    const FORMS: Record<string, Partial<Rule>> = {
      ':is() reaching html': { selector: '&:is(html:has([data-hostname]) *)' },
      'a substring of an attribute': { selector: '&:is(html:has([data-hostname*="geh"]) *)' },
      ':not() around it': { selector: '&:not(:is(html:not(:has([data-hostname])) *))' },
      ':where() and :not() nested': { selector: '&:where(:not(:is(html:not(:has([data-hostname])) *)))' },
      ':nth-child(of)': { selector: '&:nth-child(n of :is(html:has([data-hostname]) *))' },
      'a bare complex selector': { selector: '&:is(html[data-hostname] *)' },
      'a :has() around it': { selector: '&:has(:is(html[data-hostname] div))' },
      '@scope with :has()': { selector: '&', at: ['@scope (html:has([data-hostname*="geh"]))'] },
      '@scope with a compound root': { selector: '&', at: ['@scope (html[data-hostname*="geh"])'] },
    };
    const treeOf = (form: Partial<Rule>) => pageOf(node('a', { style: hidden, rules: [{ id: 'r', style: shown, ...form }] }, node('kid', {})));

    const spying = (page: Page): string[] => {
      const seen: string[] = [];
      page.on('request', (request) => {
        if (request.url().startsWith('https://evil.test')) seen.push(request.url());
      });
      return seen;
    };
    /** What the review's `data-hostname` stands for: an attribute the editor renders, on an element and on the root. */
    const hostname = (page: Page) =>
      page.evaluate(() => {
        document.documentElement.setAttribute('data-hostname', 'geheim.example');
        const element = document.createElement('i');
        element.id = 'editor-state';
        element.setAttribute('data-hostname', 'geheim.example');
        document.body.append(element);
      });
    const noHostname = (page: Page) =>
      page.evaluate(() => {
        document.documentElement.removeAttribute('data-hostname');
        document.getElementById('editor-state')?.remove();
      });
    /** A form written around a negation is constantly on rather than constantly off: what counts is that it is constant. */
    const ALWAYS_ON = new Set([':not() around it', ':where() and :not() nested']);

    it.each(Object.keys(FORMS))('%s: reports on a published page, the control', async (name) => {
      const page = await browser.newPage();
      await page.route('**/*', (route) => route.fulfill({ status: 200, body: '' }));
      const seen = spying(page);
      await page.setContent(publishedDocument(renderPublished(treeOf(FORMS[name]))));
      await hostname(page);
      await expect.poll(() => seen.length, { timeout: 2000 }).toBeGreaterThan(0);
      await page.close();
    });

    it.each(Object.keys(FORMS))('%s: one result on the canvas whatever the editor holds, previewed or not', async (name) => {
      const page = await mounted(treeOf(FORMS[name]));
      const seen = spying(page);
      const resting = ALWAYS_ON.has(name) ? 'block' : 'none';
      expect(await computed(page, 'a', 'display')).toBe(resting);
      await hostname(page);
      await click(page, 'page');
      await page.waitForTimeout(150);
      expect(await computed(page, 'a', 'display')).toBe(resting);
      expect(seen).toEqual([]);
      const previewing = ALWAYS_ON.has(name) ? 'none' : 'block';
      await preview(page, 'a', 'r');
      expect(await computed(page, 'a', 'display')).toBe(previewing);
      await noHostname(page);
      expect(await computed(page, 'a', 'display')).toBe(previewing);
      await page.close();
    });

    it.each(Object.keys(FORMS))('%s: one result on the preview whatever the editor holds', async (name) => {
      const { page, crashes } = await openEditor(browser, bundle);
      await placeTree(page, crashes, treeOf(FORMS[name]));
      const seen = spying(page);
      await hostname(page);
      await page.evaluate(() => (window as unknown as { __editor: EditorHooks }).__editor.setPreviewOpen(true));
      const frame = page.locator('[data-preview-frame]');
      await frame.waitFor({ state: 'visible' });
      await page.waitForTimeout(150);
      const target = frame.locator('[data-inner-component-id="a"]');
      const resting = ALWAYS_ON.has(name) ? 'block' : 'none';
      expect(await target.evaluate((el) => getComputedStyle(el).display)).toBe(resting);
      await noHostname(page);
      expect(await target.evaluate((el) => getComputedStyle(el).display)).toBe(resting);
      if (!ALWAYS_ON.has(name)) expect(seen).toEqual([]);
      await page.close();
    });

    it('a selection in the editor tells a stored page nothing', async () => {
      const selector = '&:is(html:has([data-testid="primary-selection-overlay"]:not([style*="none"])) *)';
      const page = await mounted(pageOf(node('a', { style: hidden, rules: [{ id: 'r', selector, style: shown }] }), node('b', { style: BOX })));
      const seen = spying(page);
      await click(page, 'b');
      expect(await hook(page, 'selectedId')).toBe('b');
      await page.waitForTimeout(150);
      expect(seen).toEqual([]);
      await page.close();
    });

    it('the top bar opening the preview tells a stored page nothing', async () => {
      const { page, crashes } = await openEditor(browser, bundle);
      await placeTree(page, crashes, pageOf(node('a', { style: hidden, rules: [{ id: 'r', selector: '&:is(html:has([data-editor-topbar]) *)', style: shown }] })));
      const seen = spying(page);
      await page.evaluate(() => (window as unknown as { __editor: EditorHooks }).__editor.setPreviewOpen(true));
      await page.locator('[data-preview-frame]').waitFor({ state: 'visible' });
      await page.waitForTimeout(150);
      expect(seen).toEqual([]);
      await page.close();
    });

    it('a rule cannot reach an external address through var(), with a site path as the control', async () => {
      const page = await mounted(
        pageOf(
          node('a', { style: { ...BOX, '--x': `url(${SPY})` }, rules: [{ id: 'r', selector: '&', style: { backgroundImage: 'var(--x)' } }] }),
          node('b', { style: { ...BOX, '--y': 'url(/site.png)' }, rules: [{ id: 'r', selector: '&', style: { backgroundImage: 'var(--y)' } }] }),
        ),
      );
      expect(await computed(page, 'a', 'background-image')).toBe('none');
      expect(await computed(page, 'b', 'background-image')).toContain('/site.png');
      await page.close();
    });

    it('keeps the specificity of what it stands for, live and dead', async () => {
      const OTHER = 'rgb(0, 9, 0)';
      const first: Rule = { id: 'first', selector: '&:first-child', style: { color: OTHER } };
      const page = await mounted(
        pageOf(
          node('w', {}, node('a', { style: { ...BOX, color: NORMAL }, rules: [{ id: 'is', selector: '&:is(.x .y)', style: { color: RULE } }, first] })),
          node('v', {}, node('b', { style: { ...BOX, color: NORMAL }, rules: [first, { id: 'where', selector: '&:where(.x .y)', style: { color: RULE } }] })),
        ),
      );
      // (0,2,0) beats :first-child although it comes first, as it would when matched.
      await preview(page, 'a', 'is');
      expect(await computed(page, 'a', 'color')).toBe(RULE);
      // :where() counts for nothing, so :first-child wins although it comes first.
      await preview(page, 'b', 'where');
      expect(await computed(page, 'b', 'color')).toBe(OTHER);
      await page.close();
    });

    // E5 of the review: 32 nodes with 64 rules each took a click from 65 ms to 300.
    it('a costly condition does not slow a click', async () => {
      const heavy = (index: number) => `&:is(html:has(div div div div div div div div [data-h${index}]) *)`;
      const costly = Array.from({ length: 32 }, (_, n) =>
        node(`c${n}`, { style: { ...BOX, height: '4px' }, rules: Array.from({ length: 64 }, (_, r) => ({ id: `r${r}`, selector: heavy(r + n * 64), style: { color: RULE } })) }),
      );
      const plain = Array.from({ length: 32 }, (_, n) => node(`c${n}`, { style: { ...BOX, height: '4px' } }));
      const clickTime = async (children: ComponentNode[]): Promise<number> => {
        const page = await mounted(pageOf(...children));
        const { x, y } = await centre(page, 'c3');
        const times: number[] = [];
        for (let i = 0; i < 9; i++) {
          const start = Date.now();
          await page.mouse.click(x, y);
          await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))));
          times.push(Date.now() - start);
          await page.keyboard.press('Escape');
        }
        await page.close();
        return times.sort((a, b) => a - b)[4];
      };
      const without = await clickTime(plain);
      const withRules = await clickTime(costly);
      process.stderr.write(`E5 click: ${withRules} ms with 2048 costly rules, ${without} ms without\n`);
      expect(withRules).toBeLessThan(without + 100);
    });
  });

  it('previews a hover preset without letting it beat an inline value', async () => {
    const page = await mounted(
      pageOf(
        node('a', { style: BOX, effects: { hover: 'lift' } }),
        node('b', { style: { ...BOX, opacity: 1 }, effects: { hover: 'dim' } }),
      ),
    );
    const { x, y } = await centre(page, 'a');
    await page.mouse.move(x, y);
    expect(await computed(page, 'a', 'translate')).toBe('none');
    await preview(page, 'a', 'hover');
    expect(await computed(page, 'a', 'translate')).toBe('0px -2px');
    await preview(page, 'b', 'hover');
    expect(await computed(page, 'a', 'translate')).toBe('none');
    expect(await computed(page, 'b', 'opacity')).toBe('1');
    await page.close();
  });

  it('keeps the canvas sheet off the preview over it, and the preview on real conditions', async () => {
    const { page, crashes } = await openEditor(browser, bundle);
    await placeTree(
      page,
      crashes,
      pageOf(
        node('a', {
          style: { ...BOX, color: NORMAL },
          rules: [
            { id: 'hover', selector: '&:hover', style: { color: RULE } },
            { id: 'wide', selector: '&', at: ['@media (min-width: 900px)'], style: { backgroundColor: 'rgb(5, 5, 5)' } },
          ],
        }),
        node('b', { style: { ...BOX, marginTop: '8px' }, effects: { hover: 'dim' } }),
      ),
    );
    await page.evaluate(() => (window as unknown as { __editor: EditorHooks }).__editor.setPreviewOpen(true));
    const frame = page.locator('[data-preview-frame]');
    await frame.waitFor({ state: 'visible' });
    const target = frame.locator('[data-inner-component-id="a"]');
    const inFrame = frame.locator('[data-inner-component-id="b"]');
    const width = await frame.evaluate((el) => (el as HTMLElement).clientWidth);
    expect(await target.evaluate((el) => getComputedStyle(el).color)).toBe(NORMAL);
    await target.hover();
    expect(await target.evaluate((el) => getComputedStyle(el).color)).toBe(RULE);
    expect(await inFrame.getAttribute('data-fx-h')).toBeNull();
    expect(await inFrame.getAttribute('class')).toContain('fc_fx-dim');
    await inFrame.hover();
    await inFrame.evaluate((el) => Promise.allSettled(el.getAnimations().map((animation) => animation.finished)));
    expect(await inFrame.evaluate((el) => getComputedStyle(el).opacity)).toBe('0.8');
    expect(width).toBeGreaterThan(0);
    await page.close();
  });

  // The contract's open measure: one sheet for the page is rewritten on any rule edit,
  // and that restyles the whole document. Set against an edit that leaves the sheet alone.
  it('a rule edit on 300 nodes in three frames costs about what any style edit does', async () => {
    const children = Array.from({ length: 300 }, (_, index) =>
      node(`n${index}`, {
        style: { ...BOX, height: '4px' },
        rules: [
          { id: 'hover', selector: '&:hover', at: [HOVER_GATE], style: { color: RULE } },
          { id: 'first', selector: '&:first-child', style: { color: RULE } },
        ],
      }),
    );
    const { page, crashes } = await openEditor(browser, bundle);
    await placeTree(page, crashes, pageOf(...children), { allFrames: true });
    const timed = (edit: 'rule' | 'style') =>
      page.evaluate(async (kind) => {
        const { setRuleStyle, setStyle } = (window as unknown as { __editor: EditorHooks }).__editor;
        const out: number[] = [];
        for (let i = 0; i < 21; i++) {
          const start = performance.now();
          if (kind === 'rule') setRuleStyle('n0', 'first', { color: `rgb(${i}, 0, 0)` });
          else setStyle('n1', { width: `${100 + i}px` });
          await new Promise((resolve) => setTimeout(resolve, 0));
          void getComputedStyle(document.body).color;
          document.body.getBoundingClientRect();
          out.push(performance.now() - start);
        }
        return out.sort((a, b) => a - b)[10];
      }, edit);
    const rule = await timed('rule');
    const style = await timed('style');
    process.stderr.write(`rule edit, 300 nodes, 3 frames: median ${rule.toFixed(1)} ms, against ${style.toFixed(1)} ms for a style edit\n`);
    expect(await computed(page, 'n0', 'color')).toBe('rgb(20, 0, 0)');
    expect(rule).toBeLessThan(Math.max(style * 3, 100));
    await page.close();
  });

  // Nothing in the corpus reads the canvas, so a passing corpus says nothing about the
  // surfaces agreeing. This does: the fixture on the mounted editor with each state
  // previewed, against the published page really in that state. It compares what the
  // rules set: the canvas adds `pointer-events` inline and never shows `cursor`.
  describe('parity with the published page: hover-focus', () => {
    const fixture = FIXTURES.find(({ id }) => id === 'hover-focus')!;
    const COMPARED = ['background-color', 'outline-style', 'outline-color', 'outline-width', 'outline-offset', 'border-top-color', 'box-shadow'];

    const readAll = (page: Page, root: string, parityId: string) =>
      page.locator(`${root}[data-parity-id="${parityId}"]`).first().evaluate(
        (el, names) => Object.fromEntries(names.map((name) => [name, getComputedStyle(el).getPropertyValue(name)])),
        COMPARED,
      );

    const STATES: { name: string; parityId: string; ruleId: string; apply: (page: Page, target: string) => Promise<void> }[] = [
      { name: 'hover', parityId: 'button', ruleId: 'hover', apply: (page, target) => page.locator(target).hover() },
      {
        name: 'pressed',
        parityId: 'button',
        ruleId: 'pressed',
        apply: async (page, target) => {
          await page.locator(target).hover();
          await page.mouse.down();
        },
      },
      { name: 'keyboard focus', parityId: 'button', ruleId: 'focused', apply: (page) => page.keyboard.press('Tab') },
      { name: 'focus field', parityId: 'field', ruleId: 'focus', apply: (page, target) => page.locator(target).focus() },
    ];

    it.each(STATES)('$name', async ({ parityId, ruleId, apply }) => {
      const tree = fixture.tree();
      const published = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
      await published.setContent(publishedDocument(renderPublished(tree)));
      await apply(published, `[data-parity-id="${parityId}"]`);
      const want = await readAll(published, '', parityId);
      await published.close();

      const canvas = await mounted(tree);
      const copyOf = canvas.locator(`[data-viewport-content-id] [data-parity-id="${parityId}"]`);
      const componentId = await copyOf.getAttribute('data-inner-component-id');
      await preview(canvas, componentId, ruleId);
      expect(await readAll(canvas, '[data-viewport-content-id] ', parityId)).toEqual(want);
      await canvas.close();
    });
  });
});

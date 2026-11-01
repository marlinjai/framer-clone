// What a wrapper does, which only a browser can say. The matrix proves a condition
// reached the sheet and that Chromium parsed it. Here each one has to change a
// computed style when it holds and leave it alone when it does not, through the real
// published path, so a condition that parses but never applies fails.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { compile } from 'tailwindcss';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { parseWrapper } from '@/lib/rules/rules';
import { publishedDocument, renderPublished } from './lib/published';

const NORMAL = 'rgb(1, 1, 1)';
const RULED = 'rgb(9, 9, 9)';
const TABLET = 'rgb(5, 5, 5)';

const node = (id: string, props: Record<string, unknown>, children?: ComponentNode[]): ComponentNode =>
  ({ id, type: 'div', props, ...(children ? { children } : {}) }) as ComponentNode;

/** A node whose colour says whether a rule under these wrappers reached it. */
const probe = (id: string, at: string[], selector = '&', props: Record<string, unknown> = {}): ComponentNode =>
  node(id, { 'data-t': id, style: { color: NORMAL }, rules: [{ id: 'r', selector, at, style: { color: RULED } }], ...props });

const written = (text: string): string => {
  const parsed = parseWrapper(text);
  if (!parsed.ok) throw new Error(`${text}: ${parsed.reason}`);
  return parsed.value;
};

describe('conditions in real Chromium', () => {
  let browser: Browser;
  let page: Page;

  const show = async (tree: ComponentNode, width = 1400): Promise<string> => {
    const published = renderPublished(tree);
    await page.setViewportSize({ width, height: 800 });
    await page.emulateMedia({ media: 'screen' });
    await page.setContent(publishedDocument(published));
    return published.css;
  };

  const colourOf = (id: string): Promise<string> => page.locator(`[data-t="${id}"]`).evaluate((el) => getComputedStyle(el).color);

  beforeAll(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    browser = await chromium.launch();
    page = await browser.newPage();
  });
  afterAll(async () => {
    await browser?.close();
  });

  describe('a range comparison, written without its <', () => {
    const cases: [string, number, boolean][] = [
      ['(width < 600px)', 599, true],
      ['(width < 600px)', 600, false],
      ['(width <= 600px)', 600, true],
      ['(width <= 600px)', 601, false],
      ['(600px < width)', 601, true],
      ['(600px < width)', 600, false],
      ['(600px <= width)', 600, true],
      ['(400px < width <= 600px)', 400, false],
      ['(400px < width <= 600px)', 401, true],
      ['(400px < width <= 600px)', 600, true],
      ['(400px < width <= 600px)', 601, false],
      ['(width < 48rem)', 767, true],
      ['(width < 48rem)', 768, false],
      ['(width < calc(500px + 100px))', 599, true],
      ['(width < calc(500px + 100px))', 600, false],
      ['not (width < 600px)', 599, false],
      ['not (width < 600px)', 600, true],
      ['screen and (width < 600px)', 599, true],
      ['print and (width < 600px)', 599, false],
      ['(width < 600px) and (height < 400px)', 599, false],
      ['(width < 600px) or (height < 900px)', 700, true],
    ];

    it.each(cases)('%s at %i wide is %s, stored and rewritten alike', async (query, width, expected) => {
      const rewritten = written(`@media ${query}`).replace('@media ', '');
      expect(rewritten).not.toContain('<');
      await page.setViewportSize({ width, height: 800 });
      await page.emulateMedia({ media: 'screen' });
      const verdict = await page.evaluate(
        ([stored, flipped]) => ({ stored: matchMedia(stored).matches, flipped: matchMedia(flipped).matches }),
        [query, rewritten],
      );
      expect(verdict).toEqual({ stored: expected, flipped: expected });
    });

    it('applies on a published page, on the side of the boundary it names, with no < in the sheet', async () => {
      const tree = probe('a', ['@media (width < 600px)']);
      expect(await show(tree, 599)).not.toContain('<');
      expect(await colourOf('a')).toBe(RULED);
      await show(tree, 600);
      expect(await colourOf('a')).toBe(NORMAL);
    });

    it('takes the form Tailwind compiles max-md: to, read from Tailwind itself', async () => {
      const compiler = await compile('@theme { --breakpoint-md: 48rem; } @tailwind utilities;');
      const prelude = /@media [^{]+/.exec(compiler.build(['max-md:flex']))?.[0].trim() as string;
      expect(prelude).toContain('<');
      const tree = probe('a', [prelude]);
      expect(await show(tree, 767)).not.toContain('<');
      expect(await colourOf('a')).toBe(RULED);
      await show(tree, 768);
      expect(await colourOf('a')).toBe(NORMAL);
    });

    it('works in @container, against the container rather than the window', async () => {
      const shell = (width: string, id: string) =>
        node(`shell-${id}`, { style: { containerType: 'inline-size', width } }, [probe(id, ['@container (width < 400px)'])]);
      const css = await show(node('page', {}, [shell('399px', 'narrow'), shell('400px', 'wide')]));
      expect(css).not.toContain('<');
      expect(await colourOf('narrow')).toBe(RULED);
      expect(await colourOf('wide')).toBe(NORMAL);
    });

    it('works in a style query', async () => {
      const shell = (value: number, id: string) =>
        node(`shell-${id}`, { style: { '--u-size': value } }, [probe(id, ['@container style(--u-size < 3)'])]);
      await show(node('page', {}, [shell(2, 'small'), shell(3, 'large')]));
      expect(await colourOf('small')).toBe(RULED);
      expect(await colourOf('large')).toBe(NORMAL);
    });
  });

  it('@media print applies when printing, and only then', async () => {
    await show(probe('a', ['@media print']));
    expect(await colourOf('a')).toBe(NORMAL);
    await page.emulateMedia({ media: 'print' });
    expect(await colourOf('a')).toBe(RULED);
  });

  it('@media on a feature follows it', async () => {
    await show(probe('a', ['@media (prefers-color-scheme: dark)']));
    await page.emulateMedia({ colorScheme: 'light' });
    expect(await colourOf('a')).toBe(NORMAL);
    await page.emulateMedia({ colorScheme: 'dark' });
    expect(await colourOf('a')).toBe(RULED);
  });

  it('@supports follows what the browser supports', async () => {
    await show(node('page', {}, [probe('yes', ['@supports (display: grid)']), probe('no', ['@supports (display: u-none)'])]));
    expect(await colourOf('yes')).toBe(RULED);
    expect(await colourOf('no')).toBe(NORMAL);
  });

  it(':scope matches the root of its @scope, and nothing else', async () => {
    await show(
      node('page', {}, [
        probe('root', ['@scope (.u-card)'], '&:scope', { className: 'u-card' }),
        probe('outside', ['@scope (.u-card)'], '&:scope'),
        node('card', { className: 'u-card' }, [probe('inside', ['@scope (.u-card)'], '&:scope')]),
      ]),
    );
    expect(await colourOf('root')).toBe(RULED);
    expect(await colourOf('outside')).toBe(NORMAL);
    expect(await colourOf('inside')).toBe(NORMAL);
  });

  it('@scope stops at its limit', async () => {
    const scoped = (id: string) => probe(id, ['@scope (.u-card) to (.u-slot)']);
    await show(
      node('page', {}, [
        scoped('outside'),
        node('card', { className: 'u-card' }, [scoped('inside'), node('slot', { className: 'u-slot' }, [scoped('past-limit')])]),
      ]),
    );
    expect(await colourOf('inside')).toBe(RULED);
    expect(await colourOf('outside')).toBe(NORMAL);
    expect(await colourOf('past-limit')).toBe(NORMAL);
  });

  it('@starting-style starts a transition on the first frame, which needs Normal out of the inline style', async () => {
    const tree = node('a', {
      'data-t': 'a',
      style: { opacity: 1, transition: 'opacity 60s linear' },
      rules: [{ id: 'r', selector: '&', at: ['@starting-style'], style: { opacity: 0 } }],
    });
    await show(tree);
    const { running, opacity } = await page.locator('[data-t="a"]').evaluate((el) => ({
      running: el.getAnimations().length,
      opacity: Number(getComputedStyle(el).opacity),
    }));
    expect(running).toBe(1);
    expect(opacity).toBeLessThan(0.5);
  });

  it('nests inside a breakpoint, whose query stays outermost', async () => {
    const tree = node('a', {
      'data-t': 'a',
      style: { color: NORMAL },
      rules: [{ id: 'r', selector: '&', at: ['@supports (display: grid)', '@media print'], style: { color: { base: RULED, tablet: TABLET } } }],
    });
    await show(tree, 1400);
    await page.emulateMedia({ media: 'print' });
    expect(await colourOf('a')).toBe(RULED);
    await show(tree, 1000);
    expect(await colourOf('a')).toBe(NORMAL);
    await page.emulateMedia({ media: 'print' });
    expect(await colourOf('a')).toBe(TABLET);
  });

  it("reaches inside the node under a wrapper, past the child's own Normal", async () => {
    const tree = node('a', { rules: [{ id: 'r', selector: '& p', at: ['@media print'], style: { color: RULED } }] }, [
      { id: 'p', type: 'p', props: { 'data-t': 'p', style: { color: NORMAL } } } as ComponentNode,
    ]);
    await show(tree);
    expect(await colourOf('p')).toBe(NORMAL);
    await page.emulateMedia({ media: 'print' });
    expect(await colourOf('p')).toBe(RULED);
  });
});

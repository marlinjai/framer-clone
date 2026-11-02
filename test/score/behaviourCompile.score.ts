// What the behaviour pass leaves on a page, which only a browser can say: the gate and
// every row of its table, a page with no JavaScript, what a condition really selects,
// and ids and references per row. This closes no matrix row. It runs here because this
// is where Chromium is. Nothing starts a runtime: slice B3 does. The tests call what the
// runtime will call, and the page is the real output of renderPublishedPage, served by
// a real navigation, since a page set by script cannot have JavaScript off.

import React from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { CommerceServerRepository, ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import type { CmsReadRepository } from '@/server/cms';
import { START_STATE_TIMEOUT_MS } from '@/lib/effects/effects';
import { GATE_ATTR } from '@/lib/behaviour/gate';
import { renderPublishedPage } from '@/lib/renderer/server/renderPublishedPage';

const ORIGIN = 'http://behaviour.test/';
const PAST_THE_GATE = START_STATE_TIMEOUT_MS + 300;
const GREEN = 'rgb(0, 128, 0)';
const RED = 'rgb(255, 0, 0)';
const BLUE = 'rgb(0, 0, 255)';

const node = (id: string, type: string, props: Record<string, unknown> = {}, ...children: ComponentNode[]): ComponentNode =>
  ({ id, type, props: { 'data-t': id, ...props }, children }) as ComponentNode;
const flag = (id: string, initial = false) => ({ id, name: id, type: 'boolean', initial });
const toggle = (state: string) => ({ id: 't', on: 'click', do: [{ toggle: state }] });

const noRows = { listRows: async () => ({ rows: [], total: 0 }), getRow: async () => null } as unknown as CmsReadRepository;
const rowsOf = (count: number) =>
  ({ listRows: async () => ({ rows: Array.from({ length: count }, (_, index) => ({ id: `r${index}`, values: {} })), total: count }), getRow: async () => null }) as unknown as CmsReadRepository;
const commerceRepo = {} as unknown as CommerceServerRepository;

/** A page as the published route writes it. */
async function documentOf(root: ComponentNode, cmsRepo: CmsReadRepository = noRows): Promise<string> {
  const { body } = await renderPublishedPage({ root, pageParams: {}, cmsRepo, commerceRepo, breakpoints: [] });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body>${renderToStaticMarkup(React.createElement(React.Fragment, null, body))}</body></html>`;
}

const collection = (template: ComponentNode): ComponentNode =>
  ({ id: 'list', type: 'ul', props: { 'data-component-kind': 'collection' }, bindings: { collection: { mode: 'read', expression: 'c' } }, children: [template] }) as ComponentNode;

/** The accordion of the contract: a button that needs the script, and a panel behind it. */
const accordion = (): ComponentNode =>
  node('item', 'div', { behaviour: { state: [flag('s1')] } },
    node('btn', 'button', { children: 'Open', behaviour: { on: [toggle('s1')], bind: [{ attr: 'aria-expanded', from: { get: 's1' } }] } }),
    node('panel', 'div', { children: 'Body', behaviour: { showWhen: { state: 's1', eq: true } } }),
    node('other', 'p', { children: 'Other' }),
    node('tall', 'div', { style: { height: '3000px' } }));

describe('the behaviour pass in real Chromium', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let errors: string[];

  const serve = async (target: Page, html: string): Promise<void> => {
    await target.route(ORIGIN, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
    await target.goto(ORIGIN);
  };
  const open = async (root: ComponentNode, cmsRepo?: CmsReadRepository): Promise<void> => serve(page, await documentOf(root, cmsRepo));
  const el = (id: string, on: Page = page) => on.locator(`[data-t="${id}"]`).first();
  const gate = (on: Page = page) => on.evaluate((name) => document.documentElement.hasAttribute(name), GATE_ATTR).catch(() => null);
  const ready = () => page.evaluate(() => (window as unknown as { __fcB: { ready(): boolean } }).__fcB.ready());
  const colourOf = (id: string) => el(id).evaluate((target) => getComputedStyle(target).color);
  const shown = (id: string, on: Page = page) => el(id, on).isVisible();

  beforeAll(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    await context?.close();
    context = await browser.newContext();
    page = await context.newPage();
    errors = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
  });

  describe('the gate', () => {
    it('with JavaScript off, has no gate, shows every panel and hides the button that would do nothing', async () => {
      const off = await browser.newContext({ javaScriptEnabled: false });
      const target = await off.newPage();
      await serve(target, await documentOf(accordion()));
      expect(await shown('panel', target)).toBe(true);
      expect(await shown('btn', target)).toBe(false);
      expect(await target.locator(`html[${GATE_ATTR}]`).count()).toBe(0);
      await off.close();
    });

    it('is up before the content exists, so the first state shows with no flash', async () => {
      await page.addInitScript((name) => {
        const seen: (boolean | undefined)[] = [];
        (window as unknown as { seen: unknown[] }).seen = seen;
        new MutationObserver(() => {
          if (seen.length === 0 && document.querySelector('[data-t="panel"]')) seen.push(document.documentElement.hasAttribute(name));
        }).observe(document, { childList: true, subtree: true });
      }, GATE_ATTR);
      await open(accordion());
      expect(await page.evaluate(() => (window as unknown as { seen: unknown[] }).seen)).toEqual([true]);
      expect(await shown('panel')).toBe(false);
      expect(await shown('btn')).toBe(true);
      expect(await el('btn').getAttribute('aria-expanded')).toBe('false');
    });

    it('does not stop at reduced motion, since it is about state', async () => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await open(accordion());
      expect(await gate()).toBe(true);
    });

    it('holds once the runtime reports ready', async () => {
      await open(accordion());
      expect(await ready()).toBe(true);
      await page.waitForTimeout(PAST_THE_GATE);
      expect(await gate()).toBe(true);
      expect(await shown('panel')).toBe(false);
      expect(errors).toEqual([]);
    });

    it('falls when no runtime starts, with a console error, and the page reads without a script', async () => {
      await open(accordion());
      await page.waitForTimeout(PAST_THE_GATE);
      expect(await gate()).toBe(false);
      expect(await shown('panel')).toBe(true);
      expect(await shown('btn')).toBe(false);
      expect(errors.join()).toContain('did not start');
    });

    it('comes back for a late start on a page nobody has touched', async () => {
      await open(accordion());
      await page.waitForTimeout(PAST_THE_GATE);
      expect(await ready()).toBe(true);
      expect(await gate()).toBe(true);
    });

    it('stays down for a late start once the visitor has scrolled, so nothing collapses under a reader', async () => {
      await open(accordion());
      await page.waitForTimeout(PAST_THE_GATE);
      await page.mouse.wheel(0, 400);
      await page.waitForFunction(() => window.scrollY > 0);
      expect(await ready()).toBe(false);
      expect(await gate()).toBe(false);
      expect(await shown('panel')).toBe(true);
    });

    it('stays down for a late start once the visitor has typed', async () => {
      await open(accordion());
      await page.waitForTimeout(PAST_THE_GATE);
      await page.keyboard.press('a');
      expect(await ready()).toBe(false);
      expect(await gate()).toBe(false);
    });

    it('comes down for good on a later failure, so nothing stays hidden behind a dead runtime', async () => {
      await open(accordion());
      await ready();
      await page.evaluate(() => (window as unknown as { __fcB: { fail(): void } }).__fcB.fail());
      expect(await gate()).toBe(false);
      expect(await shown('panel')).toBe(true);
      expect(await ready()).toBe(false);
      expect(await gate()).toBe(false);
    });
  });

  describe('the buffer', () => {
    const queued = () => page.evaluate(() => (window as unknown as { __fcB: { queue: Event[] } }).__fcB.queue.map((event) => event.type));

    it('holds the first click and the first keydown on a marked node', async () => {
      await open(accordion());
      await el('btn').click();
      await el('btn').click();
      await el('btn').focus();
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
      expect(await queued()).toEqual(['click', 'keydown']);
    });

    it('holds nothing off a marked node', async () => {
      await open(node('page', 'div', {}, node('outside', 'p', { children: 'Outside' }), accordion()));
      await el('outside').click();
      expect(await queued()).toEqual([]);
    });

    it('stops once the runtime is ready, which starts from there', async () => {
      await open(accordion());
      await ready();
      await el('btn').click();
      expect(await queued()).toEqual([]);
    });
  });

  describe('a page with state and no trigger', () => {
    const still = (initial: boolean) =>
      node('item', 'div', { behaviour: { state: [flag('s1', initial)] } },
        node('panel', 'div', { children: 'Body', behaviour: { showWhen: { state: 's1', eq: true } } }),
        node('look', 'div', { children: 'Look', rules: [{ id: 'r', selector: '&', when: { state: 's1', eq: true }, style: { color: GREEN } }] }));

    it('needs no script and no gate to read the first value', async () => {
      for (const javaScriptEnabled of [true, false]) {
        const scripted = await browser.newContext({ javaScriptEnabled });
        const target = await scripted.newPage();
        await serve(target, await documentOf(still(false)));
        expect(await shown('panel', target)).toBe(false);
        await target.unrouteAll();
        await serve(target, await documentOf(still(true)));
        expect(await shown('panel', target)).toBe(true);
        await scripted.close();
      }
    });

    it('writes no boot script and stays as it is', async () => {
      await open(still(true));
      await page.waitForTimeout(PAST_THE_GATE);
      expect(await gate()).toBe(false);
      expect(await page.locator('[data-fc-behaviour-boot]').count()).toBe(0);
      expect(await colourOf('look')).toBe(GREEN);
      expect(errors).toEqual([]);
    });
  });

  describe('a condition', () => {
    const set = (value: string) => el('item').evaluate((target, next) => target.setAttribute('data-fcs-s1', next), value);
    const page1 = (rules: unknown[], extra: Record<string, unknown> = {}) =>
      node('item', 'div', { behaviour: { state: [flag('s1')], on: [toggle('s1')] } }, node('a', 'div', { children: 'x', style: { color: RED }, rules, ...extra }));

    it('applies and stops with the value on its scope, behind the gate', async () => {
      await open(page1([{ id: 'r', selector: '&', when: { state: 's1', eq: true }, style: { color: GREEN } }]));
      await ready();
      expect(await colourOf('a')).toBe(RED);
      await set('true');
      expect(await colourOf('a')).toBe(GREEN);
      await page.evaluate((name) => document.documentElement.removeAttribute(name), GATE_ATTR);
      expect(await colourOf('a')).toBe(RED);
    });

    it('adds no specificity, so a later rule wins a tie, either way round', async () => {
      const open1 = { id: 'o', selector: '&', when: { state: 's1', eq: true }, style: { color: GREEN } };
      const plain = { id: 'p', selector: '&:where(*)', style: { color: BLUE } };
      await open(page1([open1, plain]));
      await set('true');
      expect(await colourOf('a')).toBe(BLUE);
      await page.unrouteAll();
      await open(page1([plain, open1]));
      await set('true');
      expect(await colourOf('a')).toBe(GREEN);
    });

    it('loses to an element rule of higher specificity, as the components contract states', async () => {
      await open(page1([
        { id: 'p', selector: '&:not(.nothing)', style: { color: BLUE } },
        { id: 'o', selector: '&', when: { state: 's1', eq: true }, style: { color: GREEN } },
      ]));
      await set('true');
      expect(await colourOf('a')).toBe(BLUE);
    });

    it('holds on a pseudo-element, which a browser would drop if the condition came after it', async () => {
      await open(page1([{ id: 'r', selector: '&::before', when: { state: 's1', eq: true }, style: { content: '"on"' } }]));
      await set('true');
      expect(await el('a').evaluate((target) => getComputedStyle(target, '::before').content)).toBe('"on"');
    });

    it('selects through not, all and any', async () => {
      const tree = node('item', 'div', { behaviour: { state: [flag('s1'), { id: 'c', name: 'c', type: 'choice', initial: 'a', options: ['a', 'b'] }], on: [toggle('s1')] } },
        node('a', 'div', { children: 'x', style: { color: RED }, rules: [{ id: 'r', selector: '&', when: { all: [{ not: { state: 's1', eq: true } }, { any: [{ state: 'c', eq: 'b' }, { state: 's1', eq: true }] }] }, style: { color: GREEN } }] }));
      await open(tree);
      expect(await colourOf('a')).toBe(RED);
      await el('item').evaluate((target) => target.setAttribute('data-fcs-c', 'b'));
      expect(await colourOf('a')).toBe(GREEN);
      await set('true');
      expect(await colourOf('a')).toBe(RED);
    });

    it('hides against a stronger display of the same node, which is why showWhen is important', async () => {
      await open(node('item', 'div', { behaviour: { state: [flag('s1')], on: [toggle('s1')] } },
        node('a', 'div', { children: 'x', rules: [{ id: 'd', selector: '&:not(.nothing)', style: { display: 'flex' } }], behaviour: { showWhen: { state: 's1', eq: true } } })));
      expect(await shown('a')).toBe(false);
    });
  });

  describe('rows', () => {
    const row = (): ComponentNode =>
      node('tpl', 'li', { behaviour: { state: [flag('s1')] } },
        node('btn', 'button', { children: 'Toggle', behaviour: { on: [toggle('s1')] } }),
        node('panel', 'div', { children: 'Body', behaviour: { showWhen: { state: 's1', eq: true } } }));

    it('reads each row from its own ancestor, with one shared rule class', async () => {
      await open(collection(row()), rowsOf(3));
      await ready();
      const panels = page.locator('[data-t="panel"]');
      expect(await panels.evaluateAll((all) => all.filter((target) => getComputedStyle(target).display !== 'none').length)).toBe(0);
      await page.locator('[data-t="tpl"]').nth(1).evaluate((target) => target.setAttribute('data-fcs-s1', 'true'));
      expect(await panels.evaluateAll((all) => all.map((target) => getComputedStyle(target).display !== 'none'))).toEqual([false, true, false]);
    });

    it('shows the panel of the row a tab selects, from the server, for tabs from a Collection', async () => {
      const tabs = node('tabs', 'div', { behaviour: { state: [{ id: 'n', name: 'n', type: 'number', initial: 1 }] } },
        collection(node('tpl', 'li', {},
          node('tab', 'button', { behaviour: { on: [{ id: 'c', on: 'click', do: [{ set: 'n', value: { row: 'index' } }] }] } }),
          node('panel', 'div', { children: 'Body', behaviour: { showWhen: { state: 'n', eq: { row: 'index' } } } }))));
      await open(tabs, rowsOf(3));
      await ready();
      expect(await page.locator('[data-t="panel"]').evaluateAll((all) => all.map((target) => getComputedStyle(target).display !== 'none'))).toEqual([false, true, false]);
    });

    it('opens the popover of its own row, and a label finds its own field', async () => {
      const template = node('tpl', 'li', {},
        node('open', 'button', { popoverTarget: 'menu', children: 'Open' }),
        node('menu', 'div', { id: 'menu', popover: 'auto', children: 'Menu' }),
        node('label', 'label', { htmlFor: 'field', children: 'Name' }),
        node('field', 'input', { id: 'field' }));
      await open(collection(template), rowsOf(3));
      await page.locator('[data-t="open"]').nth(2).click();
      expect(await page.locator('[data-t="menu"]').evaluateAll((all) => all.map((target) => target.matches(':popover-open')))).toEqual([false, false, true]);
      await page.keyboard.press('Escape');
      await page.locator('[data-t="label"]').nth(1).click();
      expect(await page.locator('[data-t="field"]').evaluateAll((all) => all.map((target) => target === document.activeElement))).toEqual([false, true, false]);
    });

    it('leaves no repeated id and no dangling reference in the document', async () => {
      const template = node('tpl', 'li', {},
        node('label', 'label', { htmlFor: 'field', id: 'name', children: 'Name' }),
        node('field', 'input', { id: 'field', 'aria-labelledby': 'name', 'aria-describedby': 'hint', 'aria-controls': 'menu', 'aria-owns': 'menu', 'aria-activedescendant': 'hint' }),
        node('hint', 'p', { id: 'hint', children: 'Hint' }),
        node('jump', 'a', { href: '#hint', children: 'Jump' }),
        node('open', 'button', { popoverTarget: 'menu', commandFor: 'menu', command: 'toggle-popover', children: 'Open' }),
        node('menu', 'div', { id: 'menu', popover: 'auto' }));
      await open(collection(template), rowsOf(4));
      const problems = await page.evaluate(() => {
        const ids = [...document.querySelectorAll('[id]')].map((target) => target.id);
        const known = new Set(ids);
        const found = ids.filter((id, index) => ids.indexOf(id) !== index);
        for (const attr of ['for', 'aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'aria-activedescendant', 'popovertarget', 'commandfor']) {
          for (const target of document.querySelectorAll(`[${attr}]`)) {
            for (const id of (target.getAttribute(attr) ?? '').split(' ')) if (!known.has(id)) found.push(`${attr}: ${id}`);
          }
        }
        for (const target of document.querySelectorAll('a[href^="#"]')) {
          if (!known.has((target.getAttribute('href') ?? '').slice(1))) found.push(target.getAttribute('href') ?? '');
        }
        return { found, count: ids.length };
      });
      expect(problems).toEqual({ found: [], count: 16 });
    });
  });
});

// The consent banner against everything a stored page can stack over it, in real
// browsers at a phone and a desktop width: a z-index on every path that writes one
// (src/lib/styles/stacking.ts), and the top layer, which is above every z-index
// (the guard in consentRuntimeScript, src/lib/consent/consent.ts). The pages go
// through renderPublishedPage with analytics on, so the banner, the sticky bar and
// the sheet are the ones a visitor gets, on the real published base.
//
// The detector is a real click: Playwright clicks only an element that is the
// hit target at its own centre, so a node covering a button fails the click. Both
// buttons are tried, Decline as a trial (it would close the banner) and Accept for
// real, and the recorded choice is read back.

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CONSENT_TAP_GUARD_MS } from '@/lib/consent/consent';
import { describe, expect, it, vi } from 'vitest';
import { chromium, webkit, type BrowserType, type Page } from 'playwright';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import type { CmsReadRepository } from '@/server/cms';
import { renderPublishedPage } from '@/lib/renderer/server/renderPublishedPage';
import { CONSENT_BANNER_Z_INDEX, STORED_Z_INDEX_MAX } from '@/lib/styles/stacking';
import { BREAKPOINTS, publishedDocument } from '../score/lib/published';

const ORIGIN = 'https://stacking.test/';
const WIDTHS = [{ width: 390, height: 844 }, { width: 1280, height: 800 }] as const;
const TOP = 2147483647;

const node = (id: string, type: string, props: Record<string, unknown> = {}, children: ComponentNode[] = []): ComponentNode =>
  ({ id, type, props, children }) as ComponentNode;

/** A white sheet over the whole viewport: what covers the banner if anything does. */
const COVER = { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#fff' };

interface Probe {
  id: string;
  what: string;
  nodes: ComponentNode[];
  /** What the page itself does before the banner is tried (the behaviour runtime, a visitor's click). */
  act?: (page: Page) => Promise<void>;
  /** The node whose computed z-index must stay at or below the ceiling. */
  covers?: string;
  /** A top layer route: the guard must have closed something, so the probe is not passing on a layer that never opened. */
  topLayer?: true;
}

const PROBES: Probe[] = [
  { id: 'inline-number', what: 'a fixed node at z-index 2147483647, a number', nodes: [node('cover', 'div', { id: 'cover', style: { ...COVER, zIndex: TOP } })], covers: '#cover' },
  { id: 'inline-string', what: 'a fixed node at z-index "2147483647"', nodes: [node('cover', 'div', { id: 'cover', style: { ...COVER, inset: '0', zIndex: String(TOP) } })], covers: '#cover' },
  // The published path does not apply a top-level CSS prop, so this one only has to not cover.
  { id: 'top-level-prop', what: 'the z-index as a top-level prop', nodes: [node('cover', 'div', { id: 'cover', zIndex: TOP, style: COVER })] },
  {
    id: 'responsive-map',
    what: 'a responsive z-index map',
    nodes: [node('cover', 'div', { id: 'cover', style: { ...COVER, zIndex: { base: TOP, mobile: String(TOP) } } })],
    covers: '#cover',
  },
  {
    id: 'rule-important',
    what: 'a rule &:not(#n){z-index:2147483647 !important}',
    nodes: [node('cover', 'div', { id: 'cover', style: { ...COVER, zIndex: 1 }, rules: [{ id: 'up', selector: '&:not(#n)', style: { zIndex: `${TOP} !important` } }] })],
    covers: '#cover',
  },
  {
    id: 'rule-calc',
    what: 'a rule with calc() past the integer range',
    nodes: [node('cover', 'div', { id: 'cover', style: COVER, rules: [{ id: 'up', selector: '&', style: { zIndex: `calc(${TOP} * 4) !important` } }] })],
    covers: '#cover',
  },
  {
    id: 'custom-property',
    what: 'z-index: var(--z), the property at 2147483647',
    nodes: [node('cover', 'div', { id: 'cover', style: { ...COVER, '--z': String(TOP), zIndex: 'var(--z)' } })],
    covers: '#cover',
  },
  {
    id: 'custom-property-later',
    what: 'z-index: var(--z), the property raised after load (as the behaviour runtime writes one)',
    nodes: [node('cover', 'div', { id: 'cover', style: { ...COVER, '--z': '1', zIndex: 'var(--z)' } })],
    act: (page) => page.evaluate((top) => document.getElementById('cover')!.style.setProperty('--z', String(top)), TOP),
    covers: '#cover',
  },
  {
    id: 'keyframes',
    what: 'a keyframe holding z-index at 2147483647',
    nodes: [
      node('cover', 'div', {
        id: 'cover',
        style: { ...COVER, zIndex: 1, animationName: 'u-top', animationDuration: '1000s', animationFillMode: 'both' },
        rules: [{ id: 'kf', define: '@keyframes u-top', blocks: [{ selector: 'from', style: { zIndex: String(TOP) } }, { selector: 'to', style: { zIndex: String(TOP) } }] }],
      }),
    ],
    covers: '#cover',
  },
  {
    id: 'sticky-bar',
    what: 'the sticky bar raised by a rule, and scaled over the page',
    nodes: [
      node('bar', 'div', {
        'data-sticky-cta': 'bar',
        ctaLabel: 'Book',
        ctaHref: '#top',
        style: { backgroundColor: '#fff' },
        rules: [{ id: 'up', selector: '&:not(#n)', style: { zIndex: `${TOP} !important`, transform: 'scale(50) !important' } }],
      }),
    ],
    covers: '[data-fc-sticky-cta]',
  },
  {
    id: 'select-picker',
    what: 'a customizable select whose ::picker(select) fills the screen, tapped open',
    nodes: [
      node('sel', 'select', {
        id: 'sel',
        style: { position: 'absolute', top: 8, left: 8 },
        rules: [
          { id: 'a', selector: '&', style: { appearance: 'base-select' } },
          {
            id: 'b',
            selector: '&::picker(select)',
            style: { appearance: 'base-select', position: 'fixed', top: '0', left: '0', right: '0', bottom: '0', width: '100vw', height: '100vh' },
          },
          { id: 'c', selector: '& option', style: { display: 'none' } },
        ],
      }, [node('one', 'option', { value: '1', children: 'One' }), node('two', 'option', { value: '2', children: 'Two' })]),
    ],
    act: async (page) => {
      await page.click('#sel');
    },
  },
  {
    id: 'select-inline',
    what: 'base-select inline and through a custom property, tapped open',
    nodes: [
      node('sel', 'select', { id: 'sel', style: { position: 'absolute', top: 8, left: 8, '--a': 'base-select', appearance: 'var(--a)' } }, [
        node('one', 'option', { value: '1', children: 'One' }),
      ]),
      node('sel2', 'select', { id: 'sel2', style: { position: 'absolute', top: 48, left: 8, appearance: 'base-select' } }, [
        node('one2', 'option', { value: '1', children: 'One' }),
      ]),
    ],
    act: async (page) => {
      await page.click('#sel');
      await page.keyboard.press('Tab');
      await page.click('#sel2');
    },
  },
  {
    id: 'popover',
    topLayer: true,
    what: 'a full-viewport popover a visitor opens with popovertarget',
    nodes: [
      node('open', 'button', { id: 'open', popovertarget: 'pop', style: { position: 'absolute', top: 8, left: 8 }, children: 'Open' }),
      node('pop', 'div', { id: 'pop', popover: 'manual', style: { ...COVER, width: '100vw', height: '100vh', margin: 0, border: 0 }, children: 'Covering' }),
    ],
    act: async (page) => {
      await page.click('#open');
    },
  },
  {
    id: 'popover-dialog',
    topLayer: true,
    what: 'a full-viewport dialog with a popover attribute, opened with showPopover (open in the top layer, but not modal)',
    nodes: [
      node('open', 'button', { id: 'open', popovertarget: 'pdlg', style: { position: 'absolute', top: 8, left: 8 }, children: 'Open' }),
      node('pdlg', 'dialog', { id: 'pdlg', popover: 'manual', style: { ...COVER, width: '100vw', height: '100vh', maxWidth: 'none', maxHeight: 'none', margin: 0, border: 0 }, children: 'Covering' }),
    ],
    act: async (page) => {
      await page.click('#open');
    },
  },
  {
    id: 'modal',
    topLayer: true,
    what: 'a modal dialog, by command="show-modal" where the engine has it, else as the behaviour verb opens one',
    nodes: [
      node('open', 'button', { id: 'open', commandfor: 'dlg', command: 'show-modal', style: { position: 'absolute', top: 8, left: 8 }, children: 'Open' }),
      node('dlg', 'dialog', { id: 'dlg', style: { width: '100vw', height: '100vh', maxWidth: 'none', maxHeight: 'none', margin: 0 }, children: 'Covering' }),
    ],
    act: async (page) => {
      await page.click('#open');
      await page.evaluate(() => {
        const dialog = document.getElementById('dlg') as HTMLDialogElement;
        if (!dialog.open) dialog.showModal();
      });
    },
  },
  {
    id: 'fullscreen',
    topLayer: true,
    what: 'fullscreen, entered on a press as the behaviour verb does',
    nodes: [
      node('open', 'button', { id: 'open', style: { position: 'absolute', top: 8, left: 8 }, children: 'Open' }),
      node('full', 'div', { id: 'full', style: { backgroundColor: '#fff' }, children: 'Covering' }),
    ],
    act: async (page) => {
      await page.evaluate(() => {
        document.getElementById('open')!.addEventListener('click', () => {
          void document.getElementById('full')!.requestFullscreen?.().catch(() => {});
        });
      });
      await page.click('#open');
      await page.waitForTimeout(200);
    },
  },
];

const cmsRepo = { listRows: async () => ({ rows: [] }), getRow: async () => null } as unknown as CmsReadRepository;

async function documentFor(nodes: ComponentNode[]): Promise<string> {
  const { body } = await renderPublishedPage({
    root: node('page', 'main', { style: { minHeight: '100vh' } }, nodes),
    pageParams: {},
    cmsRepo,
    breakpoints: BREAKPOINTS,
    analytics: { enabled: true, ingestionKey: 'public-test-key', ingestionEndpoint: 'https://ingest.stacking.test/e', projectId: 'p' },
  });
  return publishedDocument({ html: renderToStaticMarkup(React.createElement(React.Fragment, null, body)), css: '' });
}

const choice = () => (window as unknown as { __lumitraConsent: { get: () => string | null } }).__lumitraConsent.get();

async function open(type: BrowserType, html: string, viewport: { width: number; height: number }) {
  const browser = await type.launch();
  const page = await browser.newPage({ viewport });
  page.setDefaultTimeout(3_000);
  await page.route('**/*', (route) =>
    route.request().url() === ORIGIN ? route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }) : route.fulfill({ status: 204 }),
  );
  const warnings: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'warning') warnings.push(message.text());
  });
  await page.goto(ORIGIN);
  return { page, warnings, close: () => browser.close() };
}

/** Both buttons can be pressed, and pressing Accept records the choice. */
async function bannerAnswers(page: Page): Promise<void> {
  await page.locator('[data-fc-consent-decline]').click({ trial: true });
  await page.locator('[data-fc-consent-accept]').click();
  expect(await page.evaluate(choice)).toBe('granted');
}

const ENGINES = [['chromium', chromium], ['webkit', webkit]] as [string, BrowserType][];

describe('nothing stored covers the consent banner', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  for (const [name, type] of ENGINES) {
    for (const viewport of WIDTHS) {
      it.each(PROBES.map((probe) => [probe.id, probe] as const))(`${name} at ${viewport.width}: %s`, async (_id, probe) => {
        const { page, warnings, close } = await open(type, await documentFor(probe.nodes), viewport);
        try {
          await probe.act?.(page);
          if (probe.topLayer) expect(warnings.some((text) => text.startsWith('[consent] closed')), `${probe.what}: nothing was opened and closed`).toBe(true);
          if (probe.covers) {
            const z = await page.evaluate((selector) => getComputedStyle(document.querySelector(selector)!).zIndex, probe.covers);
            expect(Number(z), `${probe.what}: computed z-index ${z}`).toBeLessThanOrEqual(STORED_Z_INDEX_MAX);
          }
          expect(await page.evaluate(() => getComputedStyle(document.getElementById('fc-consent')!).zIndex)).toBe(String(CONSENT_BANNER_Z_INDEX));
          await bannerAnswers(page);
          const topLayer = await page.evaluate(() => ({
            full: Boolean(document.fullscreenElement),
            modal: Boolean(document.querySelector('dialog:modal')),
            // A select keeps the browser's own list: a base-select picker would sit in the top layer.
            picker: Array.from(document.querySelectorAll('select')).some((select) => getComputedStyle(select).appearance === 'base-select'),
            popover: (() => {
              try {
                return Boolean(document.querySelector(':popover-open'));
              } catch {
                return false;
              }
            })(),
          }));
          expect(topLayer, probe.what).toEqual({ full: false, modal: false, picker: false, popover: false });
        } finally {
          await close();
        }
      }, 60_000);
    }

    it(`${name}: reopening the banner closes what the page opened, and the page has the top layer back after a choice`, async () => {
      const probe = PROBES.find((p) => p.id === 'popover')!;
      const { page, close } = await open(type, await documentFor(probe.nodes), { width: 390, height: 844 });
      try {
        await bannerAnswers(page);
        await page.click('#open');
        expect(await page.evaluate(() => document.getElementById('pop')!.matches(':popover-open'))).toBe(true);
        // The footer's "Cookie settings" link calls the same open().
        await page.evaluate(() => (window as unknown as { __lumitraConsent: { open: () => void } }).__lumitraConsent.open());
        expect(await page.evaluate(() => document.getElementById('pop')!.matches(':popover-open'))).toBe(false);
        // A banner opened from outside it ignores pointer clicks for a moment (the tap
        // guard, CONSENT_TAP_GUARD_MS in src/lib/consent/consent.ts), as a visitor's would.
        await page.waitForTimeout(CONSENT_TAP_GUARD_MS + 100);
        await page.locator('[data-fc-consent-decline]').click();
        expect(await page.evaluate(choice)).toBe('denied');
        await page.click('#open');
        expect(await page.evaluate(() => document.getElementById('pop')!.matches(':popover-open'))).toBe(true);
      } finally {
        await close();
      }
    }, 60_000);

    it(`${name}: an ordinary page keeps its own z-index and its banner`, async () => {
      const html = await documentFor([
        node('header', 'header', { id: 'header', style: { position: 'sticky', top: 0, zIndex: 50, height: 64, backgroundColor: '#eee' } }),
        node('menu', 'nav', { id: 'menu', style: { position: 'fixed', right: 0, top: 64, zIndex: '999999999', width: 120, height: 200 } }),
        node('below', 'div', { id: 'below', style: { position: 'relative', zIndex: -1 } }),
      ]);
      for (const viewport of WIDTHS) {
        const { page, close } = await open(type, html, viewport);
        try {
          const z = await page.evaluate(() => ['header', 'menu', 'below'].map((id) => getComputedStyle(document.getElementById(id)!).zIndex));
          expect(z).toEqual(['50', '999999999', '-1']);
          await bannerAnswers(page);
        } finally {
          await close();
        }
      }
    }, 60_000);
  }
});

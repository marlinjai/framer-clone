// The held-out corpus: real pages of the BusBasis storefront, frozen from the live
// site, next to node trees lifted from them. "Every BusBasis page passes" is the stop
// condition of the primitive stream, so a page passes only when every check passes at
// every breakpoint AND it needs nothing that is not built. See test/score/corpus/busbasis.
//
// A refused hash stops the run: nothing here may change without a new capture.
//
// A BusBasis page brings its own base: the storefront's Tailwind reset is in its sheet,
// and the lift writes it onto every node. So its replica sits on a site that keeps
// browser defaults (Page base in Site settings, src/lib/site/pageBase.ts), where our
// reset and the root layout's `antialiased` body step aside and the page's own base
// stands. Measured on 2026-11-02: on the default base, where our reset stays, every
// element differs in font smoothing and `<option>` loses its padding, and both are gone
// on this base. The default base is still compared, untouched, so that number stays in
// the report.
//
// The site's language is the page's own `<html lang>`, which the lift records, and the
// document element is compared like any other element: what the original sets on html
// the replica holds as rules on `:root` on its page root.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { MAX_DIFF_RATIO, diffComputed, diffRatio, takeSnapshot, type ComputedDiff, type Snapshot } from './lib/compare';
import { BREAKPOINTS, bareDocument, publishedDocument, renderPublished, type PublishedOutput } from './lib/published';
import { normalizeSiteSettings } from '@/lib/site/siteSettings';
import { withMapLanguage } from '@/lib/mapEmbed/mapEmbed';
import { OUT_DIR, writeOut } from './lib/io';
import { BUSBASIS_PAGES } from './busbasis/pages';
import { CORPUS_DIR, SHARED_SHEET, SHEET_MARKER } from './busbasis/freeze';
import { classifyDifferences } from './busbasis/classify';
import type { CheckName, CorpusFailure, CorpusResult, GapId, PageDifference } from './lib/types';

const TIMEOUT = 25 * 60 * 1000;

/**
 * One step of opening a page: loading it, the hover, the wait for its transitions. The
 * captures have their own budget (CAPTURE_TIMEOUT_MS). Measured on 2026-11-02 over every
 * page and breakpoint, with 28 busy loops beside the fleet (load average 250 on 14 cores):
 * loading at most 168 ms, a hover with its transitions at most 76 ms. So 5 seconds is
 * thirty times the worst seen, and a step that takes longer is stuck, not slow.
 */
const STEP_TIMEOUT_MS = 5_000;

/** The Site settings of the site a BusBasis replica sits on, in the page's language. */
const busbasisSite = (lang: string) => {
  const site = normalizeSiteSettings({ pageBase: 'browser', language: lang });
  if (site.language !== lang) throw new Error(`the page's language ${JSON.stringify(lang)} is not one a site can hold`);
  return site;
};

interface ManifestPage {
  slug: string;
  pageType: string;
  source: string;
  capturedAt: string;
  status: number;
  hoverTarget: string | null;
  /** `<html lang>` of the frozen page. */
  lang: string;
}

interface Manifest {
  pages: ManifestPage[];
  sha256: Record<string, string>;
}

function readManifest(): Manifest {
  const manifest = JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, 'manifest.json'), 'utf8')) as Manifest;
  for (const [name, expected] of Object.entries(manifest.sha256)) {
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(CORPUS_DIR, name))).digest('hex');
    if (actual !== expected) throw new Error(`held-out fixture changed: ${name}. These files come from a capture, never from a slice.`);
  }
  return manifest;
}

const readTree = (slug: string) =>
  JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(CORPUS_DIR, 'pages', `${slug}.tree.json.gz`))).toString()) as ComponentNode;

function originalDocument(slug: string): string {
  const css = fs.readFileSync(path.join(CORPUS_DIR, SHARED_SHEET), 'utf8');
  return fs.readFileSync(path.join(CORPUS_DIR, 'pages', `${slug}.html`), 'utf8').replace(SHEET_MARKER, () => `<style>${css}</style>`);
}

/** Moving parts stopped at their start on both sides, so a snapshot is repeatable. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.getAnimations().forEach((animation) => {
      animation.pause();
      animation.currentTime = 0;
    });
    document.querySelectorAll('svg').forEach((svg) => {
      svg.pauseAnimations();
      svg.setCurrentTime(0);
    });
  });
}

/**
 * The hover's transitions have run to their end. Keyframe animations are paused by
 * `settle`, so what still runs here is what the hover started. A fixed 350 ms wait could
 * end before a transition did on a loaded machine, and `settle` then pinned it to its start.
 */
const transitionsDone = (page: Page) =>
  page.waitForFunction(() => !document.getAnimations().some((motion) => motion instanceof CSSTransition && motion.playState === 'running'));

async function open(browser: Browser, html: string, viewport: { width: number; height: number }, hover: string | null): Promise<Page> {
  const page = await browser.newPage({ viewport, reducedMotion: 'no-preference', colorScheme: 'dark' });
  page.setDefaultTimeout(STEP_TIMEOUT_MS);
  // A frozen page holds no address. If one slips through it must fail, not depend on the network.
  await page.route('**/*', (route) => route.abort());
  await page.setContent(html);
  await page.waitForFunction(() => document.querySelector('[data-parity-id]') !== null);
  await settle(page);
  if (hover) {
    await page.locator(`[data-parity-id="${hover}"]`).hover();
    await transitionsDone(page);
    await settle(page);
  }
  return page;
}

describe('held-out BusBasis pages', () => {
  let browser: Browser;

  beforeAll(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('compares every captured page at every breakpoint', { timeout: TIMEOUT }, async () => {
    const manifest = readManifest();
    const results: CorpusResult[] = [];

    for (const listed of BUSBASIS_PAGES) {
      const meta = manifest.pages.find((page) => page.slug === listed.slug);
      if (!meta) throw new Error(`${listed.slug} is listed but has no capture`);
      const original = originalDocument(listed.slug);
      // A map speaks the site's language, which the published route writes on it before rendering.
      const output: PublishedOutput = renderPublished(withMapLanguage(readTree(listed.slug), meta.lang).root);
      const site = busbasisSite(meta.lang);
      const replica = publishedDocument(output, site.pageBase, site.language);
      const onDefaultBase = publishedDocument(output, undefined, site.language);
      const bare = bareDocument(output, site.language);

      const fixture = `busbasis-${listed.slug}`;
      const failures: CorpusFailure[] = [];
      const differences: PageDifference[] = [];
      const defaultBase = { pass: 0, total: 0 };
      const checks: CorpusResult['checks'] = {
        screenshot: { pass: 0, total: 0 },
        'computed-styles': { pass: 0, total: 0 },
        'accessibility-tree': { pass: 0, total: 0 },
        interaction: { pass: 0, total: 0 },
      };
      const record = (viewport: string, state: string, check: CheckName, gap: GapId, ok: boolean, detail: string) => {
        checks[check].total += 1;
        if (ok) checks[check].pass += 1;
        else failures.push({ fixture, viewport, state, check, gap, detail: detail.slice(0, 240) });
      };

      for (const breakpoint of BREAKPOINTS) {
        const viewport = { width: breakpoint.width, height: breakpoint.height };
        let initial: Snapshot | undefined;

        // Hover is a desktop state, and each full-page comparison costs seconds.
        const hoverHere = meta.hoverTarget && breakpoint.id === 'desktop';
        for (const stateId of [undefined, ...(hoverHere ? [`hover ${meta.hoverTarget}`] : [])]) {
          const hover = stateId ? meta.hoverTarget : null;
          const left = await open(browser, original, viewport, hover);
          let right: Page;
          let interactionError: string | undefined;
          try {
            right = await open(browser, replica, viewport, hover);
          } catch (error) {
            interactionError = (error instanceof Error ? error.message : String(error)).split('\n')[0];
            right = await open(browser, replica, viewport, null);
          }
          const a = await takeSnapshot(left, { withoutVariables: true, withDocument: true });
          const b = await takeSnapshot(right, { withoutVariables: true, withDocument: true });
          await left.close();
          await right.close();

          const label = stateId ?? 'initial';
          if (!stateId) initial = a;
          else if (initial) {
            const unchanged = diffComputed(initial.computed, a.computed).count === 0 && initial.aria === a.aria;
            expect(unchanged, `${fixture}: "${label}" changes nothing on the original`).toBe(false);
          }

          const file = path.join(OUT_DIR, 'diffs', `${fixture}-${breakpoint.id}-${label.replace(/\W+/g, '-')}.png`);
          const ratio = diffRatio(a.png, b.png, file);
          const computed: ComputedDiff = diffComputed(a.computed, b.computed);
          const pixelsOk = ratio <= MAX_DIFF_RATIO;
          const stylesOk = computed.count === 0;
          const treeOk = a.aria === b.aria;

          // Only a failure needs a cause. The bare page answers whether the base is it.
          let withoutBase: { pixels: boolean; styles: boolean; tree: boolean; computed: ComputedDiff } | undefined;
          if (!pixelsOk || !stylesOk || !treeOk) {
            const page = await open(browser, bare, viewport, hover).catch(() => undefined);
            if (page) {
              const snapshot = await takeSnapshot(page, { withoutVariables: true, withDocument: true });
              await page.close();
              const bareComputed = diffComputed(a.computed, snapshot.computed);
              withoutBase = {
                pixels: diffRatio(a.png, snapshot.png, path.join(OUT_DIR, 'scratch.png')) <= MAX_DIFF_RATIO,
                styles: bareComputed.count === 0,
                tree: a.aria === snapshot.aria,
                computed: bareComputed,
              };
            }
          }

          const classified = classifyDifferences(computed, withoutBase?.computed);
          const gap: GapId = computed.textLost ? 'mixed-text' : computed.count === 0 && stateId ? 'selector-styles' : classified.top;
          const ariaGap: GapId = computed.byProperty.missing ? 'blocked-embedded-content' : gap;
          /** A check that fails here and passes with no base at all is the base's. */
          const cause = (passesBare: boolean | undefined, own: GapId): GapId => (passesBare ? 'published-base' : own);
          differences.push({ viewport: breakpoint.label, state: label, ratio, elementsCompared: Object.keys(a.computed).length, elementsDiffering: computed.elements.length, differences: computed.count, byGap: classified.byGap, byProperty: classified.topProperties });

          record(breakpoint.label, label, 'screenshot', cause(withoutBase?.pixels, gap), pixelsOk, `${(ratio * 100).toFixed(2)} percent of pixels differ`);
          record(breakpoint.label, label, 'computed-styles', cause(withoutBase?.styles, gap), stylesOk, `${computed.count} differences on ${computed.elements.length} elements, first: ${computed.firstDetail}`);
          record(breakpoint.label, label, 'accessibility-tree', cause(withoutBase?.tree, ariaGap), treeOk, `original ${JSON.stringify(a.aria.slice(0, 120))}, replica ${JSON.stringify(b.aria.slice(0, 120))}`);
          if (stateId) {
            const landed = !interactionError && pixelsOk && stylesOk && treeOk;
            const bareLanded = !interactionError && withoutBase && withoutBase.pixels && withoutBase.styles && withoutBase.tree;
            record(breakpoint.label, label, 'interaction', cause(bareLanded, gap), landed, interactionError ?? 'the replica did not end up where the original did');
          } else {
            // The same replica on the default base, untouched: all three checks at once.
            const page = await open(browser, onDefaultBase, viewport, null);
            const snapshot = await takeSnapshot(page, { withoutVariables: true, withDocument: true });
            await page.close();
            const same =
              diffRatio(a.png, snapshot.png, path.join(OUT_DIR, 'scratch.png')) <= MAX_DIFF_RATIO &&
              diffComputed(a.computed, snapshot.computed).count === 0 &&
              a.aria === snapshot.aria;
            defaultBase.total += 1;
            if (same) defaultBase.pass += 1;
          }
        }
      }

      for (const need of listed.needs) record('all', `needs: ${need.id}`, 'interaction', need.gap, false, need.reason);

      results.push({
        fixture,
        group: 'held-out',
        source: `${meta.source}, captured ${meta.capturedAt.slice(0, 10)}, answered ${meta.status}`,
        pass: failures.length === 0,
        checks,
        failures,
        notMeasured: [],
        defaultBase,
        pageType: listed.pageType,
        differences,
      });
    }

    writeOut('busbasis', results);
  });
});

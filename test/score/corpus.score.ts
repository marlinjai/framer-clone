// The parity corpus: original and node tree, side by side in real Chromium, at each
// default breakpoint and in each scripted state. Four comparisons per state:
// screenshot, computed styles of the matched elements (with their ::before and
// ::after), accessibility tree, and, for a scripted state, whether the interaction
// landed the replica where it landed the original.
//
// Non-vacuous by construction: a scripted state that leaves the ORIGINAL unchanged
// is a harness error, so a fixture cannot "pass" a state that tests nothing.
//
// A fixture is a page written against the browser's own defaults, so its replica is
// on a site that chose that base (Site settings, src/lib/site/pageBase.ts), through
// the same sheet a visitor of that site gets. The same output is also compared on the
// default base, untouched, so that number stays in the report.

import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { build } from 'esbuild';
import { FIXTURES, fixtureFile, readFixtureFile, type Fixture, type FixtureState } from './corpus/fixtures';
import { BREAKPOINTS, bareDocument, publishedDocument, renderPublished } from './lib/published';
import { bundleRuntime } from './lib/runtime';
import { MAX_DIFF_RATIO, diffComputed, diffRatio, takeSnapshot, type Snapshot } from './lib/compare';
import { normalizeSiteSettings } from '@/lib/site/siteSettings';
import { OUT_DIR, writeOut } from './lib/io';
import type { CheckName, CorpusFailure, CorpusResult, GapId } from './lib/types';

/** The Site settings of the site every replica sits on. */
const CORPUS_SITE = normalizeSiteSettings({ pageBase: 'browser' });

async function originalDocument(fixture: Fixture): Promise<string> {
  if ('html' in fixture.original) return readFixtureFile(fixture.original.html);
  const { outputFiles } = await build({
    entryPoints: [fixtureFile(fixture.original.mount)],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
  });
  const script = outputFiles[0].text.replace(/<\/script/g, '<\\/script');
  const css = readFixtureFile(fixture.original.css);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${fixture.id}</title><style>${css}</style></head><body style="margin:0"><div id="root"></div><script>${script}</script></body></html>`;
}

async function open(browser: Browser, html: string, viewport: { width: number; height: number }, fixture: Fixture, state?: FixtureState) {
  const page = await browser.newPage({ viewport, reducedMotion: 'no-preference' });
  page.setDefaultTimeout(3000);
  await page.setContent(html);
  await page.waitForFunction(() => document.querySelector('[data-parity-id]') !== null);
  await fixture.prepare?.(page);
  if (state) {
    if (state.media) await page.emulateMedia({ media: state.media });
    await state.apply(page);
    await page.waitForTimeout(30);
  }
  return page;
}

describe('parity corpus', () => {
  let browser: Browser;
  let runtime: string;

  beforeAll(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    browser = await chromium.launch();
    runtime = await bundleRuntime();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('compares every fixture at every breakpoint in every state', async () => {
    const results: CorpusResult[] = [];

    for (const fixture of FIXTURES) {
      const original = await originalDocument(fixture);
      const output = fixture.published ? await fixture.published() : renderPublished(fixture.tree());
      const replica = publishedDocument(output, CORPUS_SITE.pageBase, undefined, runtime);
      const onDefaultBase = publishedDocument(output, undefined, undefined, runtime);
      const bare = bareDocument(output, undefined, runtime);
      const defaultBase = { pass: 0, total: 0 };
      const failures: CorpusFailure[] = [];
      const checks: CorpusResult['checks'] = {
        screenshot: { pass: 0, total: 0 },
        'computed-styles': { pass: 0, total: 0 },
        'accessibility-tree': { pass: 0, total: 0 },
        interaction: { pass: 0, total: 0 },
      };

      const record = (viewport: string, state: string, check: CheckName, gap: GapId, ok: boolean, detail: string) => {
        checks[check].total += 1;
        if (ok) checks[check].pass += 1;
        else failures.push({ fixture: fixture.id, viewport, state, check, gap, detail: detail.slice(0, 240) });
      };

      for (const breakpoint of BREAKPOINTS) {
        const viewport = { width: breakpoint.width, height: breakpoint.height };
        let initialOriginal: Snapshot | undefined;

        for (const state of [undefined, ...fixture.states]) {
          const stateId = state?.id ?? 'initial';
          const left = await open(browser, original, viewport, fixture, state);
          let right: Page;
          let interactionError: string | undefined;
          try {
            right = await open(browser, replica, viewport, fixture, state);
          } catch (error) {
            // The state's action itself failed on the replica. The page stays as far as it got.
            interactionError = (error instanceof Error ? error.message : String(error)).split('\n')[0];
            right = await open(browser, replica, viewport, fixture);
          }
          const a = await takeSnapshot(left);
          const b = await takeSnapshot(right);
          await left.close();
          await right.close();

          /** Which checks would pass without the page base: those failures are the base's, whatever the fixture is about. */
          const passesBare = async (): Promise<Set<CheckName>> => {
            // A state that cannot be applied on the bare page is not the base's doing: it keeps the fixture's own gap.
            const page = await open(browser, bare, viewport, fixture, state).catch(() => undefined);
            if (!page) return new Set();
            const snapshot = await takeSnapshot(page);
            await page.close();
            const pixels = diffRatio(a.png, snapshot.png, path.join(OUT_DIR, 'scratch.png')) <= MAX_DIFF_RATIO;
            const styles = diffComputed(a.computed, snapshot.computed).count === 0;
            const tree = a.aria === snapshot.aria;
            const passing: CheckName[] = [];
            if (pixels) passing.push('screenshot');
            if (styles) passing.push('computed-styles');
            if (tree) passing.push('accessibility-tree');
            if (pixels && styles && tree) passing.push('interaction');
            return new Set(passing);
          };

          if (!state) {
            const page = await open(browser, onDefaultBase, viewport, fixture);
            const snapshot = await takeSnapshot(page);
            await page.close();
            const same =
              diffRatio(a.png, snapshot.png, path.join(OUT_DIR, 'scratch.png')) <= MAX_DIFF_RATIO &&
              diffComputed(a.computed, snapshot.computed).count === 0 &&
              a.aria === snapshot.aria;
            defaultBase.total += 1;
            if (same) defaultBase.pass += 1;
          }

          if (!state) initialOriginal = a;
          else if (initialOriginal && !state.media) {
            const unchanged =
              diffRatio(initialOriginal.png, a.png, path.join(OUT_DIR, 'scratch.png')) === 0 &&
              diffComputed(initialOriginal.computed, a.computed).count === 0 &&
              initialOriginal.aria === a.aria;
            // Vacuous state: nothing to compare, so the harness itself is wrong.
            expect(unchanged, `${fixture.id}: "${stateId}" changes nothing on the original`).toBe(false);
          }

          const file = path.join(OUT_DIR, 'diffs', `${fixture.id}-${breakpoint.id}-${stateId.replace(/\W+/g, '-')}.png`);
          const ratio = diffRatio(a.png, b.png, file);
          const computed = diffComputed(a.computed, b.computed);
          // Text missing from the untouched page is lost content; after an
          // interaction it is the state that did not change. So the state decides there.
          const gap: GapId = state ? state.gap : computed.textLost ? 'mixed-text' : computed.pseudo ? 'selector-styles' : fixture.initialGap;

          const landed = !interactionError && ratio <= MAX_DIFF_RATIO && computed.count === 0 && a.aria === b.aria;
          const fromBase = landed ? new Set<CheckName>() : await passesBare();
          const gapOf = (check: CheckName): GapId => (fromBase.has(check) ? 'published-base' : gap);

          record(breakpoint.label, stateId, 'screenshot', gapOf('screenshot'), ratio <= MAX_DIFF_RATIO, `${(ratio * 100).toFixed(2)} percent of pixels differ`);
          record(
            breakpoint.label,
            stateId,
            'computed-styles',
            gapOf('computed-styles'),
            computed.count === 0,
            `${computed.count} differences, first: ${computed.firstDetail}`,
          );
          record(
            breakpoint.label,
            stateId,
            'accessibility-tree',
            gapOf('accessibility-tree'),
            a.aria === b.aria,
            `original ${JSON.stringify(a.aria.slice(0, 120))}, replica ${JSON.stringify(b.aria.slice(0, 120))}`,
          );
          if (state) {
            record(breakpoint.label, stateId, 'interaction', gapOf('interaction'), landed, interactionError ?? 'the replica did not end up where the original did');
          }
        }
      }

      results.push({
        fixture: fixture.id,
        group: fixture.group,
        source: fixture.source,
        pass: failures.length === 0,
        checks,
        failures,
        notMeasured: fixture.notMeasured ?? [],
        defaultBase,
      });
    }

    writeOut('corpus', results);
  });
});

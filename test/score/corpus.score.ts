// The parity corpus: original and node tree, side by side in real Chromium, at each
// default breakpoint and in each scripted state. Four comparisons per state:
// screenshot, computed styles of the matched elements (with their ::before and
// ::after), accessibility tree, and, for a scripted state, whether the interaction
// landed the replica where it landed the original.
//
// Non-vacuous by construction: a scripted state that leaves the ORIGINAL unchanged
// is a harness error, so a fixture cannot "pass" a state that tests nothing.

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { build } from 'esbuild';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { FIXTURES, fixtureFile, readFixtureFile, type Fixture, type FixtureState } from './corpus/fixtures';
import { BREAKPOINTS, publishedDocument, renderPublished } from './lib/published';
import { OUT_DIR, writeOut } from './lib/io';
import type { CheckName, CorpusFailure, CorpusResult, GapId } from './lib/types';

/** Per-pixel colour tolerance of pixelmatch, and the share of pixels allowed to differ. */
const PIXEL_THRESHOLD = 0.1;
const MAX_DIFF_RATIO = 0.001;

interface Snapshot {
  png: Buffer;
  computed: Record<string, ElementFacts>;
  aria: string;
}

interface ElementFacts {
  text: string;
  styles: Record<string, string>;
  before: Record<string, string>;
  after: Record<string, string>;
}

async function takeSnapshot(page: Page): Promise<Snapshot> {
  const computed = await page.evaluate(() => {
    const dump = (style: CSSStyleDeclaration) => {
      const out: Record<string, string> = {};
      for (let i = 0; i < style.length; i++) {
        // Radix measures its panels in script and writes the sizes here: runtime
        // state, not a style the replica could or should author.
        if (!style[i].startsWith('--radix-')) out[style[i]] = style.getPropertyValue(style[i]);
      }
      return out;
    };
    const facts: Record<string, ElementFacts> = {};
    document.querySelectorAll('[data-parity-id]').forEach((el) => {
      facts[el.getAttribute('data-parity-id') as string] = {
        // Words only: the source indentation of a hand-written page is not content.
        text: (el.textContent ?? '').replace(/\s+/g, ''),
        styles: dump(getComputedStyle(el)),
        before: dump(getComputedStyle(el, '::before')),
        after: dump(getComputedStyle(el, '::after')),
      };
    });
    return facts;
  });
  return {
    png: await page.screenshot({ fullPage: true }),
    computed,
    aria: await page.locator('body').ariaSnapshot(),
  };
}

function diffRatio(a: Buffer, b: Buffer, file: string): number {
  const left = PNG.sync.read(a);
  const right = PNG.sync.read(b);
  if (left.width !== right.width || left.height !== right.height) return 1;
  const diff = new PNG({ width: left.width, height: left.height });
  const count = pixelmatch(left.data, right.data, diff.data, left.width, left.height, { threshold: PIXEL_THRESHOLD });
  if (count > 0) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, PNG.sync.write(diff));
  }
  return count / (left.width * left.height);
}

interface ComputedDiff {
  count: number;
  firstDetail: string;
  textLost: boolean;
  pseudo: boolean;
}

function diffComputed(original: Snapshot['computed'], replica: Snapshot['computed']): ComputedDiff {
  const result: ComputedDiff = { count: 0, firstDetail: '', textLost: false, pseudo: false };
  const note = (detail: string) => {
    result.count += 1;
    if (!result.firstDetail) result.firstDetail = detail;
  };
  for (const [id, facts] of Object.entries(original)) {
    const other = replica[id];
    if (!other) {
      note(`${id}: not in the replica`);
      continue;
    }
    if (facts.text !== other.text) {
      result.textLost = true;
      note(`${id}: text ${JSON.stringify(facts.text.slice(0, 40))} became ${JSON.stringify(other.text.slice(0, 40))}`);
    }
    for (const [name, value] of Object.entries(facts.styles)) {
      if (other.styles[name] !== value) note(`${id}: ${name} ${value} became ${other.styles[name]}`);
    }
    for (const pseudo of ['before', 'after'] as const) {
      if (facts[pseudo].content !== other[pseudo].content) {
        result.pseudo = true;
        note(`${id}::${pseudo}: content ${facts[pseudo].content} became ${other[pseudo].content}`);
      }
    }
  }
  return result;
}

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

  beforeAll(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('compares every fixture at every breakpoint in every state', async () => {
    const results: CorpusResult[] = [];

    for (const fixture of FIXTURES) {
      const original = await originalDocument(fixture);
      const replica = publishedDocument(fixture.published ? await fixture.published() : renderPublished(fixture.tree()));
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

          record(breakpoint.label, stateId, 'screenshot', gap, ratio <= MAX_DIFF_RATIO, `${(ratio * 100).toFixed(2)} percent of pixels differ`);
          record(
            breakpoint.label,
            stateId,
            'computed-styles',
            gap,
            computed.count === 0,
            `${computed.count} differences, first: ${computed.firstDetail}`,
          );
          record(
            breakpoint.label,
            stateId,
            'accessibility-tree',
            gap,
            a.aria === b.aria,
            `original ${JSON.stringify(a.aria.slice(0, 120))}, replica ${JSON.stringify(b.aria.slice(0, 120))}`,
          );
          if (state) {
            const landed = !interactionError && ratio <= MAX_DIFF_RATIO && computed.count === 0 && a.aria === b.aria;
            record(breakpoint.label, stateId, 'interaction', gap, landed, interactionError ?? 'the replica did not end up where the original did');
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
      });
    }

    writeOut('corpus', results);
  });
});

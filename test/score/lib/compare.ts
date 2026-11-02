// What one page looks like to the corpus, and how two of them differ: screenshot,
// computed styles of the matched elements, accessibility tree. Shared by the small
// fixtures (corpus.score.ts) and the real pages (busbasis.score.ts).

import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

/** Per-pixel colour tolerance of pixelmatch, and the share of pixels allowed to differ. */
export const PIXEL_THRESHOLD = 0.1;
export const MAX_DIFF_RATIO = 0.001;

export interface ElementFacts {
  /** Every word in the element, rendered or not, so a hidden panel, menu or label counts. */
  text: string;
  /** The words as drawn: what is shown, after text-transform. */
  rendered: string;
  styles: Record<string, string>;
  before: string;
  after: string;
}

export interface Snapshot {
  png: Buffer;
  computed: Record<string, ElementFacts>;
  aria: string;
}

export interface SnapshotOptions {
  /** Leave custom properties out: on a real page they are the build tool's bookkeeping, and their effect shows in the properties that read them. */
  withoutVariables?: boolean;
  /**
   * Compare the document element too, under the key `html`. Its styles only: its text
   * is the whole document's, head included, and the page's words are compared on the
   * elements that hold them.
   */
  withDocument?: boolean;
}

/** The key the document element is compared under. No parity id can take it. */
export const DOCUMENT_KEY = 'html';

/**
 * How long one capture (the full-page screenshot, or the accessibility tree) may take,
 * apart from a page's own timeout for clicks and waits, because a capture that runs out of
 * time stops the whole score with no number. Measured on 2026-11-02 over the BusBasis
 * captures. Before `painted`, the screenshot also paid for the page's first layout and
 * paint: up to 2983 ms at load average 100, and one past the 5 seconds it then had, which
 * crashed the run. After it, in the BusBasis probe alone at load average 250, a screenshot
 * took at most 359 ms. In three full runs beside the agent fleet (load average 50 to 100,
 * swap full), the readiness wait, screenshot and tree together took at most 7559, 1997
 * and 1681 ms. 15 seconds is twice the worst of those. With 14 more busy loops on top
 * (load average 160 to 200) a screenshot passed 15 seconds in two runs of three: a machine
 * paging that hard is not one a score can be measured on, and it fails loudly.
 */
export const CAPTURE_TIMEOUT_MS = 15_000;

/**
 * The page has drawn what it shows: its fonts are settled and two frames have gone by, so
 * the capture starts on a finished page and its time is the capture's alone.
 */
export async function painted(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}

export async function takeSnapshot(page: Page, options: SnapshotOptions = {}): Promise<Snapshot> {
  const computed = await page.evaluate(({ withoutVariables, withDocument, documentKey }) => {
    const dump = (style: CSSStyleDeclaration) => {
      const out: Record<string, string> = {};
      for (let i = 0; i < style.length; i++) {
        const name = style[i];
        // Radix measures its panels in script and writes the sizes here: runtime
        // state, not a style the replica could or should author.
        if (name.startsWith('--radix-') || (withoutVariables && name.startsWith('--'))) continue;
        out[name] = style.getPropertyValue(name);
      }
      return out;
    };
    const facts: Record<string, ElementFacts> = {};
    document.querySelectorAll('[data-parity-id]').forEach((el) => {
      facts[el.getAttribute('data-parity-id') as string] = {
        // Words only: the source indentation of a hand-written page is not content. Both the
        // element's words and the words it draws, so neither hidden text nor a transform
        // that changes what is drawn can differ unseen.
        text: (el.textContent ?? '').replace(/\s+/g, ''),
        rendered: ((el as HTMLElement).innerText ?? '').replace(/\s+/g, ''),
        styles: dump(getComputedStyle(el)),
        before: getComputedStyle(el, '::before').content,
        after: getComputedStyle(el, '::after').content,
      };
    });
    if (withDocument) {
      if (documentKey in facts) throw new Error(`an element's parity id is "${documentKey}", the document's key`);
      const html = document.documentElement;
      facts[documentKey] = { text: '', rendered: '', styles: dump(getComputedStyle(html)), before: getComputedStyle(html, '::before').content, after: getComputedStyle(html, '::after').content };
    }
    return facts;
  }, { withoutVariables: options.withoutVariables ?? false, withDocument: options.withDocument ?? false, documentKey: DOCUMENT_KEY });
  await painted(page);
  return {
    png: await page.screenshot({ fullPage: true, timeout: CAPTURE_TIMEOUT_MS }),
    computed,
    aria: await page.locator('body').ariaSnapshot({ timeout: CAPTURE_TIMEOUT_MS }),
  };
}

export function diffRatio(a: Buffer, b: Buffer, file: string): number {
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

export interface ComputedDiff {
  count: number;
  firstDetail: string;
  textLost: boolean;
  pseudo: boolean;
  /** Differences per property, with `missing` for an element the replica does not have. */
  byProperty: Record<string, number>;
  /** Elements with at least one difference. */
  elements: string[];
}

export function diffComputed(original: Snapshot['computed'], replica: Snapshot['computed']): ComputedDiff {
  const result: ComputedDiff = { count: 0, firstDetail: '', textLost: false, pseudo: false, byProperty: {}, elements: [] };
  const touched = new Set<string>();
  const note = (id: string, property: string, detail: () => string) => {
    result.count += 1;
    result.byProperty[property] = (result.byProperty[property] ?? 0) + 1;
    touched.add(id);
    if (!result.firstDetail) result.firstDetail = detail();
  };
  for (const [id, facts] of Object.entries(original)) {
    const other = replica[id];
    if (!other) {
      note(id, 'missing', () => `${id}: not in the replica`);
      continue;
    }
    if (facts.text !== other.text) {
      result.textLost = true;
      note(id, 'text', () => `${id}: text ${JSON.stringify(facts.text.slice(0, 40))} became ${JSON.stringify(other.text.slice(0, 40))}`);
    }
    if (facts.rendered !== other.rendered) {
      result.textLost = true;
      note(id, 'rendered text', () => `${id}: rendered text ${JSON.stringify(facts.rendered.slice(0, 40))} became ${JSON.stringify(other.rendered.slice(0, 40))}`);
    }
    for (const [name, value] of Object.entries(facts.styles)) {
      if (other.styles[name] !== value) note(id, name, () => `${id}: ${name} ${value} became ${other.styles[name]}`);
    }
    for (const pseudo of ['before', 'after'] as const) {
      if (facts[pseudo] !== other[pseudo]) {
        result.pseudo = true;
        note(id, `::${pseudo}`, () => `${id}::${pseudo}: content ${facts[pseudo]} became ${other[pseudo]}`);
      }
    }
  }
  result.elements = [...touched];
  return result;
}

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
  text: string;
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
}

export async function takeSnapshot(page: Page, options: SnapshotOptions = {}): Promise<Snapshot> {
  const computed = await page.evaluate(({ withoutVariables }) => {
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
        // Words only: the source indentation of a hand-written page is not content.
        text: (el.textContent ?? '').replace(/\s+/g, ''),
        styles: dump(getComputedStyle(el)),
        before: getComputedStyle(el, '::before').content,
        after: getComputedStyle(el, '::after').content,
      };
    });
    return facts;
  }, { withoutVariables: options.withoutVariables ?? false });
  return {
    png: await page.screenshot({ fullPage: true }),
    computed,
    aria: await page.locator('body').ariaSnapshot(),
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

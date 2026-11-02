// @vitest-environment node
// globals.css is the sheet under every published page, and Tailwind fills it with a
// utility for every class name its automatic scan finds. A file that is not the app's
// own UI code (the React import's Tailwind converter, a test, a fixture, the score
// corpus, a document) can change that set without anyone touching the UI: the
// converter's preamble once put strict <color> gradient @property rules on every
// published page and turned an imported page's gradients transparent. This compiles
// globals.css through the same PostCSS plugin as the build and checks every file the
// scan read.

import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
import tailwindcss from '@tailwindcss/postcss';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const SHEET = path.join(ROOT, 'src/app/globals.css');
/** Read through the explicit @source in globals.css: the Books composer's inspector fields. */
const BLOCK_EDITOR_DIST = fs.realpathSync(path.join(ROOT, 'node_modules/@marlinjai/block-editor-react/dist'));
/** The sheets globals.css imports: they are CSS the build inlines, not scanned code. */
const IMPORTED_SHEETS = ['tailwindcss', 'tw-animate-css'].map((name) => fs.realpathSync(path.join(ROOT, 'node_modules', name)));

const inside = (file: string, dir: string) => file === dir || file.startsWith(`${dir}${path.sep}`);

/** Why a file the scan read is not the app's own UI code, or null when it is. */
function foreign(file: string): string | null {
  const real = fs.realpathSync(file);
  if (inside(real, BLOCK_EDITOR_DIST)) return null;
  if (real.endsWith('.css') && IMPORTED_SHEETS.some((dir) => inside(real, dir))) return null;
  const relative = path.relative(ROOT, file).split(path.sep).join('/');
  if (!relative.startsWith('src/')) return 'outside src/';
  if (relative.startsWith('src/lib/reactImport/')) return 'the React import';
  if (/(^|\/)(__tests__|__fixtures__)\//.test(relative) || /\.test\.tsx?$/.test(relative)) return 'a test or fixture';
  return null;
}

describe('the published site sheet', () => {
  let scanned: string[];
  let css: string;

  beforeAll(async () => {
    const result = await postcss([tailwindcss({ base: ROOT })]).process(fs.readFileSync(SHEET, 'utf8'), { from: SHEET });
    css = result.css;
    scanned = result.messages.filter((message) => message.type === 'dependency').map((message) => message.file as string);
  }, 60_000);

  it('takes its utilities only from the app UI code', () => {
    const offenders = scanned.map((file) => ({ file: path.relative(ROOT, file), why: foreign(file) })).filter((entry) => entry.why !== null);
    expect(offenders, 'a file outside the app UI code feeds globals.css: exclude it with @source not').toEqual([]);
  });

  it('still reads the UI code, so the check above is not vacuous', () => {
    const relative = new Set(scanned.map((file) => path.relative(ROOT, file).split(path.sep).join('/')));
    expect(scanned.length).toBeGreaterThan(300);
    expect(relative).toContain('src/app/layout.tsx');
    expect(relative).toContain('src/components/ui/button.tsx');
    expect(scanned.some((file) => inside(fs.realpathSync(file), BLOCK_EDITOR_DIST))).toBe(true);
    expect(css).toContain('.antialiased');
  });

  it('reads none of the folders that once leaked into it', () => {
    const relative = scanned.map((file) => path.relative(ROOT, file).split(path.sep).join('/'));
    for (const prefix of ['src/lib/reactImport/', 'test/', 'docs/', 'scripts/']) {
      expect(relative.filter((file) => file.startsWith(prefix)), prefix).toEqual([]);
    }
  });
});

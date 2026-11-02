// What a real published page sits on, beyond its own sheet: the CSS the root layout
// ships to every route, and the classes on html and body. A page's own sheet alone is
// a page no visitor sees: no reset, no theme, no base layer.
//
// test/score/data/published-base.css and .json are generated from the production build
// by `pnpm score:refresh-base` (test/score/refreshBase.ts) and committed, so a
// score run needs no build. `publishedBaseInputs` is what keeps them honest: the files
// and versions that decide the base, compared by src/app/__tests__/publishedBase.test.ts,
// which fails when one changes without a refresh. The utilities in the sheet also follow
// every class written in the repo, so they lag until the next refresh. That is on
// purpose: the reset, the theme and the base layer are what a stored page depends on.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve(process.cwd(), 'test/score/data');
export const BASE_CSS_FILE = path.join(DATA_DIR, 'published-base.css');
export const BASE_META_FILE = path.join(DATA_DIR, 'published-base.json');

/** The layouts every published page sits under, and the sheet they import. */
export const BASE_SOURCES = ['src/app/globals.css', 'src/app/layout.tsx', 'src/app/(site)/layout.tsx'] as const;
/** The packages that compile the sheet or write the font classes. */
const BASE_PACKAGES = ['next', 'tailwindcss', '@tailwindcss/postcss', 'tw-animate-css'] as const;

export interface PublishedBaseMeta {
  _doc: string;
  htmlClass: string;
  bodyClass: string;
  /** The built files, in the order the page links them. Their names carry a content hash. */
  sheets: string[];
  inputs: Record<string, string>;
}

/** The current state of everything that decides the base: a hash per file, a version per package. */
export function publishedBaseInputs(): Record<string, string> {
  const root = process.cwd();
  const inputs: Record<string, string> = {};
  for (const file of BASE_SOURCES) {
    inputs[file] = createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
  }
  for (const name of BASE_PACKAGES) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8')) as { version: string };
    inputs[name] = manifest.version;
  }
  return inputs;
}

/** The committed base. A missing file throws: the score must not quietly fall back to a page with no base. */
export function readPublishedBase(): { css: string; meta: PublishedBaseMeta } {
  for (const file of [BASE_CSS_FILE, BASE_META_FILE]) {
    if (!fs.existsSync(file)) throw new Error(`${file} is missing: run pnpm score:refresh-base`);
  }
  return {
    css: fs.readFileSync(BASE_CSS_FILE, 'utf8'),
    meta: JSON.parse(fs.readFileSync(BASE_META_FILE, 'utf8')) as PublishedBaseMeta,
  };
}

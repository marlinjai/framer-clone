// The editor's own sheet, for a harness that mounts the real editor without Next.
//
// The editor routes link src/app/globals.css; a published page never does, it links the
// site sheet (src/app/(site)/site.css), which test/score/data/published-base.css holds. So
// the editor in a plain Chromium page needs globals.css as well. Compiled here, through the
// same PostCSS plugin and optimizer as the build, rather than copied from a build: the
// editor's utilities follow every class in its UI code, and a committed copy would go stale
// with each one.

import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
import tailwindcss from '@tailwindcss/postcss';

export const EDITOR_SHEET = 'src/app/globals.css';
/** The tokens and base layer globals.css shares with the site sheet, imported by a relative path. */
const TOKENS_IMPORT = '@import "./theme-tokens.css";';

/**
 * globals.css as one text, its shared tokens file written in where it is imported: what a
 * reader that cannot follow a relative `@import` (the React import's converter, the
 * score's theme cut) needs to see the editor's theme.
 */
export function editorSheetSource(root: string = process.cwd()): string {
  const text = fs.readFileSync(path.join(root, EDITOR_SHEET), 'utf8');
  if (!text.includes(TOKENS_IMPORT)) throw new Error(`${EDITOR_SHEET} no longer imports its tokens as ${TOKENS_IMPORT}`);
  return text.replace(TOKENS_IMPORT, fs.readFileSync(path.join(root, 'src/app/theme-tokens.css'), 'utf8'));
}

let compiled: Promise<string> | undefined;

/** globals.css as the build compiles it, once per process. */
export function editorSheet(): Promise<string> {
  compiled ??= (async () => {
    const root = process.cwd();
    const file = path.join(root, EDITOR_SHEET);
    const result = await postcss([tailwindcss({ base: root, optimize: { minify: true } })]).process(fs.readFileSync(file, 'utf8'), { from: file });
    return result.css;
  })();
  return compiled;
}

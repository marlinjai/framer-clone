// The two themes every import fixture runs under. The repo's own components share the
// editor's theme, so a token the importer forgot still resolves to the right colour on
// the page and every token error is invisible there. The foreign theme, where every
// token differs, makes those errors show. A test keeps it foreign.
//
// The repo theme is read from `src/app/globals.css` each run (its shared tokens file,
// src/app/theme-tokens.css, written in where it is imported), cut down to what a shadcn
// sheet holds: its imports, the dark variant, `@theme inline`, `:root`, `.dark` and
// `@layer base`. The editor's own rules there (`@utility`, the canvas cursors, the glass
// surfaces) are no part of a component's theme, so they are not given to the importer.

import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
import { editorSheetSource } from '../lib/editorSheet';

export type ThemeId = 'repo' | 'foreign';
export const THEMES: readonly ThemeId[] = ['repo', 'foreign'];

const ROOT = path.resolve(__dirname, '../../..');
export const FOREIGN_THEME_FILE = path.join(__dirname, 'foreign-theme.css');

const KEPT_AT_RULES = new Set(['import', 'theme', 'layer']);

/** `globals.css` as a component's theme. */
export function repoTheme(): string {
  const root = postcss.parse(editorSheetSource(ROOT));
  root.walkComments((comment) => {
    comment.remove();
  });
  root.each((node) => {
    if (node.type === 'atrule') {
      const keep = KEPT_AT_RULES.has(node.name) || (node.name === 'custom-variant' && node.params.trim() === 'dark (&:is(.dark *))');
      if (!keep || (node.name === 'layer' && node.params.trim() !== 'base')) node.remove();
    } else if (node.type === 'rule' && node.selector !== ':root' && node.selector !== '.dark') {
      node.remove();
    }
  });
  return `${root.toString().trim()}\n`;
}

export const themeText = (theme: ThemeId): string => (theme === 'repo' ? repoTheme() : fs.readFileSync(FOREIGN_THEME_FILE, 'utf8'));

/** Every custom property a theme sets, by selector, `@theme` included. */
export function tokensOf(text: string): Map<string, string> {
  const tokens = new Map<string, string>();
  postcss.parse(text).walkDecls((declaration) => {
    if (!declaration.prop.startsWith('--')) return;
    const parent = declaration.parent;
    const where = parent?.type === 'rule' ? parent.selector : parent?.type === 'atrule' ? `@${parent.name}` : '';
    tokens.set(`${where} ${declaration.prop}`, declaration.value.trim());
  });
  return tokens;
}

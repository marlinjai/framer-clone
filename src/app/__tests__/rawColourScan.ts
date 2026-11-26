// src/app/__tests__/rawColourScan.ts
//
// The scanner behind rawColours.test.ts (plan docs/plans/2026-11-23-sites-home-and-light-mode.md,
// slice S3): finds hard-coded palette classes and colour literals in the editor's own code, which
// must use the interface tokens so they follow Light and Dark. Comment lines are skipped.

import fs from 'node:fs';
import path from 'node:path';

const PALETTE = 'gray|neutral|zinc|slate|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black';
const UTILITY = 'bg|text|border|ring|ring-offset|from|to|via|fill|stroke|outline|divide|placeholder|shadow|decoration|accent|caret';
/** A Tailwind colour utility naming a palette colour: `bg-gray-100`, `text-white`, `ring-black/5`. */
export const RAW_CLASS = new RegExp(`(?<![\\w-])(?:${UTILITY})-(?:${PALETTE})(?:-\\d{2,3})?(?:/\\d+)?(?![\\w-])`, 'g');
/** A colour written out: `#1a2b3c`, `rgb(…)`, `rgba(…)`, `hsl(…)`, `oklch(…)` with a number in it. */
export const COLOUR_LITERAL = /#[0-9a-fA-F]{3,8}(?![\w-])|\b(?:rgba?|hsla?|oklch)\(\s*[\d.]/g;

/** The editor's own code: components, routes and helpers. */
export const SCANNED_ROOTS = ['src/components', 'src/app', 'src/utils'];

function isScanned(file: string): boolean {
  return /\.(tsx?)$/.test(file) && !/(^|\/)__tests__\//.test(file) && !/\.harness\.tsx$/.test(file) && !/\.d\.ts$/.test(file);
}

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (isScanned(full)) out.push(full);
  }
}

/** Every match per file (repository-relative), comment lines left out. */
export function scanRawColours(repo: string): Map<string, string[]> {
  const files: string[] = [];
  for (const root of SCANNED_ROOTS) walk(path.join(repo, root), files);
  const found = new Map<string, string[]>();
  for (const file of files) {
    const hits: string[] = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const code = line.trim();
      if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) continue;
      hits.push(...(line.match(RAW_CLASS) ?? []), ...(line.match(COLOUR_LITERAL) ?? []));
    }
    if (hits.length > 0) found.set(path.relative(repo, file), hits.sort());
  }
  return found;
}

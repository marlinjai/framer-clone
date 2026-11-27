// Every editor page names its browser tab from the first HTML (docs/plans/2026-11-23-sites-home-and-light-mode.md,
// "titles per route"). Found missing on production on 2026-11-27: the projects home, Books, Catalog, Payments and
// both previews sent no <title>, so tabs and history showed the bare address. A page declares its title itself,
// or (a client page, which cannot) its own segment's layout does. Published pages under (site) name themselves from
// the site and are not checked here.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP = join(__dirname, '..');

function pages(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === '(site)' || e.name === '__tests__' || e.name === 'api' ? [] : pages(p);
    return e.name === 'page.tsx' ? [p] : [];
  });
}

const TITLE = /export const metadata\s*=\s*\{\s*title:\s*'[^']+ \| Lumitra Sites'|export async function generateMetadata/;

function declaresTitle(page: string): boolean {
  const src = readFileSync(page, 'utf8');
  if (TITLE.test(src)) return true;
  const layout = join(dirname(page), 'layout.tsx');
  return /^'use client'/m.test(src) && existsSync(layout) && TITLE.test(readFileSync(layout, 'utf8'));
}

describe('editor page titles', () => {
  const all = pages(APP);

  it('finds the editor pages', () => {
    expect(all.length).toBeGreaterThan(10);
  });

  it.each(all.map((p) => [relative(APP, p)]))('%s names its tab "<what> | Lumitra Sites"', (rel) => {
    expect(declaresTitle(join(APP, rel))).toBe(true);
  });
});

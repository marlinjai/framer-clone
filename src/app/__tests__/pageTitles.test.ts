// Every editor page names its browser tab from the first HTML (docs/plans/2026-11-23-sites-home-and-light-mode.md,
// "titles per route"). Found missing on production on 2026-11-27: the projects home, Books, Catalog, Payments and
// both previews sent no <title>, so tabs and history showed the bare address. A server page declares a static title
// itself; a client page, which cannot, gets it from the nearest layout between it and the root. A page that builds
// its title in `generateMetadata` is listed below with the test that pins what it returns, so a new one cannot slip
// through by declaring the function alone. Published pages under (site) name themselves from the site.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP = join(__dirname, '..');

/** Pages whose title is computed, and the test that asserts the computed titles. */
const COMPUTED: Record<string, string> = {
  'page.tsx': 'src/app/__tests__/homePage.test.tsx',
};

function pages(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === '(site)' || e.name === '__tests__' || e.name === 'api' ? [] : pages(p);
    return e.name === 'page.tsx' ? [p] : [];
  });
}

/** The static title a module declares, whatever its quotes, spacing or key order; null when there is none. */
function staticTitle(src: string): string | null {
  const block = /export\s+const\s+metadata(?:\s*:\s*Metadata)?\s*=\s*\{([\s\S]*?)\}\s*;?/.exec(src)?.[1];
  if (!block) return null;
  return /(?:^|[\s,{])title\s*:\s*(['"`])([^'"`]+)\1/.exec(block)?.[2] ?? null;
}

function titleOf(page: string): string | null {
  const src = readFileSync(page, 'utf8');
  const own = staticTitle(src);
  if (own || !/^['"]use client['"]/m.test(src)) return own;
  // A client page: the nearest layout above it, short of the root (whose fallback is generic).
  for (let dir = dirname(page); dir !== APP; dir = dirname(dir)) {
    const layout = join(dir, 'layout.tsx');
    if (existsSync(layout)) {
      const t = staticTitle(readFileSync(layout, 'utf8'));
      if (t) return t;
    }
  }
  return null;
}

describe('editor page titles', () => {
  const all = pages(APP).map((p) => relative(APP, p));

  it('finds the editor pages', () => {
    expect(all.length).toBeGreaterThan(10);
  });

  it.each(all.filter((p) => !COMPUTED[p]).map((p) => [p]))('%s names its tab "<what> | Lumitra Sites"', (rel) => {
    expect(titleOf(join(APP, rel))).toMatch(/^\S.* \| Lumitra Sites$/);
  });

  it.each(Object.entries(COMPUTED))('%s computes its title, pinned by %s', (rel, test) => {
    expect(readFileSync(join(APP, rel), 'utf8')).toMatch(/export async function generateMetadata/);
    expect(readFileSync(join(APP, '..', '..', test), 'utf8')).toMatch(/generateMetadata\([\s\S]*\.title\)\.toBe\(/);
  });

  it('a page that computes its title must be listed with its test', () => {
    const unlisted = all.filter((p) => !COMPUTED[p] && /export async function generateMetadata/.test(readFileSync(join(APP, p), 'utf8')));
    expect(unlisted).toEqual([]);
  });

  it('reads a title in any formatting, and none from a page without one', () => {
    expect(staticTitle(`export const metadata: Metadata = {\n  description: "x",\n  title: "Books | Lumitra Sites",\n};`)).toBe('Books | Lumitra Sites');
    expect(staticTitle(`export const metadata = { title: 'Books | Lumitra Sites' }`)).toBe('Books | Lumitra Sites');
    expect(staticTitle(`export const dynamic = 'force-dynamic';`)).toBeNull();
    expect(staticTitle(`export const metadata = { description: 'no title' };`)).toBeNull();
  });
});
// ci-replay touch

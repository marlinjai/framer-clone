// src/lib/renderer/publish/assetCollector.ts
//
// Walks an MST page/project tree READ-ONLY and returns the relative asset URLs it
// references (publish spec: asset collection). Detects:
//   - `<img src>` / `poster` style URL props
//   - `<source srcset>` / `srcSet` candidate lists
//   - any `url(...)` reference inside `style` (backgroundImage etc.) or inside a
//     top-level CSS-shaped string prop (backgroundImage can live top-level per
//     `getResolvedProps`'s CSS_PROP_SET)
//
// Absolute / external URLs (http(s)://, protocol-relative //, data:, blob:,
// mailto:, tel:, #fragments) are IGNORED — they already resolve and need no
// bundling. Only relative URLs are collected; those are the ones a self-contained
// bundle must account for. Responsive prop maps are flattened (every breakpoint
// value contributes its URL). Results are de-duplicated and sorted for a
// deterministic manifest.

import type { ComponentInstance } from '@/models/ComponentModel';

// Props whose entire string value is a single URL.
const URL_PROPS = new Set(['src', 'poster', 'data-src']);
// Props whose value is an HTML srcset candidate list.
const SRCSET_PROPS = new Set(['srcset', 'srcSet']);

/**
 * Collect the relative asset URLs referenced anywhere in a single page's app
 * component tree. (Floating/canvas-only nodes are NOT published, mirroring
 * `HeadlessPageRenderer`, so only the app tree is walked.)
 */
export function collectPageAssets(page: {
  appComponentTree?: ComponentInstance | undefined;
}): string[] {
  const acc = new Set<string>();
  if (page.appComponentTree) collectFromNode(page.appComponentTree, acc);
  return [...acc].sort();
}

/**
 * Collect the relative asset URLs across every page of a project (union).
 */
export function collectProjectAssets(project: {
  pagesArray: Array<{ appComponentTree?: ComponentInstance | undefined }>;
}): string[] {
  const acc = new Set<string>();
  for (const page of project.pagesArray) {
    if (page.appComponentTree) collectFromNode(page.appComponentTree, acc);
  }
  return [...acc].sort();
}

/**
 * Map a referenced asset URL to its in-bundle path under `assets/`. Uses the URL
 * basename; on a basename collision across distinct source URLs the later entry
 * is disambiguated with a short stable prefix derived from the full URL, so two
 * different `hero.jpg` paths never clobber each other.
 */
export function buildAssetBundleMap(urls: string[]): Map<string, string> {
  const map = new Map<string, string>();
  const usedNames = new Map<string, string>(); // bundleName -> sourceUrl
  for (const url of [...urls].sort()) {
    const base = basename(url);
    let name = base;
    const owner = usedNames.get(name);
    if (owner !== undefined && owner !== url) {
      name = `${shortHash(url)}-${base}`;
    }
    usedNames.set(name, url);
    map.set(url, `assets/${name}`);
  }
  return map;
}

// =============================================================================
// internals
// =============================================================================

function collectFromNode(node: ComponentInstance, acc: Set<string>): void {
  // `props` is a frozen plain record on the MST node; read-only access only.
  const props = (node.props ?? {}) as Record<string, unknown>;

  for (const [key, value] of Object.entries(props)) {
    if (key === 'children') continue;

    if (key === 'style') {
      for (const leaf of flattenStrings(value)) {
        for (const u of urlsFromCss(leaf)) addIfRelative(u, acc);
      }
      continue;
    }

    if (URL_PROPS.has(key)) {
      for (const leaf of flattenStrings(value)) addIfRelative(leaf.trim(), acc);
      continue;
    }

    if (SRCSET_PROPS.has(key)) {
      for (const leaf of flattenStrings(value)) {
        for (const u of urlsFromSrcset(leaf)) addIfRelative(u, acc);
      }
      continue;
    }

    // Any other string-ish prop: only `url(...)` references count (catches a
    // top-level `backgroundImage` and similar CSS-shaped props), so we never
    // collect arbitrary text content.
    for (const leaf of flattenStrings(value)) {
      for (const u of urlsFromCss(leaf)) addIfRelative(u, acc);
    }
  }

  for (const child of node.children) {
    collectFromNode(child as ComponentInstance, acc);
  }
}

/** Recursively gather every string leaf from a prop value (handles responsive
 *  maps, nested style objects, and arrays). */
function flattenStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(flattenStrings);
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap(flattenStrings);
  }
  return [];
}

/** Extract every `url(...)` target from a CSS-shaped string. */
function urlsFromCss(s: string): string[] {
  const out: string[] = [];
  const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out.push(m[2].trim());
  }
  return out;
}

/** Extract candidate URLs from an HTML srcset list ("a.jpg 320w, b.jpg 640w"). */
function urlsFromSrcset(s: string): string[] {
  return s
    .split(',')
    .map((candidate) => candidate.trim().split(/\s+/)[0])
    .filter((u) => u.length > 0);
}

function addIfRelative(url: string, acc: Set<string>): void {
  if (isRelativeAsset(url)) acc.add(url);
}

/**
 * A URL is a bundlable relative asset when it is non-empty and does NOT name an
 * external/special scheme. Root-relative (`/img.png`) counts as bundlable too.
 */
export function isRelativeAsset(url: string): boolean {
  if (!url) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return false; // http:, https:, data:, blob:, mailto:, tel:
  if (url.startsWith('//')) return false; // protocol-relative external
  if (url.startsWith('#')) return false; // in-page fragment
  return true;
}

function basename(url: string): string {
  // Drop any query/hash, then take the last path segment.
  const clean = url.split(/[?#]/)[0];
  const seg = clean.split('/').filter(Boolean).pop();
  return seg && seg.length > 0 ? seg : 'asset';
}

/** A tiny stable non-cryptographic hash (djb2) for collision disambiguation. */
function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(36).slice(0, 6);
}

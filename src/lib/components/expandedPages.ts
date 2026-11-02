// src/lib/components/expandedPages.ts
//
// Expansion, memoised for the paths that walk a published site. Cloning one page
// is cheap, but it adds up where every page is walked or every render reads the
// home page, and a form POST with a random `formId` is anonymous. So one site
// revision expands each page once per process, and `siteFormIds` answers which
// page holds a form without expanding anything for an id that does not exist.
//
// The key is `siteId` and `revision`: the id of the frozen revision being served
// (plan 2026-11-01-immutable-published-copy), which every publish and rollback
// changes, with the time an erase of personal data last rewrote it in place, or
// for a site with no revision yet the row's `updated_at`, which every save moves. It is not the contract's `projectUpdatedAt`: node edits never touch
// `metadata.updatedAt`, so that value stays put when a definition or a page is
// saved, and the memo would serve the old tree. Object identity is no key either,
// because the cached site is deserialised afresh per request.
//
// A held tree is shared by every request, so nothing downstream may write to it,
// which a test pins. Its budget is not shared: each caller gets its own, charged
// with what expansion spent, or hydration would accumulate across requests. A page
// expansion spent nothing on is not held, since adapting it costs less than an
// entry.
//
// The map is bounded in entries and in bytes, oldest out first, and a stale
// revision simply ages out. It sits on `globalThis`, like the negative cache in
// cachedResolver.ts, because the routes are bundled separately.
//
// PURE apart from the map: no React, no MST, no server-only.

import type { ComponentDefinitions } from './definition';
import { createRenderBudget } from './expand';
import { listFormNodes, type FormTreeNode } from '@/lib/forms/definition';
import type { PageSnapshotOut } from '@/models/PageModel';
import {
  literalPageTree,
  snapshotToComponentNode,
  type AdaptedPage,
  type LiteralTree,
} from '@/lib/renderer/server/snapshotToComponentNode';

/** The parts of a published site these read. Without a revision nothing is memoised. */
export interface ExpandableSite {
  siteId?: string;
  revision?: string;
  components: ComponentDefinitions;
}

/** A stored page: enough to adapt it and to name it. */
export interface ExpandablePage {
  pageId: string;
  snapshot: PageSnapshotOut;
}

const MAX_ENTRIES = 512;
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_FORM_LISTS = 256;

type Held = { kind: 'adapted'; value: AdaptedPage } | { kind: 'literal'; value: LiteralTree };

interface Memo {
  entries: Map<string, { held: Held; bytes: number }>;
  bytes: number;
  formIds: Map<string, ReadonlyMap<string, string>>;
}

const store = globalThis as typeof globalThis & { __fcExpandedPages?: Memo };

function memo(): Memo {
  store.__fcExpandedPages ??= { entries: new Map(), bytes: 0, formIds: new Map() };
  return store.__fcExpandedPages;
}

/** Empties the memo. For tests. */
export function resetExpandedPages(): void {
  delete store.__fcExpandedPages;
}

function revisionKey(site: ExpandableSite): string | null {
  return site.siteId && site.revision ? JSON.stringify([site.siteId, site.revision]) : null;
}

function pageKey(site: ExpandableSite, pageId: string, kind: Held['kind']): string | null {
  const revision = revisionKey(site);
  return revision ? `${revision}\n${pageId}\n${kind}` : null;
}

function remember(key: string, held: Held, bytes: number): void {
  const shared = memo();
  shared.entries.set(key, { held, bytes });
  shared.bytes += bytes;
  for (const [oldest, entry] of shared.entries) {
    if (shared.entries.size <= MAX_ENTRIES && shared.bytes <= MAX_BYTES) break;
    shared.entries.delete(oldest);
    shared.bytes -= entry.bytes;
  }
}

/** The held value, moved to the young end of the map. */
function recall(key: string | null): Held | undefined {
  if (!key) return undefined;
  const { entries } = memo();
  const entry = entries.get(key);
  if (!entry) return undefined;
  entries.delete(key);
  entries.set(key, entry);
  return entry.held;
}

/** The page ready to render. Its tree is shared and read only; its budget is the caller's own. */
export function adaptedPage(site: ExpandableSite, page: ExpandablePage): AdaptedPage {
  const key = pageKey(site, page.pageId, 'adapted');
  const held = recall(key);
  const adapted = held?.kind === 'adapted' ? held.value : snapshotToComponentNode(page.snapshot, site.components);
  if (!held && key && adapted.budget.nodes > 0) {
    remember(key, { kind: 'adapted', value: adapted }, adapted.budget.bytes);
  }
  return { ...adapted, budget: createRenderBudget({ spent: adapted.budget }) };
}

/** The page as a raw reader sees it (`literalPageTree`). Read only. */
export function literalPage(site: ExpandableSite, page: ExpandablePage): LiteralTree {
  const key = pageKey(site, page.pageId, 'literal');
  const held = recall(key);
  if (held?.kind === 'literal') return held.value;
  const literal = literalPageTree(page.snapshot, site.components);
  if (key && literal.budget.nodes > 0) remember(key, { kind: 'literal', value: literal }, literal.budget.bytes);
  return literal;
}

/**
 * Every form of a site, form id to the id of the first page holding it. The list
 * for one revision is built once, so an unknown id costs a map lookup.
 */
export function siteFormIds(site: ExpandableSite & { pages: readonly ExpandablePage[] }): ReadonlyMap<string, string> {
  const shared = memo();
  const key = revisionKey(site);
  const known = key ? shared.formIds.get(key) : undefined;
  if (known) return known;
  const ids = new Map<string, string>();
  for (const page of site.pages) {
    for (const form of listFormNodes(adaptedPage(site, page).root as FormTreeNode | null)) {
      if (typeof form.id === 'string' && !ids.has(form.id)) ids.set(form.id, page.pageId);
    }
  }
  if (key) {
    if (shared.formIds.size >= MAX_FORM_LISTS) {
      for (const oldest of shared.formIds.keys()) {
        shared.formIds.delete(oldest);
        break;
      }
    }
    shared.formIds.set(key, ids);
  }
  return ids;
}

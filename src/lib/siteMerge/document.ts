// src/lib/siteMerge/document.ts
//
// The three-way merge of a whole site document (docs/plans/2026-11-10-site-branches.md, section 5): the
// site's own fields, its settings, its pages and its reusable component definitions. Used one way only,
// bringing main into a branch ("Update"); merging a branch into main is a plain write once the branch is
// up to date, so this never writes main.
//
// The document is the stored revision format (`src/server/sites/revision.ts`, `SiteRevisionDocument`):
// pages as `{ pageId, slug, snapshot }` in order, components by id. Redirects are not merged: main's stand,
// and the write that lands the merge on main derives a redirect for every changed address (section 4).
//
// PURE: client and server safe.

import { mergeOrder } from './order';
import { mergeForest, type Forest, type TreeNode } from './tree';
import { ConflictLog, conflictId, type MergeAnswers, type MergeConflict, type MergeSide, type MergeUnit } from './types';
import { isPlainObject, jsonEqual, mergeValue, type SplitRule } from './value';

export interface MergePage {
  pageId: string;
  slug: string;
  snapshot: Record<string, unknown>;
}

/** The parts of a site document the merge reads; anything else on it is carried from main. */
export interface MergeDocument {
  name: string;
  description: string;
  analyticsProjectId: string | null;
  ingestionEndpoint: string | null;
  apiKeyRef: string | null;
  lumitraEnabled: boolean;
  redirects: unknown[];
  siteSettings: Record<string, unknown>;
  pages: MergePage[];
  components: Record<string, unknown>;
  [key: string]: unknown;
}

export interface DocumentMerge {
  document: MergeDocument;
  /** Conflicts without an answer that still applies; main's side stands in for each. */
  conflicts: MergeConflict[];
  /** Conflicts settled by an answer that still applies. */
  settled: Array<{ conflict: MergeConflict; pick: MergeSide }>;
}

/** The site's own fields, each one value. */
const SITE_FIELDS = ['name', 'description', 'analyticsProjectId', 'ingestionEndpoint', 'apiKeyRef', 'lumitraEnabled'] as const;
/** A page's timestamps move with any edit on it: never compared, taken from the side whose content stands. */
const PAGE_TIMESTAMPS = ['createdAt', 'updatedAt'] as const;
const PAGE_TREE_FIELDS = ['appComponentTree', 'canvasNodes'] as const;

/**
 * Site settings merge per key; the business data per field; the theme per part (its tokens by id, the
 * document styles per key). The head is one value: its items carry no id yet, and merging a list by
 * position is what this merge never does (decided in the plan, section 10).
 */
const SETTINGS_SPLIT: SplitRule = (path) =>
  path.length === 0 ||
  (path.length === 1 && (path[0] === 'business' || path[0] === 'theme')) ||
  (path.length === 2 && path[0] === 'theme' && path[1] === 'document');

/** A page's own fields merge per field, its metadata per field. */
const PAGE_SPLIT: SplitRule = (path) => path.length === 0 || (path.length === 1 && path[0] === 'metadata');

/** A component definition's own fields merge per field. */
const DEFINITION_SPLIT: SplitRule = (path) => path.length === 0;

/** An item of a list keyed by id (an input, a state) merges per field. */
const ITEM_SPLIT: SplitRule = (path) => path.length === 0;

export function mergeDocuments(
  base: MergeDocument,
  main: MergeDocument,
  branch: MergeDocument,
  answers: MergeAnswers = {},
): DocumentMerge {
  const log = new ConflictLog(answers);
  const out: MergeDocument = { ...main };

  // The site's own fields.
  const site: MergeUnit = { kind: 'site', id: 'site' };
  for (const field of SITE_FIELDS) {
    out[field] = mergeValue(base[field], main[field], branch[field], {
      path: [field],
      pick: (path, c) => log.ask({ id: conflictId(site, 'value', path), kind: 'value', unit: site, path: [...path], base: c.base, main: c.main, branch: c.branch }),
    }).value as never;
  }
  out.redirects = main.redirects;

  out.siteSettings = mergeSettings(base.siteSettings, main.siteSettings, branch.siteSettings, log);
  out.components = mergeComponents(base.components, main.components, branch.components, log);
  out.pages = mergePages(base.pages, main.pages, branch.pages, log);
  return { document: out, conflicts: log.open, settled: log.settled };
}

function mergeSettings(base: unknown, main: unknown, branch: unknown, log: ConflictLog): Record<string, unknown> {
  const unit: MergeUnit = { kind: 'settings', id: 'site' };
  const ask = (path: readonly string[], c: { base: unknown; main: unknown; branch: unknown }) =>
    log.ask({ id: conflictId(unit, 'value', path), kind: 'value', unit, path: [...path], base: c.base, main: c.main, branch: c.branch });
  const b = (base ?? {}) as Record<string, unknown>;
  const m = (main ?? {}) as Record<string, unknown>;
  const r = (branch ?? {}) as Record<string, unknown>;
  // The tokens first, by id, then everything else per key with the merged tokens in place.
  const tokens = mergeKeyedList(
    themeTokens(b),
    themeTokens(m),
    themeTokens(r),
    unit,
    ['theme', 'tokens'],
    log,
    () => false,
  );
  const withTokens = (s: Record<string, unknown>) =>
    isPlainObject(s.theme) && tokens !== undefined ? { ...s, theme: { ...s.theme, tokens } } : s;
  const merged = mergeValue(withTokens(b), withTokens(m), withTokens(r), { split: SETTINGS_SPLIT, pick: ask }).value;
  return (merged ?? {}) as Record<string, unknown>;
}

function themeTokens(settings: Record<string, unknown>): unknown[] | undefined {
  const theme = settings.theme;
  return isPlainObject(theme) && Array.isArray(theme.tokens) ? theme.tokens : undefined;
}

/**
 * A list whose items all carry a string `id` (theme tokens, a component's inputs and states): merged item by
 * item, then in order. A list that is not keyed so is one value. Answers `undefined` when no side has it.
 */
function mergeKeyedList(
  base: unknown,
  main: unknown,
  branch: unknown,
  unit: MergeUnit,
  path: string[],
  log: ConflictLog,
  split: SplitRule,
): unknown[] | undefined {
  const ask = (at: readonly string[], c: { base: unknown; main: unknown; branch: unknown }) =>
    log.ask({ id: conflictId(unit, 'value', at), kind: 'value', unit, path: [...at], base: c.base, main: c.main, branch: c.branch });
  const keyed = (list: unknown) =>
    list === undefined || (Array.isArray(list) && list.every((item) => isPlainObject(item) && typeof item.id === 'string'));
  if (main === undefined && branch === undefined) return undefined;
  if (!keyed(base) || !keyed(main) || !keyed(branch)) {
    return mergeValue(base, main, branch, { path, pick: ask }).value as unknown[] | undefined;
  }
  const byId = (list: unknown) => new Map(((list ?? []) as Array<{ id: string }>).map((item) => [item.id, item]));
  const b = byId(base);
  const m = byId(main);
  const r = byId(branch);
  const items = new Map<string, unknown>();
  for (const id of new Set([...m.keys(), ...r.keys(), ...b.keys()])) {
    const merged = mergeValue(b.get(id), m.get(id), r.get(id), { path: [...path, id], split: (p, s) => split(p.slice(path.length + 1), s), pick: ask });
    if (merged.value !== undefined) items.set(id, merged.value);
  }
  const ids = (list: Map<string, unknown>) => [...list.keys()];
  const order = mergeOrder(ids(b), ids(m), ids(r), new Set(items.keys()), {
    ask: (ob, om, or) => log.ask({ id: conflictId(unit, 'order', path), kind: 'order', unit, path, base: ob, main: om, branch: or }),
  });
  return order.map((id) => items.get(id));
}

function mergeComponents(base: Record<string, unknown>, main: Record<string, unknown>, branch: Record<string, unknown>, log: ConflictLog) {
  const out: Record<string, unknown> = {};
  for (const id of new Set([...Object.keys(main ?? {}), ...Object.keys(branch ?? {}), ...Object.keys(base ?? {})])) {
    const merged = mergeUnit(
      base?.[id] as Record<string, unknown> | undefined,
      main?.[id] as Record<string, unknown> | undefined,
      branch?.[id] as Record<string, unknown> | undefined,
      { kind: 'component', id },
      log,
      (b, m, r, unit) => {
        const container = `component:${id}`;
        const fields = (d: Record<string, unknown>) => {
          const { page: _page, inputs: _inputs, states: _states, ...rest } = d;
          void _page;
          void _inputs;
          void _states;
          return rest;
        };
        const own = mergeValue(fields(b), fields(m), fields(r), {
          split: DEFINITION_SPLIT,
          pick: (path, c) => log.ask({ id: conflictId(unit, 'value', path), kind: 'value', unit, path: [...path], base: c.base, main: c.main, branch: c.branch }),
        }).value as Record<string, unknown>;
        const result: Record<string, unknown> = { ...own };
        for (const list of ['inputs', 'states'] as const) {
          const merged = mergeKeyedList(b[list], m[list], r[list], unit, [list], log, ITEM_SPLIT);
          if (merged !== undefined) result[list] = merged;
        }
        result.page = mergePageBody(b.page, m.page, r.page, container, log, unit);
        return result;
      },
    );
    if (merged !== undefined) out[id] = merged;
  }
  return out;
}

function mergePages(base: MergePage[], main: MergePage[], branch: MergePage[], log: ConflictLog): MergePage[] {
  const byId = (pages: MergePage[]) => new Map(pages.map((p) => [p.pageId, p]));
  const B = byId(base);
  const M = byId(main);
  const R = byId(branch);
  const merged = new Map<string, MergePage>();
  for (const id of new Set([...M.keys(), ...R.keys(), ...B.keys()])) {
    const page = mergeUnit(B.get(id)?.snapshot, M.get(id)?.snapshot, R.get(id)?.snapshot, { kind: 'page', id }, log, (b, m, r, unit) =>
      mergePageBody(b, m, r, `page:${id}`, log, unit),
    );
    if (page) merged.set(id, { pageId: id, slug: typeof page.slug === 'string' ? page.slug : '', snapshot: page });
  }
  const order = mergeOrder([...B.keys()], [...M.keys()], [...R.keys()], new Set(merged.keys()), {
    ask: (ob, om, or) => {
      const unit: MergeUnit = { kind: 'site', id: 'site' };
      return log.ask({ id: conflictId(unit, 'order', ['pages']), kind: 'order', unit, path: ['pages'], base: ob, main: om, branch: or });
    },
  });
  const pages = order.map((id) => merged.get(id)!);
  settleSlugs(pages, M, R, log);
  return pages;
}

/**
 * One unit present on some of the three sides: added (kept; the same id added twice with different content
 * conflicts), removed on one side (gone when the other left it, else a conflict: keep it with the changes or
 * remove it), or on all three (merged by `body`).
 */
function mergeUnit(
  base: Record<string, unknown> | undefined,
  main: Record<string, unknown> | undefined,
  branch: Record<string, unknown> | undefined,
  unit: MergeUnit,
  log: ConflictLog,
  body: (b: Record<string, unknown>, m: Record<string, unknown>, r: Record<string, unknown>, unit: MergeUnit) => Record<string, unknown>,
): Record<string, unknown> | undefined {
  const content = (u: Record<string, unknown> | undefined) => (u ? withoutTimestamps(u) : undefined);
  if (!base) {
    if (main && branch && !jsonEqual(content(main), content(branch))) {
      const pick = log.ask({ id: conflictId(unit, 'added-twice'), kind: 'added-twice', unit, path: [], base: undefined, main: content(main), branch: content(branch) });
      return pick === 'branch' ? branch : main;
    }
    return main ?? branch;
  }
  if (!main && !branch) return undefined;
  if (!main || !branch) {
    const remover: MergeSide = main ? 'branch' : 'main';
    const kept = (main ?? branch)!;
    if (jsonEqual(content(base), content(kept))) return undefined;
    const pick =
      log.ask({ id: conflictId(unit, 'removed'), kind: 'removed', unit, path: [], base: content(base), main: content(main), branch: content(branch), removedOn: remover }) ??
      'main';
    return pick === remover ? undefined : kept;
  }
  const merged = body(base, main, branch, unit);
  return { ...merged, ...timestampsFor(merged, main, branch) };
}

function withoutTimestamps(u: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...u };
  for (const key of PAGE_TIMESTAMPS) delete copy[key];
  if (isPlainObject(copy.page)) copy.page = withoutTimestamps(copy.page);
  return copy;
}

/** Main's timestamps, unless the merge took the branch's content: then the later `updatedAt`. */
function timestampsFor(merged: Record<string, unknown>, main: Record<string, unknown>, branch: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  if ('createdAt' in main) out.createdAt = main.createdAt;
  if ('updatedAt' in main || 'updatedAt' in branch) {
    const same = jsonEqual(withoutTimestamps(merged), withoutTimestamps(main));
    const m = main.updatedAt;
    const r = branch.updatedAt;
    out.updatedAt = same || r === undefined ? m : m === undefined ? r : String(r) > String(m) ? r : m;
  }
  return out;
}

/** A page body (a page, or a component definition's page): its own fields per field, its trees as trees. */
function mergePageBody(
  base: unknown,
  main: unknown,
  branch: unknown,
  container: string,
  log: ConflictLog,
  unit: MergeUnit = { kind: 'page', id: container },
): Record<string, unknown> {
  const b = (base ?? {}) as Record<string, unknown>;
  const m = (main ?? {}) as Record<string, unknown>;
  const r = (branch ?? {}) as Record<string, unknown>;
  const own = (p: Record<string, unknown>) => {
    const copy = withoutTimestamps(p);
    for (const key of PAGE_TREE_FIELDS) delete copy[key];
    return copy;
  };
  const fields = mergeValue(own(b), own(m), own(r), {
    split: PAGE_SPLIT,
    pick: (path, c) => log.ask({ id: conflictId(unit, 'value', path), kind: 'value', unit, path: [...path], base: c.base, main: c.main, branch: c.branch }),
  }).value as Record<string, unknown>;
  const { forest } = mergeForest(forestOf(b), forestOf(m), forestOf(r), container, log);
  const out: Record<string, unknown> = { ...fields };
  for (const key of PAGE_TIMESTAMPS) if (key in m) out[key] = m[key];
  const [app] = forest.slots.app ?? [];
  if (app !== undefined) out.appComponentTree = app;
  if ('canvasNodes' in m || 'canvasNodes' in r || (forest.slots.canvas ?? []).length > 0) {
    out.canvasNodes = Object.fromEntries((forest.slots.canvas ?? []).map((node) => [node.id, node]));
  }
  return out;
}

function forestOf(page: Record<string, unknown>): Forest {
  const app = isPlainObject(page.appComponentTree) ? [page.appComponentTree as TreeNode] : [];
  const canvas = isPlainObject(page.canvasNodes) ? (Object.values(page.canvasNodes) as TreeNode[]) : [];
  return { slots: { app, canvas } };
}

/**
 * Rule 9: two pages ending with the same address. The page whose side the person picks keeps it, the other
 * gets the first free `<address>-2`, `-3`, ... The home page's empty address never changes hands: main's
 * home keeps it, and the only answer is main.
 */
function settleSlugs(pages: MergePage[], M: Map<string, MergePage>, R: Map<string, MergePage>, log: ConflictLog) {
  const taken = (slug: string, except: MergePage) => pages.some((p) => p !== except && p.slug === slug);
  const bySlug = new Map<string, MergePage[]>();
  for (const page of pages) bySlug.set(page.slug, [...(bySlug.get(page.slug) ?? []), page]);
  for (const [slug, clash] of bySlug) {
    if (clash.length < 2) continue;
    // Which side gave each page this address.
    const sideOf = (p: MergePage): MergeSide => (M.get(p.pageId)?.slug === slug ? 'main' : 'branch');
    const mains = clash.filter((p) => sideOf(p) === 'main');
    const branches = clash.filter((p) => sideOf(p) === 'branch');
    const unit: MergeUnit = { kind: 'page', id: clash.map((p) => p.pageId).sort().join('+') };
    const pick =
      log.ask({
        id: conflictId(unit, 'slug', ['slug']),
        kind: 'slug',
        unit,
        path: ['slug'],
        base: slug,
        main: mains.map((p) => p.pageId),
        branch: branches.map((p) => p.pageId),
        options: slug === '' ? ['main'] : ['main', 'branch'],
      }) ?? 'main';
    const keeper = (pick === 'main' ? mains : branches)[0] ?? clash[0];
    for (const page of clash) {
      if (page === keeper) continue;
      // The address the page had on its other side, if free; else the first free numbered one.
      const other = (sideOf(page) === 'main' ? R : M).get(page.pageId)?.slug;
      let next = other !== undefined && other !== slug && other !== '' && !taken(other, page) ? other : undefined;
      for (let n = 2; next === undefined; n++) {
        const candidate = `${slug || 'page'}-${n}`;
        if (!taken(candidate, page)) next = candidate;
      }
      page.slug = next;
      page.snapshot = { ...page.snapshot, slug: next };
    }
  }
}

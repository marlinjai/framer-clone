// src/lib/siteMerge/elementChanges.ts
//
// The review's change list (docs/plans/2026-11-10-site-branches.md, section 3 "A reviewer", slice S5): what changed
// from one site document to another, per page and component, down to the element, with each changed field's old
// and new value. `diff.ts` counts the same changes for the branch list; this one names them. The side-by-side view
// outlines exactly the element ids listed here.
//
// A value longer than SHOWN_VALUE_MAX_CHARS as JSON is shown as its size, never sent whole (decision 44): a
// removed section can be a whole page of text. The list is computed on request and never stored, so an erase of
// personal data leaves nothing of it behind.
//
// PURE: client and server safe.

import { stableStringify } from '@/lib/ai/serializers/normalize';
import { flatten, type Flat } from './tree';
import { jsonEqual, isPlainObject } from './value';
import { forestOf, SITE_FIELDS, withoutTimestamps, type MergeDocument } from './document';

/** A value longer than this as JSON is shown as its size. */
export const SHOWN_VALUE_MAX_CHARS = 4_096;

/** A value as the review shows it: itself, or its size when too long (null for "not there"). */
export type ShownValue = unknown;

export function shownValue(value: unknown): ShownValue {
  if (value === undefined) return null;
  const json = stableStringify(value);
  return json.length <= SHOWN_VALUE_MAX_CHARS ? value : { omitted: true, characters: json.length };
}

export interface FieldChange {
  /** A dotted path into the element: `type`, `props.children`, `props.style.color`. */
  field: string;
  before: ShownValue;
  after: ShownValue;
}

export type ElementChangeKind = 'added' | 'removed' | 'moved' | 'changed';

export interface ElementChange {
  id: string;
  kind: ElementChangeKind;
  /** The element's type (`div`, `Text`, a component's name), from the side that has it. */
  type: string;
  /** A short readable name: its text, or its type. */
  label: string;
  /** For `changed` (and a `moved` one whose fields also changed): what differs. */
  fields: FieldChange[];
}

export type UnitKind = 'page' | 'component';
export type UnitChangeKind = 'added' | 'removed' | 'changed';

export interface UnitReview {
  unit: UnitKind;
  id: string;
  /** The page's title or the component's name, from the side that has it. */
  title: string;
  change: UnitChangeKind;
  /** The page's address before and after (pages only; equal when it did not change). */
  slug?: { before: string | null; after: string | null };
  /** The page's or component's own fields that changed (metadata, the slug), outside its elements. */
  fields: FieldChange[];
  /**
   * The elements that changed inside a unit that existed before and still does. Empty for a unit that is new
   * or removed as a whole: every one of its elements would be listed as added (or removed), which says nothing
   * the unit's own line does not, and made a new page of a thousand elements a thousand list rows and a
   * thousand outline rules. `elementCount` says how many it holds instead.
   */
  elements: ElementChange[];
  /** Set on a unit that is new or removed as a whole: how many elements it holds. */
  elementCount?: number;
}

export interface DocumentReview {
  /** Site fields (name, description, analytics) and settings keys, with values. */
  site: FieldChange[];
  settings: FieldChange[];
  /** Pages, then components, each in the order of the side that has them; unchanged ones are left out. */
  units: UnitReview[];
  pageOrder: boolean;
}

/**
 * Fields an element's own record holds that are not the site: its id, and where a frame or a floating element sits
 * on the editor's canvas, which no visitor ever sees. Dragging a frame aside is not a change to review; its width is.
 */
const ELEMENT_IGNORED = new Set(['id', 'canvasX', 'canvasY', 'canvasScale', 'canvasRotation', 'canvasZIndex', 'canvasVisible', 'canvasLocked']);
/** A props key whose value is an object is compared per key, one level down (`props.style.color`). */
const NESTED = new Set(['props', 'style', 'bindings']);

function fieldChanges(before: Record<string, unknown>, after: Record<string, unknown>, prefix = ''): FieldChange[] {
  const out: FieldChange[] = [];
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  for (const key of keys) {
    if (!prefix && ELEMENT_IGNORED.has(key)) continue;
    const a = before[key];
    const b = after[key];
    if (jsonEqual(a, b)) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (NESTED.has(key) && isPlainObject(a) && isPlainObject(b) && path.split('.').length < 3) {
      out.push(...fieldChanges(a, b, path));
      continue;
    }
    out.push({ field: path, before: shownValue(a), after: shownValue(b) });
  }
  return out;
}

function typeOf(fields: Record<string, unknown> | undefined): string {
  if (!fields) return 'element';
  if (typeof fields.type === 'string' && fields.type) return fields.type;
  return 'element';
}

/** Its text when it has some (a heading, a button), shortened; otherwise its type. */
function labelOf(fields: Record<string, unknown> | undefined): string {
  const props = isPlainObject(fields?.props) ? fields!.props : {};
  const text = typeof props.children === 'string' ? props.children.trim() : '';
  if (text) return text.length > 60 ? `${text.slice(0, 57)}...` : text;
  const name = typeof fields?.name === 'string' ? fields.name.trim() : '';
  return name || typeOf(fields);
}

/** Every element's change between two containers' trees, in the order of the side that has the element. */
export function elementChanges(before: unknown, after: unknown): ElementChange[] {
  const a: Flat = flatten(forestOf(isPlainObject(before) ? before : {}));
  const b: Flat = flatten(forestOf(isPlainObject(after) ? after : {}));
  const out: ElementChange[] = [];
  const order = reordered(a, b);
  for (const [id, fields] of b.fields) {
    const old = a.fields.get(id);
    if (!old) {
      out.push({ id, kind: 'added', type: typeOf(fields), label: labelOf(fields), fields: [] });
      continue;
    }
    const changed = fieldChanges(old, fields);
    const moved = a.parent.get(id) !== b.parent.get(id) || order.has(id);
    if (moved || changed.length > 0) {
      out.push({ id, kind: moved ? 'moved' : 'changed', type: typeOf(fields), label: labelOf(fields), fields: changed });
    }
  }
  for (const [id, fields] of a.fields) {
    if (!b.fields.has(id)) out.push({ id, kind: 'removed', type: typeOf(fields), label: labelOf(fields), fields: [] });
  }
  return out;
}

/**
 * The ids each parent's kept children moved: among the children a parent keeps on both sides, those outside the
 * longest common order. Moving one element among fifty marks that one, not the fifty whose neighbour changed; a
 * neighbour added or removed moves nothing. Canvas roots have no order.
 */
function reordered(a: Flat, b: Flat): Set<string> {
  const out = new Set<string>();
  for (const [parent, after] of b.children) {
    if (parent === '#canvas') continue;
    const before = a.children.get(parent);
    if (!before) continue;
    const inAfter = new Set(after);
    const kept = before.filter((id) => inAfter.has(id));
    const keptSet = new Set(kept);
    const keptAfter = after.filter((id) => keptSet.has(id));
    if (jsonEqual(kept, keptAfter)) continue;
    const stay = longestCommonOrder(kept, keptAfter);
    for (const id of keptAfter) if (!stay.has(id)) out.add(id);
  }
  return out;
}

/** The ids of a longest common subsequence of two orders of the same ids (patience: O(n log n)). */
function longestCommonOrder(before: string[], after: string[]): Set<string> {
  const rank = new Map(before.map((id, i) => [id, i]));
  const seq = after.map((id) => rank.get(id)!);
  const tails: number[] = [];
  const tailAt: number[] = [];
  const prev: number[] = new Array(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] < seq[i]) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = seq[i];
    tailAt[lo] = i;
    prev[i] = lo > 0 ? tailAt[lo - 1] : -1;
  }
  const stay = new Set<string>();
  for (let i = tails.length ? tailAt[tails.length - 1] : -1; i >= 0; i = prev[i]) stay.add(after[i]);
  return stay;
}

function titleOfPage(snapshot: Record<string, unknown> | undefined, fallback: string): string {
  const meta = isPlainObject(snapshot?.metadata) ? snapshot!.metadata : {};
  return typeof meta.title === 'string' && meta.title.trim() ? meta.title.trim() : fallback;
}

function nameOfComponent(definition: unknown, fallback: string): string {
  if (!isPlainObject(definition)) return fallback;
  return typeof definition.name === 'string' && definition.name.trim() ? definition.name.trim() : fallback;
}

const TREES = new Set(['appComponentTree', 'canvasNodes']);
/** Site fields listed as changed with no value: the reference to where the analytics key is kept. */
const VALUE_HIDDEN = new Set<string>(['apiKeyRef']);
const HIDDEN = { omitted: true, hidden: true } as const;

/**
 * A conflict's values as they may be shown: a site field whose value is never shown (the reference to where the
 * analytics key is kept) is told as changed, without what it holds, in a conflict as in the change list.
 */
export function shownConflictValue(unitKind: string, path: readonly string[], value: unknown): unknown {
  return unitKind === 'site' && path.length > 0 && VALUE_HIDDEN.has(path[0]) ? HIDDEN : shownValue(value);
}

function ownFields(unit: unknown): Record<string, unknown> {
  if (!isPlainObject(unit)) return {};
  const copy = withoutTimestamps(unit);
  for (const key of TREES) delete copy[key];
  return copy;
}

/** A unit that is new or removed as a whole: its elements counted, not listed (UnitReview.elements). */
function whole(elements: ElementChange[]): { elements: ElementChange[]; elementCount: number } {
  return { elements: [], elementCount: elements.length };
}

/** The review of everything `to` changes against `from`. */
export function reviewDocuments(from: MergeDocument, to: MergeDocument): DocumentReview {
  const site = SITE_FIELDS.filter((f) => !jsonEqual(from[f], to[f])).map((f) =>
    // Where the analytics key is kept: named as changed, its value never shown.
    VALUE_HIDDEN.has(f) ? { field: f, before: HIDDEN, after: HIDDEN } : { field: f, before: shownValue(from[f]), after: shownValue(to[f]) },
  );
  const settings = fieldChanges(isPlainObject(from.siteSettings) ? from.siteSettings : {}, isPlainObject(to.siteSettings) ? to.siteSettings : {});

  const units: UnitReview[] = [];
  const fromPages = new Map(from.pages.map((p) => [p.pageId, p]));
  const toPages = new Map(to.pages.map((p) => [p.pageId, p]));
  for (const page of to.pages) {
    const old = fromPages.get(page.pageId);
    const elements = elementChanges(old?.snapshot, page.snapshot);
    const fields = old ? pageFields(old, page) : [];
    if (old && elements.length === 0 && fields.length === 0) continue;
    units.push({
      unit: 'page',
      id: page.pageId,
      title: titleOfPage(page.snapshot, page.slug || 'Home'),
      change: old ? 'changed' : 'added',
      slug: { before: old ? old.slug : null, after: page.slug },
      fields,
      ...(old ? { elements } : whole(elements)),
    });
  }
  for (const page of from.pages) {
    if (toPages.has(page.pageId)) continue;
    units.push({
      unit: 'page',
      id: page.pageId,
      title: titleOfPage(page.snapshot, page.slug || 'Home'),
      change: 'removed',
      slug: { before: page.slug, after: null },
      fields: [],
      ...whole(elementChanges(page.snapshot, undefined)),
    });
  }

  const fromComponents = from.components ?? {};
  const toComponents = to.components ?? {};
  const bodyOf = (definition: unknown) => (isPlainObject(definition) ? definition.page : undefined);
  for (const [id, definition] of Object.entries(toComponents)) {
    const old = fromComponents[id];
    const elements = elementChanges(bodyOf(old), bodyOf(definition));
    const fields = old === undefined ? [] : fieldChanges(componentFields(old), componentFields(definition));
    if (old !== undefined && elements.length === 0 && fields.length === 0) continue;
    units.push({
      unit: 'component', id, title: nameOfComponent(definition, id), change: old === undefined ? 'added' : 'changed', fields,
      ...(old === undefined ? whole(elements) : { elements }),
    });
  }
  for (const [id, definition] of Object.entries(fromComponents)) {
    if (id in toComponents) continue;
    units.push({ unit: 'component', id, title: nameOfComponent(definition, id), change: 'removed', fields: [], ...whole(elementChanges(bodyOf(definition), undefined)) });
  }

  const shared = (pages: MergeDocument['pages'], other: Map<string, unknown>) => pages.map((p) => p.pageId).filter((id) => other.has(id));
  return { site, settings, units, pageOrder: !jsonEqual(shared(from.pages, toPages), shared(to.pages, fromPages)) };
}

function pageFields(before: MergeDocument['pages'][number], after: MergeDocument['pages'][number]): FieldChange[] {
  const out = fieldChanges(ownFields(before.snapshot), ownFields(after.snapshot));
  // The slug lives both on the row and in the snapshot; listed once.
  if (before.slug !== after.slug && !out.some((f) => f.field === 'slug')) out.unshift({ field: 'slug', before: before.slug, after: after.slug });
  return out;
}

function componentFields(definition: unknown): Record<string, unknown> {
  if (!isPlainObject(definition)) return {};
  const { page: _page, ...rest } = withoutTimestamps(definition);
  void _page;
  return rest;
}

/** The element ids a side shows outlined: on the branch what was added, moved or changed; on main what was removed or changed. */
export function outlinedIds(unit: UnitReview, side: 'main' | 'branch'): string[] {
  return unit.elements
    .filter((e) => (side === 'branch' ? e.kind !== 'removed' : e.kind === 'removed' || e.kind === 'changed' || e.kind === 'moved'))
    .map((e) => e.id);
}

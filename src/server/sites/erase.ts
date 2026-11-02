// src/server/sites/erase.ts
//
// Finding and erasing one personal value (a name, an address, a phone number)
// in a site's stored documents: every kept revision and the working copy (plan
// docs/plans/2026-11-01-immutable-published-copy.md, "Erasing personal data
// from the history"). PURE: no Prisma, no `server-only`, so it is testable
// without a database; the repository reads and writes the rows.
//
// One generic walk over the stored JSON, not a list of fields: a field added
// later is searched without a change here. Only string VALUES are rewritten,
// and only where rewriting changes nothing but the value: keys, ids, types,
// addresses, class names, selectors and binding references are reported as
// blocked, never touched. The raw stored JSON is rewritten, never a normalised
// shape, so no trimming or default slips into a frozen revision.
//
// Nothing here logs, and no error message carries the searched value.

import { createHash } from 'node:crypto';
import { parseComponents } from '@/lib/components/definition';
import { parseRevisionDocument } from './revision';

/** Bounds of a search. */
export const ERASE_LIMITS = {
  /** Shorter values would match half a site (`a`, `de`). */
  minChars: 3,
  maxChars: 200,
  /** Matches listed in a preview. The counts and the token always cover all of them. */
  listed: 500,
  /** Characters of context on each side of a match in a preview. */
  excerptContext: 40,
} as const;

/** Where a document lives: one kept revision, or the editor's working copy. */
export type EraseLocation = { kind: 'revision'; number: number } | { kind: 'working' };

/** What kind of place a match is in, for the preview. */
export type EraseArea =
  | 'name'
  | 'description'
  | 'text'
  | 'attribute'
  | 'binding'
  | 'page-metadata'
  | 'component'
  | 'settings'
  | 'theme'
  | 'head'
  | 'address'
  | 'other';

/** Why a match is reported but never rewritten. */
export type EraseBlockReason =
  /** An object key: a name in the structure, not a value. */
  | 'key'
  /** An id, a type, a class name, a selector, a form key: changing it changes more than the value. */
  | 'structural'
  /** A page slug or a redirect address: changing it changes where visitors land. */
  | 'address'
  /** Inside a `{{ }}` binding reference: rewriting it breaks the binding. */
  | 'binding-reference';

export interface EraseMatch {
  /** Stable for the same text at the same place: the erase names left-out matches by it. */
  id: string;
  location: EraseLocation;
  area: EraseArea;
  /** The page the match is on, when it is on one. */
  pageId: string | null;
  /** That page's slug, as stored in this document. */
  pageSlug: string | null;
  /** JSON pointer of the string inside the document (keys only, never values). */
  path: string;
  /** The match with a little context. Personal data: only ever sent to the owner. */
  excerpt: string;
  blocked: EraseBlockReason | null;
}

export interface EraseQuery {
  value: string;
  caseSensitive: boolean;
}

/** A query that cannot be searched. */
export class EraseQueryError extends Error {
  constructor(readonly code: 'value_too_short' | 'value_too_long' | 'replacement_contains_value', message: string) {
    super(message);
    this.name = 'EraseQueryError';
  }
}

/** A rewrite that would have changed the document's shape. The erase rolls back. */
export class EraseShapeError extends Error {
  constructor(detail: string) {
    super(`an erase would change the document's structure: ${detail}`);
    this.name = 'EraseShapeError';
  }
}

/** The searched value, trimmed, checked against the bounds. Throws EraseQueryError. */
export function normalizeEraseValue(raw: string): string {
  const value = raw.trim();
  const length = [...value].length;
  if (length < ERASE_LIMITS.minChars) {
    throw new EraseQueryError('value_too_short', `Search for at least ${ERASE_LIMITS.minChars} characters.`);
  }
  if (length > ERASE_LIMITS.maxChars) {
    throw new EraseQueryError('value_too_long', `Search for at most ${ERASE_LIMITS.maxChars} characters.`);
  }
  return value;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The matcher for a query: the value in its composed and decomposed Unicode
 * forms (an umlaut typed on one system and stored from another), case-insensitive
 * unless asked otherwise. A fresh RegExp per call: a global one keeps state.
 */
export function eraseMatcher(query: EraseQuery): () => RegExp {
  const value = normalizeEraseValue(query.value);
  const forms = [...new Set([value.normalize('NFC'), value.normalize('NFD'), value])]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  const source = forms.join('|');
  const flags = query.caseSensitive ? 'gu' : 'giu';
  return () => new RegExp(source, flags);
}

/** True when `replacement` would itself be found by the query (an erase that never ends). */
export function replacementContainsValue(replacement: string, query: EraseQuery): boolean {
  if (replacement === '') return false;
  return eraseMatcher(query)().test(replacement);
}

// ---------------------------------------------------------------------------
// What may be rewritten

/** Keys whose string value is an identifier, a type or a reference, never content. */
const STRUCTURAL_KEYS = new Set([
  'id',
  'type',
  'componentType',
  'canvasNodeType',
  'kind',
  'mode',
  'scope',
  'schemaVersion',
  'key',
  'field',
  'className',
  'class',
  'selector',
  'selectors',
  'target',
  'targets',
  'owner',
  'of',
  'for',
  'htmlFor',
  'list',
  'form',
  'headers',
  'usemap',
  'useMap',
  'apiKeyRef',
  'ingestionEndpoint',
  'twitterCard',
  'pageBase',
  'language',
  'legalTemplate',
  'successBehavior',
  'aria-controls',
  'aria-labelledby',
  'aria-describedby',
  'aria-owns',
  'aria-activedescendant',
  'aria-flowto',
  'aria-details',
  'aria-errormessage',
  'ariaControls',
  'ariaLabelledby',
  'ariaDescribedby',
]);

/** A key naming an id or a list of ids: `pageId`, `parentId`, `redirectPageId`, `stateIds`. */
function isReferenceKey(key: string): boolean {
  return /(?:^|[a-z0-9_])Ids?$/.test(key) || /_ids?$/.test(key);
}

type Segment = string | number;

/** The nearest object key of a path (an array element takes its array's key). */
function nearestKey(path: readonly Segment[]): { key: string | null; parent: string | null } {
  const keys = path.filter((s): s is string => typeof s === 'string');
  return { key: keys.at(-1) ?? null, parent: keys.at(-2) ?? null };
}

function isAddressPath(path: readonly Segment[]): boolean {
  // `pages/<i>/slug` of a document, and every string of a redirect entry.
  return (path[0] === 'pages' && path[2] === 'slug' && path.length === 3) || path[0] === 'redirects';
}

/** Why a string at `path` may not be rewritten, or null when it may. */
function blockedAt(path: readonly Segment[]): EraseBlockReason | null {
  if (isAddressPath(path)) return 'address';
  const { key, parent } = nearestKey(path);
  if (key === null) return null;
  if (STRUCTURAL_KEYS.has(key) || isReferenceKey(key) || key.startsWith('data-')) return 'structural';
  // An element's `name` attribute is the key a form submits; elsewhere `name` is a display name.
  if (key === 'name' && parent === 'props') return 'structural';
  return null;
}

/** The `{{ ... }}` spans of a string, as [start, end) ranges. */
function bindingSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const re = /\{\{[\s\S]*?\}\}/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) spans.push([m.index, m.index + m[0].length]);
  return spans;
}

function overlaps(start: number, end: number, spans: Array<[number, number]>): boolean {
  return spans.some(([a, b]) => start < b && end > a);
}

function areaOf(path: readonly Segment[]): EraseArea {
  const [head, , third] = path;
  if (isAddressPath(path)) return 'address';
  if (head === 'name') return 'name';
  if (head === 'description') return 'description';
  if (head === 'siteSettings') {
    if (path[1] === 'theme') return 'theme';
    if (path[1] === 'head') return 'head';
    return 'settings';
  }
  if (head === 'components') return 'component';
  if (head === 'pages') {
    if (third === 'snapshot' && path[3] === 'metadata') return 'page-metadata';
    if (path.includes('bindings')) return 'binding';
    const props = path.lastIndexOf('props');
    if (props >= 0) return path[props + 1] === 'children' ? 'text' : 'attribute';
    return 'other';
  }
  return 'other';
}

function pointer(path: readonly Segment[]): string {
  return path.length === 0
    ? ''
    : `/${path.map((s) => String(s).replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}`;
}

function locationKey(location: EraseLocation): string {
  return location.kind === 'revision' ? `revision:${location.number}` : 'working';
}

function digest(...parts: string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part).update('\u0000');
  return hash.digest('hex');
}

function excerptOf(text: string, start: number, end: number): string {
  const context = ERASE_LIMITS.excerptContext;
  const from = Math.max(0, start - context);
  const to = Math.min(text.length, end + context);
  return `${from > 0 ? '...' : ''}${text.slice(from, to)}${to < text.length ? '...' : ''}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pageAt(document: unknown, path: readonly Segment[]): { pageId: string | null; pageSlug: string | null } {
  if (path[0] !== 'pages' || typeof path[1] !== 'number' || !isRecord(document)) return { pageId: null, pageSlug: null };
  const pages = document.pages;
  const page = Array.isArray(pages) ? pages[path[1]] : undefined;
  if (!isRecord(page)) return { pageId: null, pageSlug: null };
  return {
    pageId: typeof page.pageId === 'string' ? page.pageId : null,
    pageSlug: typeof page.slug === 'string' ? page.slug : null,
  };
}

/** One occurrence found while walking. */
interface Occurrence {
  match: EraseMatch;
  start: number;
  end: number;
}

/**
 * Every occurrence in one string. The id binds the location, the path, the
 * occurrence's index and the whole string as it is, so a string changed since
 * the preview yields new ids and a stale preview is caught.
 */
function occurrencesIn(
  text: string,
  path: readonly Segment[],
  location: EraseLocation,
  document: unknown,
  matcher: () => RegExp,
  asKey: boolean,
): Occurrence[] {
  const re = matcher();
  const found: Occurrence[] = [];
  let spans: Array<[number, number]> | null = null;
  const textHash = digest(text);
  let index = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    const start = m.index;
    const end = start + m[0].length;
    let blocked: EraseBlockReason | null = asKey ? 'key' : blockedAt(path);
    if (blocked === null) {
      spans ??= bindingSpans(text);
      if (overlaps(start, end, spans)) blocked = 'binding-reference';
    }
    const where = pointer(path);
    const { pageId, pageSlug } = pageAt(document, path);
    found.push({
      start,
      end,
      match: {
        id: digest(locationKey(location), asKey ? 'key' : 'value', where, String(index), textHash).slice(0, 32),
        location,
        area: areaOf(path),
        pageId,
        pageSlug,
        path: where,
        excerpt: excerptOf(text, start, end),
        blocked,
      },
    });
    index++;
  }
  return found;
}

function walk(
  value: unknown,
  path: Segment[],
  visit: (text: string, path: readonly Segment[], asKey: boolean) => void,
): void {
  if (typeof value === 'string') {
    visit(value, path, false);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, [...path, i], visit));
    return;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      visit(key, [...path, key], true);
      walk(item, [...path, key], visit);
    }
  }
}

/** Every match of the query in one stored document, in document order. */
export function findMatches(document: unknown, location: EraseLocation, matcher: () => RegExp): EraseMatch[] {
  const matches: EraseMatch[] = [];
  walk(document, [], (text, path, asKey) => {
    for (const { match } of occurrencesIn(text, path, location, document, matcher, asKey)) matches.push(match);
  });
  return matches;
}

/** The token a preview hands out and an erase must repeat: a digest of every match id. */
export function matchesToken(matches: readonly EraseMatch[]): string {
  return digest(...matches.map((m) => m.id).sort()).slice(0, 32);
}

export interface RewriteResult {
  /** The document with the chosen matches replaced; the input itself is never changed. */
  document: unknown;
  /** The matches replaced. */
  erased: EraseMatch[];
}

/**
 * Replace every erasable match not in `leaveOut` with `replacement`. Strings
 * without a chosen match, and every object and array on no changed path, are
 * the very same values as before, so nothing else in the document moves.
 */
export function rewriteDocument(
  document: unknown,
  location: EraseLocation,
  matcher: () => RegExp,
  replacement: string,
  leaveOut: ReadonlySet<string>,
): RewriteResult {
  const erased: EraseMatch[] = [];

  const rewrite = (value: unknown, path: Segment[]): unknown => {
    if (typeof value === 'string') {
      const chosen = occurrencesIn(value, path, location, document, matcher, false).filter(
        (o) => o.match.blocked === null && !leaveOut.has(o.match.id),
      );
      if (chosen.length === 0) return value;
      let out = value;
      // From the end, so earlier offsets stay valid.
      for (const o of [...chosen].reverse()) out = out.slice(0, o.start) + replacement + out.slice(o.end);
      erased.push(...chosen.map((o) => o.match));
      return out;
    }
    if (Array.isArray(value)) {
      let changed = false;
      const next = value.map((item, i) => {
        const r = rewrite(item, [...path, i]);
        if (r !== item) changed = true;
        return r;
      });
      return changed ? next : value;
    }
    if (isRecord(value)) {
      let changed = false;
      const next: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        const r = rewrite(item, [...path, key]);
        if (r !== item) changed = true;
        next[key] = r;
      }
      return changed ? next : value;
    }
    return value;
  };

  return { document: rewrite(document, []), erased };
}

function pageKeys(document: unknown): string {
  if (!isRecord(document) || !Array.isArray(document.pages)) return '[]';
  return JSON.stringify(
    document.pages.map((p: unknown) => (isRecord(p) ? [p.pageId, p.slug] : null)),
  );
}

function refusedIds(components: unknown): string[] {
  return parseComponents(components).refused.map((r) => r.id).sort();
}

/**
 * The checks a rewritten revision must pass, or the whole erase rolls back: it
 * still parses, holds the same pages with the same slugs, and no component
 * definition is refused that was readable before. Throws EraseShapeError.
 */
export function assertRevisionShapeKept(before: unknown, after: unknown): void {
  try {
    parseRevisionDocument(after);
  } catch (err) {
    throw new EraseShapeError(err instanceof Error ? err.message : 'unreadable');
  }
  if (pageKeys(before) !== pageKeys(after)) throw new EraseShapeError('pages or slugs changed');
  const beforeComponents = isRecord(before) ? before.components : undefined;
  const afterComponents = isRecord(after) ? after.components : undefined;
  const newlyRefused = refusedIds(afterComponents).filter((id) => !refusedIds(beforeComponents).includes(id));
  if (newlyRefused.length > 0) throw new EraseShapeError(`component definitions no longer readable: ${newlyRefused.join(', ')}`);
}

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
// and only where rewriting changes nothing but the value. Reported as blocked,
// never touched: keys, ids and everything that points at an id (the attribute
// list of src/lib/renderer/idRefs.ts, `#fragment` links, behaviour references),
// types, page addresses and the internal links into them, image and file
// addresses, class names, selectors, form keys and binding references. The raw
// stored JSON is rewritten, never a normalised shape, so no trimming or default
// slips into a frozen revision.
//
// Matching is whole words by default and tolerant of how the same text is
// stored: any run of spaces (non-breaking ones included) and soft hyphens, HTML
// entities, both Unicode forms of an umlaut, and case (ß matches ss) unless the
// owner asks for an exact case.
//
// Nothing here logs, and no error message carries the searched value.

import { createHash } from 'node:crypto';
import { parseComponents } from '@/lib/components/definition';
import { readBehaviourTree, type BehaviourNode } from '@/lib/behaviour/format';
import { ID_FRAGMENT_NAMES, isIdReference } from '@/lib/renderer/idRefs';
import { normalizeSiteSettings } from '@/lib/site/siteSettings';
import { themeBoundsErrors } from '@/lib/site/theme';
import { parseRevisionDocument } from './revision';

/** Bounds of a search. */
export const ERASE_LIMITS = {
  /** Shorter values would match half a site (`a`, `de`). */
  minChars: 3,
  maxChars: 200,
  /** Matches listed in a preview, and so the most one erase can rewrite. The counts and the token cover all. */
  listed: 500,
  /** Characters of context on each side of a match in a preview. */
  excerptContext: 40,
} as const;

/**
 * Where a document lives: one kept revision, the editor's working copy, or a copy a site branch keeps (plan
 * docs/plans/2026-11-10-site-branches.md): an open branch's working copy with its record's name and review note
 * (for a closed branch, the record alone), a branch's fork point, and main as it was before a merge. `name` is the
 * branch's name for the preview; only the id is part of a match's identity.
 */
export type EraseLocation =
  | { kind: 'revision'; number: number }
  | { kind: 'working' }
  | { kind: 'branch'; branchId: string; name: string; branchStatus: EraseBranchStatus }
  | { kind: 'branch-base'; branchId: string; name: string; branchStatus: EraseBranchStatus }
  | { kind: 'merge-undo'; branchId: string; name: string; branchStatus: EraseBranchStatus };

/** A branch's state, so the preview tells an open branch from a closed one of the same name. */
export type EraseBranchStatus = 'open' | 'ready' | 'merged' | 'discarded';

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
  | 'domain'
  | 'experiment'
  | 'branch'
  | 'other';

/** Why a match is reported but never rewritten. */
export type EraseBlockReason =
  /** An object key: a name in the structure, not a value. */
  | 'key'
  /** An id or a reference to one, a type, a class name, a selector, a form key: changing it changes more than the value. */
  | 'structural'
  /** A page slug, a redirect address, or an internal link into a page: changing it changes where visitors land. */
  | 'address'
  /** An image or file address: cutting it breaks the image while the file stays reachable at its old address. */
  | 'url'
  /** Inside a `{{ }}` binding reference: rewriting it breaks the binding. */
  | 'binding-reference'
  /** Kept outside the published versions (a domain, an A/B test): changed where it is set. */
  | 'separate';

export interface EraseMatch {
  /** Stable for the same text at the same place: the erase names the chosen matches by it. */
  id: string;
  location: EraseLocation;
  area: EraseArea;
  /** The page the match is on, when it is on one. */
  pageId: string | null;
  /** That page's slug, as stored in this document. */
  pageSlug: string | null;
  /** JSON pointer of the string inside the document. Personal data when a key holds the value: see redactedPath. */
  path: string;
  /** The match with a little context. Personal data: only ever sent to the owner. */
  excerpt: string;
  blocked: EraseBlockReason | null;
}

export interface EraseQuery {
  value: string;
  caseSensitive: boolean;
  /** Also find the value inside longer words (`Anna` in `Annahme`). Off by default. */
  insideWords?: boolean;
}

/** A query or a replacement that cannot be used. */
export class EraseQueryError extends Error {
  constructor(
    readonly code: 'value_too_short' | 'value_too_long' | 'replacement_contains_value' | 'replacement_has_binding',
    message: string,
  ) {
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

const SOFT_HYPHEN = '­';

/** The searched value, trimmed, checked against the bounds. Throws EraseQueryError. */
export function normalizeEraseValue(raw: string): string {
  const value = raw.normalize('NFC').split(SOFT_HYPHEN).join('').replace(/\s+/gu, ' ').trim();
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

/** A literal that ignores case only in the parts the regex's own flag cannot reach (entity names stay exact). */
function anyCase(text: string): string {
  return [...text].map((c) => (/[a-z]/i.test(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : escapeRegExp(c))).join('');
}

/** The HTML entity names worth knowing for German and Latin text. */
const NAMED_ENTITIES: Record<string, string> = {
  ä: 'auml', ö: 'ouml', ü: 'uuml', Ä: 'Auml', Ö: 'Ouml', Ü: 'Uuml', ß: 'szlig',
  é: 'eacute', è: 'egrave', ê: 'ecirc', á: 'aacute', à: 'agrave', â: 'acirc', ç: 'ccedil', ñ: 'ntilde',
  ó: 'oacute', ò: 'ograve', ô: 'ocirc', í: 'iacute', ì: 'igrave', ú: 'uacute', ù: 'ugrave',
  '&': 'amp', '"': 'quot', "'": 'apos', '<': 'lt', '>': 'gt',
};

/** The ways one character of the value may be stored: itself, decomposed, as an entity. */
function charPattern(ch: string, caseSensitive: boolean): string {
  const variants = new Set<string>([escapeRegExp(ch)]);
  const decomposed = ch.normalize('NFD');
  if (decomposed !== ch) variants.add(escapeRegExp(decomposed));
  if (!/[A-Za-z0-9]/.test(ch)) {
    const cases = caseSensitive ? [ch] : [...new Set([ch, ch.toLowerCase(), ch.toUpperCase()])];
    for (const c of cases) {
      const cp = c.codePointAt(0)!;
      variants.add(`&#0*${cp};`);
      variants.add(`&#[xX]0*${anyCase(cp.toString(16))};`);
      if (NAMED_ENTITIES[c]) variants.add(`&${NAMED_ENTITIES[c]};`);
    }
  }
  if (!caseSensitive && (ch === 'ß' || ch === 'ẞ')) variants.add('[sS][sS]');
  return variants.size === 1 ? [...variants][0] : `(?:${[...variants].join('|')})`;
}

/** Any run of spaces, non-breaking spaces (also as entities) and soft hyphens. */
const SPACE_RUN = `(?:[\\s${SOFT_HYPHEN}]|&nbsp;|&#0*160;|&#[xX]0*[aA]0;)+`;
/** A soft hyphen (or its entity) that may sit between any two letters. */
const OPTIONAL_SHY = `(?:${SOFT_HYPHEN}|&shy;|&#0*173;|&#[xX]0*[aA][dD];)?`;

/**
 * The matcher for a query. A fresh RegExp per call: a global one keeps state.
 * Throws EraseQueryError for a value outside the bounds.
 */
export function eraseMatcher(query: EraseQuery): () => RegExp {
  const value = normalizeEraseValue(query.value);
  const chars = [...value];
  const parts: string[] = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === ' ') {
      parts.push(SPACE_RUN);
      continue;
    }
    if (parts.length > 0 && chars[i - 1] !== ' ') parts.push(OPTIONAL_SHY);
    // `ss` in the value also finds ß, when case is not exact (Unicode case folding).
    if (!query.caseSensitive && ch.toLowerCase() === 's' && chars[i + 1]?.toLowerCase() === 's') {
      parts.push(`(?:[sS]${OPTIONAL_SHY}[sS]|ß|ẞ|&szlig;)`);
      i++;
      continue;
    }
    parts.push(charPattern(ch, query.caseSensitive));
  }
  let source = parts.join('');
  // A combining mark belongs to its letter: `Beck` must not end where decomposed `Lübeck`'s umlaut does.
  if (query.insideWords !== true) source = `(?<![\\p{L}\\p{M}\\p{N}])${source}(?![\\p{L}\\p{M}\\p{N}])`;
  const flags = query.caseSensitive ? 'gu' : 'giu';
  return () => new RegExp(source, flags);
}

/**
 * Why a replacement cannot be used, or null: it may not hold the value (an erase
 * that never ends) nor a binding template, which would turn into live data in text.
 */
export function replacementProblem(replacement: string, query: EraseQuery): EraseQueryError | null {
  if (replacement.includes('{{') || replacement.includes('}}')) {
    return new EraseQueryError('replacement_has_binding', 'The replacement may not contain {{ or }}.');
  }
  if (replacement !== '' && eraseMatcher({ ...query, insideWords: true })().test(replacement)) {
    return new EraseQueryError('replacement_contains_value', 'The replacement may not contain the value being erased.');
  }
  return null;
}

// ---------------------------------------------------------------------------
// What may be rewritten

/**
 * Keys whose string value is an identifier, a type or a reference, never content.
 * Checked against the stored formats on 2026-11-02: theme tokens are referenced by
 * id (`theme.ts`), so a token's `name` is a label; behaviour rules name nodes and
 * states by id under their verbs, and hold enumerations under the rest
 * (`behaviour/format.ts`, `targetOf` and `stateOf`); a component definition's
 * `name` and an input's `name` are labels shown in the editor. Every attribute
 * that holds an id comes from src/lib/renderer/idRefs.ts on top of these.
 */
const STRUCTURAL_KEYS = new Set([
  // behaviour: references to nodes and states, and enumerations
  'state', 'on', 'keys', 'set', 'step', 'toggle', 'effect', 'filter', 'focus', 'media', 'rove', 'scroll', 'setProp',
  'op', 'move', 'axis', 'wrap', 'role', 'prop', 'block', 'preset', 'get', 'attr', 'noScript',
  // node and document structure
  'id', 'type', 'componentType', 'canvasNodeType', 'kind', 'mode', 'scope', 'schemaVersion', 'key', 'field',
  'className', 'class', 'selector', 'selectors', 'target', 'targets', 'owner', 'of', 'htmlFor', 'usemap', 'useMap',
  'apiKeyRef', 'ingestionEndpoint', 'twitterCard', 'pageBase', 'language', 'legalTemplate', 'successBehavior',
  'ariaControls', 'ariaLabelledby', 'ariaDescribedby',
]);

/** Keys whose value is an address of an image or a file, cut never, whatever its shape. */
const URL_KEYS = new Set([
  'src', 'srcset', 'srcSet', 'poster', 'faviconUrl', 'ogImageUrl', 'ogImage', 'canonicalUrl', 'imageUrl', 'url',
  'backgroundImage',
]);

/** Keys whose value is a link a visitor follows. */
const LINK_KEYS = new Set(['href', 'navigate', 'action', 'formAction', 'to']);

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
  // Every string of a redirect entry, `pages/<i>/slug` (the mirror column), the page
  // snapshot's own `slug` (what the editor and the next Save read) and a component
  // definition's page slug.
  if (path[0] === 'redirects') return true;
  if (path[0] === 'pages' && path[2] === 'slug' && path.length === 3) return true;
  if (path[0] === 'pages' && path[2] === 'snapshot' && path[3] === 'slug' && path.length === 4) return true;
  return path[0] === 'components' && path[2] === 'page' && path[3] === 'slug' && path.length === 4;
}

/** An absolute address (`https:`, `//cdn`, `data:`), except a mail or phone link, which is the personal data itself. */
function isFileAddress(text: string): boolean {
  const value = text.trim();
  if (/^(?:mailto|tel|sms):/i.test(value)) return false;
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value);
}

/** Why a string at `path` may not be rewritten at all, or null when it may. */
function blockedAt(path: readonly Segment[], text: string): EraseBlockReason | null {
  if (path[0] === 'domains' || path[0] === 'experiments') return 'separate';
  if (isAddressPath(path)) return 'address';
  const { key, parent } = nearestKey(path);
  if (key === null) return null;
  if (STRUCTURAL_KEYS.has(key) || isIdReference(key) || isReferenceKey(key) || key.startsWith('data-')) return 'structural';
  // An element's `name` attribute is the key a form submits; elsewhere `name` is a display name.
  if (key === 'name' && parent === 'props') return 'structural';
  if (ID_FRAGMENT_NAMES.has(key.toLowerCase()) && text.trim().startsWith('#')) return 'structural';
  // A whole value that is a `#fragment` points at an id wherever it is stored.
  if (/^#[^\s#]+$/.test(text.trim())) return 'structural';
  // A link is one address, rooted or relative (`/team`, `team`, `./team`, `../team/max`):
  // cutting it sends visitors elsewhere. Only a mail or phone link is the data itself.
  if (LINK_KEYS.has(key) && !/\s/.test(text.trim()) && !/^(?:mailto|tel|sms):/i.test(text.trim())) {
    return isFileAddress(text) ? 'url' : 'address';
  }
  if (URL_KEYS.has(key)) return 'url';
  if (isFileAddress(text) && !/\s/.test(text.trim())) return 'url';
  return null;
}

/** The [start, end) ranges a match may not overlap: `{{ ... }}` templates and CSS `url(...)`. */
function protectedSpans(text: string): Array<[number, number, EraseBlockReason]> {
  const spans: Array<[number, number, EraseBlockReason]> = [];
  for (const [re, reason] of [
    [/\{\{[\s\S]*?\}\}/g, 'binding-reference'],
    [/url\([^)]*\)/gi, 'url'],
  ] as const) {
    for (let m = re.exec(text); m !== null; m = re.exec(text)) spans.push([m.index, m.index + m[0].length, reason]);
  }
  return spans;
}

function areaOf(path: readonly Segment[]): EraseArea {
  const [head, , third] = path;
  if (head === 'domains') return 'domain';
  if (head === 'experiments') return 'experiment';
  // A branch record's own text, beside a branch's working copy.
  if (head === 'branchName' || head === 'reviewNote') return 'branch';
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

function encodeSegment(segment: Segment): string {
  return String(segment).replace(/~/g, '~0').replace(/\//g, '~1');
}

function pointer(path: readonly Segment[]): string {
  return path.length === 0 ? '' : `/${path.map(encodeSegment).join('/')}`;
}

/** The marker an audit path holds where a key held the value. */
export const REDACTED_SEGMENT = '[value]';

/** `-`, `_` and `.` read as spaces when deciding what to mask: `max-mustermann` is the same name. */
const SEPARATORS = /[-_.]+/g;

/**
 * What the audit masks, wider than the search on purpose: inside words (a
 * genitive, `Mustermanns Team`), and with `-`, `_` and `.` read as spaces on both
 * sides (`max-mustermann`, `max_mustermann`). Throws EraseQueryError for a value
 * outside the bounds, as the search does.
 */
export function redactionMatcher(query: EraseQuery): (segment: string) => boolean {
  const matcher = eraseMatcher({ ...query, value: query.value.replace(SEPARATORS, ' '), insideWords: true });
  return (segment) => matcher().test(segment.replace(SEPARATORS, ' '));
}

/**
 * A JSON pointer with every segment that may hold the value replaced by
 * REDACTED_SEGMENT, so a map keyed by the value (`/people/Max Mustermann/label`)
 * never carries it into the audit row.
 */
export function redactedPath(path: string, holdsValue: (segment: string) => boolean): string {
  if (path === '') return path;
  return path
    .slice(1)
    .split('/')
    .map((raw) => {
      const segment = raw.replace(/~1/g, '/').replace(/~0/g, '~');
      return holdsValue(segment) ? REDACTED_SEGMENT : raw;
    })
    .map((s) => `/${s}`)
    .join('');
}

/** An id that may hold the value is redacted like a path segment. */
export function redactedId(id: string | null, holdsValue: (segment: string) => boolean): string | null {
  return id !== null && holdsValue(id) ? REDACTED_SEGMENT : id;
}

function locationKey(location: EraseLocation): string {
  if (location.kind === 'revision') return `revision:${location.number}`;
  if (location.kind === 'working') return 'working';
  return `${location.kind}:${location.branchId}`;
}

function digest(...parts: string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part).update('\u0000');
  return hash.digest('hex');
}

/** Context around a match, cut on code points so an emoji is never split. */
function excerptOf(text: string, start: number, end: number): string {
  const context = ERASE_LIMITS.excerptContext;
  const before = [...text.slice(0, start)];
  const after = [...text.slice(end)];
  const head = before.slice(Math.max(0, before.length - context)).join('');
  const tail = after.slice(0, context).join('');
  return `${before.length > context ? '...' : ''}${head}${text.slice(start, end)}${tail}${after.length > context ? '...' : ''}`;
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
  let spans: Array<[number, number, EraseBlockReason]> | null = null;
  const textHash = digest(text);
  const whole = asKey ? 'key' : blockedAt(path, text);
  let index = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    const start = m.index;
    const end = start + m[0].length;
    let blocked: EraseBlockReason | null = whole;
    if (blocked === null) {
      spans ??= protectedSpans(text);
      blocked = spans.find(([a, b]) => start < b && end > a)?.[2] ?? null;
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

const SPACE_AT_END = /[\s ]+$/u;
const SPACE_AT_START = /^[\s ]+/u;

/**
 * Cut one match out. With a replacement, exactly the match is replaced. Without
 * one, the text around the cut is tidied so no residue is left: a doubled space
 * becomes one, and a list separator left with nothing to separate goes
 * (`Geschäftsführer: Max Mustermann, Erika Muster` -> `Geschäftsführer: Erika Muster`).
 */
function cut(text: string, start: number, end: number, replacement: string): string {
  const left = text.slice(0, start);
  const right = text.slice(end);
  if (replacement !== '') return left + replacement + right;
  const leftTrim = left.replace(SPACE_AT_END, '');
  const rightTrim = right.replace(SPACE_AT_START, '');
  const leftSpace = leftTrim.length !== left.length;
  if (/^[,;]/.test(rightTrim) && (leftTrim === '' || /[,;:([]$/.test(leftTrim))) {
    const rest = rightTrim.slice(1).replace(SPACE_AT_START, '');
    return leftTrim + (leftTrim !== '' && rest !== '' && leftSpace ? ' ' : '') + rest;
  }
  if (/[,;]$/.test(leftTrim) && (rightTrim === '' || /^[)\].!?]/.test(rightTrim))) return leftTrim.slice(0, -1) + rightTrim;
  if (leftTrim === '') return rightTrim;
  if (rightTrim === '') return leftTrim;
  if (leftSpace && rightTrim.length !== right.length) return left + rightTrim;
  return left + right;
}

/** Set an own property, `__proto__` included, without touching the prototype. */
function own(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * Replace exactly the erasable matches in `chosen` with `replacement`. Strings
 * without a chosen match, and every object and array on no changed path, are
 * the very same values as before, so nothing else in the document moves.
 */
export function rewriteDocument(
  document: unknown,
  location: EraseLocation,
  matcher: () => RegExp,
  replacement: string,
  chosen: ReadonlySet<string>,
): RewriteResult {
  const erased: EraseMatch[] = [];

  const rewrite = (value: unknown, path: Segment[]): unknown => {
    if (typeof value === 'string') {
      const picked = occurrencesIn(value, path, location, document, matcher, false).filter(
        (o) => o.match.blocked === null && chosen.has(o.match.id),
      );
      if (picked.length === 0) return value;
      let out = value;
      // From the end, so earlier offsets stay valid (a tidy only touches text after an earlier match).
      for (const o of [...picked].reverse()) out = cut(out, o.start, o.end, replacement);
      erased.push(...picked.map((o) => o.match));
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
        own(next, key, r);
      }
      return changed ? next : value;
    }
    return value;
  };

  return { document: rewrite(document, []), erased };
}

// ---------------------------------------------------------------------------
// The shape a rewrite must keep

function pageKeys(document: unknown): string {
  if (!isRecord(document) || !Array.isArray(document.pages)) return '[]';
  return JSON.stringify(document.pages.map((p: unknown) => (isRecord(p) ? [p.pageId, p.slug] : null)));
}

function refusedIds(components: unknown): string[] {
  return parseComponents(components).refused.map((r) => r.id).sort();
}

/** The trees behaviour runs on: every page's, and every component definition's. */
function behaviourTrees(document: unknown): Array<[string, BehaviourNode]> {
  if (!isRecord(document)) return [];
  const trees: Array<[string, BehaviourNode]> = [];
  const pages = Array.isArray(document.pages) ? document.pages : [];
  pages.forEach((page: unknown, i) => {
    const tree = isRecord(page) && isRecord(page.snapshot) ? page.snapshot.appComponentTree : undefined;
    if (isRecord(tree)) trees.push([`page ${i}`, tree as BehaviourNode]);
  });
  if (isRecord(document.components)) {
    for (const [id, definition] of Object.entries(document.components)) {
      const tree = isRecord(definition) && isRecord(definition.page) ? definition.page.appComponentTree : undefined;
      if (isRecord(tree)) trees.push([`component ${id}`, tree as BehaviourNode]);
    }
  }
  return trees;
}

function behaviourRefusals(tree: BehaviourNode): number {
  try {
    return readBehaviourTree(tree).refused.length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * The checks a rewritten document must pass, or the whole erase rolls back: the
 * same pages with the same slugs, no component definition refused that was
 * readable before, no behaviour refused that ran before, and for a revision, a
 * document that still parses. Throws EraseShapeError.
 */
export function assertShapeKept(before: unknown, after: unknown, options: { revision: boolean }): void {
  if (options.revision) {
    try {
      parseRevisionDocument(after);
    } catch (err) {
      throw new EraseShapeError(err instanceof Error ? err.message : 'unreadable');
    }
  }
  if (pageKeys(before) !== pageKeys(after)) throw new EraseShapeError('pages or slugs changed');
  // A replacement inside a token name may not push the name past the theme's bounds,
  // the check a save holds (themeBoundsErrors), judged against the theme as it was.
  if (isRecord(before) && isRecord(after)) {
    const themeProblems = themeBoundsErrors(normalizeSiteSettings(after.siteSettings).theme, normalizeSiteSettings(before.siteSettings).theme);
    if (themeProblems.length > 0) throw new EraseShapeError(`theme bounds: ${themeProblems.join(' ')}`);
  }
  const beforeComponents = isRecord(before) ? before.components : undefined;
  const afterComponents = isRecord(after) ? after.components : undefined;
  const wasRefused = refusedIds(beforeComponents);
  const newlyRefused = refusedIds(afterComponents).filter((id) => !wasRefused.includes(id));
  if (newlyRefused.length > 0) throw new EraseShapeError(`component definitions no longer readable: ${newlyRefused.join(', ')}`);
  const beforeTrees = new Map(behaviourTrees(before));
  for (const [where, tree] of behaviourTrees(after)) {
    const previous = beforeTrees.get(where);
    if (previous && behaviourRefusals(tree) > behaviourRefusals(previous)) {
      throw new EraseShapeError(`behaviour on ${where} would no longer run`);
    }
  }
}

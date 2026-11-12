// src/lib/site/headItems.ts
//
// Head items: the tags a page or a site may add to its <head> beyond the search metadata the
// SEO fields write (plan docs/plans/2026-11-02-theme-and-head.md, "Head items", slice H1).
// PURE: no Next runtime, no MST, no database, so every rule is unit-tested.
//
// An item is stored as plain JSON of a closed shape, and a stored item is NEVER written to the
// page as it is. `parseHeadItem` is the single entry: it rebuilds a fresh item field by field
// from the kind's own keys and refuses anything else, with a reason the panel can show. What a
// kind cannot say (http-equiv, a stylesheet, a script, a second attribute) has no field.
//
// Copying: nothing here uses Object.assign or a loop of `out[key] = value`, which would treat a
// `__proto__` key as the prototype setter and forge a prototype. Items are rebuilt from fixed
// keys; JSON-LD data is cloned through Object.fromEntries, which creates own data properties.
//
// Emission itself (H2) and the panel (H3) are not here: this is the model.

/** The kinds of head item. */
export const HEAD_KINDS = ['meta', 'property', 'link', 'jsonld'] as const;
export type HeadKind = (typeof HEAD_KINDS)[number];

/** The rels a `link` item may carry: each measured to contact no other host in three browser engines. */
export const LINK_RELS = ['alternate', 'me', 'author', 'license', 'help', 'privacy-policy', 'terms-of-service'] as const;
export type LinkRel = (typeof LINK_RELS)[number];

/** The feed types an `alternate` link may carry in place of a language. */
export const FEED_TYPES = ['application/rss+xml', 'application/atom+xml', 'application/feed+json'] as const;

export type HeadItem =
  | { kind: 'meta'; name: string; content: string }
  | { kind: 'property'; property: string; content: string }
  | { kind: 'link'; rel: LinkRel; href: string; hreflang?: string; type?: string; title?: string }
  | { kind: 'jsonld'; data: Record<string, unknown> };

/** A head item as stored: any plain object with a string `kind`, valid or not (parsed at emission). */
export type StoredHeadItem = { kind: string } & Record<string, unknown>;

export const HEAD_LIMITS = {
  /** Items one page may hold. */
  pageItems: 30,
  /** Items the site may hold for every page. */
  siteItems: 20,
  /** `content`, `title` and a property or name. */
  content: 500,
  href: 2048,
  /** JSON-LD after serialising, in bytes. */
  jsonLdBytes: 16 * 1024,
  jsonLdDepth: 12,
  /** JSON-LD items on one rendered page, site and page together, the page's first. */
  jsonLdPerPage: 3,
  /** Values in one JSON-LD item, so a wide object is refused before it is serialised. */
  jsonLdNodes: 5000,
} as const;

// ---------------------------------------------------------------------------
// The closed lists
// ---------------------------------------------------------------------------

/** `meta` names, exact and lower case. A new name is a one-line change here plus its reason in the plan. */
export const META_NAMES: ReadonlySet<string> = new Set([
  'author',
  'application-name',
  'apple-mobile-web-app-title',
  'format-detection',
  'rating',
  'twitter:site',
  'twitter:creator',
  'geo.region',
  'geo.placename',
  'geo.position',
  'google-site-verification',
  'msvalidate.01',
  'yandex-verification',
  'baidu-site-verification',
  'facebook-domain-verification',
  'p:domain_verify',
  'ahrefs-site-verification',
]);

/** The prefixes whose properties are allowed: `article:tag`, `product:price:amount`, ... */
export const PROPERTY_PREFIXES: readonly string[] = ['article:', 'product:', 'profile:', 'book:'];

/** `property` entries allowed by exact name. */
export const PROPERTY_NAMES: ReadonlySet<string> = new Set(['fb:app_id', 'og:locale:alternate', 'og:video', 'og:audio']);

/** The shape every allowed property has. */
const PROPERTY_SHAPE = /^[a-z]+(:[a-z_]+)+$/;

/** Keys that may appear more than once on a page: both emit, an exact duplicate drops. */
const REPEATABLE_KEYS: ReadonlySet<string> = new Set([
  'property:article:tag',
  'property:article:author',
  'property:book:tag',
  'property:book:author',
  'property:og:locale:alternate',
  'property:og:video',
  'property:og:audio',
  'link:me||',
]);

/**
 * Names the SEO fields own: `pageMetadata` writes them, so a second copy would disagree with the
 * panel. The value is the refusal's pointer to the field to use.
 */
const OWNED: ReadonlyMap<string, string> = new Map([
  ['description', "the page's Description"],
  ['keywords', "the page's Keywords"],
  ['robots', "the page's Hide from search engines switch"],
  ['og:title', "the page's Social title"],
  ['og:description', "the page's Social description"],
  ['og:image', "the page's Social image"],
  ['og:url', "the page's Canonical address"],
  ['og:site_name', 'the Site name in Site settings'],
  ['og:locale', 'the Language in Site settings'],
  ['og:type', "the page's Content type"],
  ['twitter:card', 'the Twitter card in Site settings'],
  ['twitter:title', "the page's Social title"],
  ['twitter:description', "the page's Social description"],
  ['twitter:image', "the page's Social image"],
]);

/** Names the route owns or that change how the page behaves, each with its reason. */
const ROUTE_OWNED: ReadonlyMap<string, string> = new Map([
  ['viewport', 'the page layout owns the viewport'],
  ['color-scheme', "the site's colour mode owns it"],
  ['theme-color', "the site's colour mode owns it"],
  ['referrer', 'it is a privacy setting, not a label'],
  ['charset', 'the character set is not owner data'],
  ['itemprop', 'it only works inside the page body'],
]);

/** Open Graph content types a page may choose. `product` is not here: Next's metadata API refuses it. */
export const OG_TYPES = ['website', 'article', 'book', 'profile'] as const;
export type OgType = (typeof OG_TYPES)[number];
export const DEFAULT_OG_TYPE: OgType = 'website';

/** Any stored value -> a content type Next accepts; anything else is `website`, never a thrown error. */
export function parseOgType(value: unknown): OgType {
  return OG_TYPES.find((t) => t === value) ?? DEFAULT_OG_TYPE;
}

// ---------------------------------------------------------------------------
// Reading a stored value safely
// ---------------------------------------------------------------------------

/** A plain object: prototype Object.prototype or null. Never an array, a class instance or a forged prototype. */
function isPlain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** An own property's value, or undefined. Never reads the prototype chain. */
function own(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

const CONTROL = /[\u0000-\u001f\u007f]/;

/** Plain text the item may hold: a string, not empty, one line, within the cap. */
function textProblem(value: unknown, label: string, max: number): string | null {
  if (typeof value !== 'string') return `${label} must be text.`;
  if (value.trim() === '') return `${label} is empty.`;
  if (value.length > max) return `${label} is longer than ${max} characters.`;
  if (CONTROL.test(value)) return `${label} may not hold line breaks or control characters.`;
  return null;
}

const FAIL = Symbol('not-json');

/**
 * A deep copy of a JSON value built only from own data properties (Object.fromEntries creates
 * them, so a `__proto__` key stays a plain key and forges nothing), or FAIL when the value is not
 * JSON: undefined, a function, NaN, a class instance, a cycle, too deep or too wide.
 */
function cloneJson(value: unknown, budget: { nodes: number }, depth = 0): unknown {
  if (budget.nodes-- <= 0 || depth > HEAD_LIMITS.jsonLdDepth) return FAIL;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : FAIL;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const copy = cloneJson(item, budget, depth + 1);
      if (copy === FAIL) return FAIL;
      out.push(copy);
    }
    return out;
  }
  if (!isPlain(value)) return FAIL;
  const entries: Array<[string, unknown]> = [];
  for (const key of Object.keys(value)) {
    const copy = cloneJson(value[key], budget, depth + 1);
    if (copy === FAIL) return FAIL;
    entries.push([key, copy]);
  }
  return Object.fromEntries(entries);
}

/** The stored copy of any item: a plain object with a string `kind`, copied safely, or null. */
export function copyStoredItem(raw: unknown): StoredHeadItem | null {
  if (!isPlain(raw) || typeof own(raw, 'kind') !== 'string') return null;
  const copy = cloneJson(raw, { nodes: HEAD_LIMITS.jsonLdNodes });
  return copy === FAIL ? null : (copy as StoredHeadItem);
}

/** Every readable item of a stored list, copied safely, none dropped for count. */
export function copyStoredItems(raw: unknown): StoredHeadItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const copy = copyStoredItem(entry);
    return copy ? [copy] : [];
  });
}

/** What a write kept of a submitted list. */
export interface StoredHeadWrite {
  items: StoredHeadItem[];
  /** Items past the cap. */
  overCap: number;
  /** Items that were not a plain object with a string `kind`, or not JSON. */
  unreadable: number;
}

/**
 * The list to store: every item copied safely, the later ones dropped over `cap`. Valid or not,
 * an item of the stored shape is kept, so a build that refuses it can still show it as refused.
 */
export function storeHeadItems(raw: unknown, cap: number): StoredHeadWrite {
  if (!Array.isArray(raw)) return { items: [], overCap: 0, unreadable: 0 };
  const items: StoredHeadItem[] = [];
  let overCap = 0;
  let unreadable = 0;
  for (const entry of raw) {
    const copy = copyStoredItem(entry);
    if (!copy) unreadable += 1;
    else if (items.length >= cap) overCap += 1;
    else items.push(copy);
  }
  return { items, overCap, unreadable };
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/**
 * A head address: absolute `https:` with a host, or a path starting with exactly one `/`.
 * Nothing else: no `http`, `mailto`, `tel`, `sms`, `data:`, `//host`, backslash, whitespace or
 * control character (a browser reads `/\host` and `/\t/host` as a host). Not `isSafeAddress`,
 * which is wider and private to the render gate. Another host is allowed, since the allowed
 * rels never request it.
 */
export function isHeadHref(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > HEAD_LIMITS.href) return false;
  if (value !== value.trim() || /[\u0000- \u007f\\]/.test(value)) return false;
  if (value.startsWith('/')) return !value.startsWith('//');
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname !== '' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

const HREFLANG = /^(x-default|[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3})$/;

// ---------------------------------------------------------------------------
// parseHeadItem
// ---------------------------------------------------------------------------

/** Why an item is refused: a stable code and the sentence the panel shows. */
export interface HeadRefusal {
  code: 'shape' | 'kind' | 'owned' | 'not-allowed' | 'value' | 'href' | 'jsonld';
  message: string;
}

export type HeadParse = { ok: true; item: HeadItem } | { ok: false; refusal: HeadRefusal };

const refuse = (code: HeadRefusal['code'], message: string): HeadParse => ({ ok: false, refusal: { code, message } });

/** The keys each kind may hold; a stored item with any other own key is refused, not trimmed. */
const KIND_KEYS: Record<HeadKind, ReadonlySet<string>> = {
  meta: new Set(['kind', 'name', 'content']),
  property: new Set(['kind', 'property', 'content']),
  link: new Set(['kind', 'rel', 'href', 'hreflang', 'type', 'title']),
  jsonld: new Set(['kind', 'data']),
};

function ownedRefusal(name: string): HeadParse | null {
  const owner = OWNED.get(name);
  if (owner) return refuse('owned', `"${name}" is written from ${owner}. Use that field instead.`);
  const route = ROUTE_OWNED.get(name);
  if (route) return refuse('not-allowed', `"${name}" is not allowed: ${route}.`);
  return null;
}

function parseMeta(raw: Record<string, unknown>): HeadParse {
  const name = own(raw, 'name');
  const content = own(raw, 'content');
  if (typeof name !== 'string' || name === '') return refuse('shape', 'A meta tag needs a name.');
  const owned = ownedRefusal(name);
  if (owned) return owned;
  if (!META_NAMES.has(name)) return refuse('not-allowed', `"${name}" is not on the list of meta names a page may add.`);
  const problem = textProblem(content, 'The content', HEAD_LIMITS.content);
  if (problem) return refuse('value', problem);
  return { ok: true, item: { kind: 'meta', name, content: content as string } };
}

function parseProperty(raw: Record<string, unknown>): HeadParse {
  const property = own(raw, 'property');
  const content = own(raw, 'content');
  if (typeof property !== 'string' || property === '') return refuse('shape', 'A property tag needs a property.');
  const owned = ownedRefusal(property);
  if (owned) return owned;
  const allowed =
    PROPERTY_SHAPE.test(property) && (PROPERTY_NAMES.has(property) || PROPERTY_PREFIXES.some((p) => property.startsWith(p)));
  if (!allowed) return refuse('not-allowed', `"${property}" is not on the list of properties a page may add.`);
  const problem = textProblem(content, 'The content', HEAD_LIMITS.content);
  if (problem) return refuse('value', problem);
  return { ok: true, item: { kind: 'property', property, content: content as string } };
}

function parseLink(raw: Record<string, unknown>): HeadParse {
  const rel = own(raw, 'rel');
  const href = own(raw, 'href');
  const hreflang = own(raw, 'hreflang');
  const type = own(raw, 'type');
  const title = own(raw, 'title');
  const allowedRel = LINK_RELS.find((r) => r === rel);
  if (!allowedRel) return refuse('not-allowed', `A link of rel ${JSON.stringify(typeof rel === 'string' ? rel : '')} is not allowed.`);
  if (!isHeadHref(href)) return refuse('href', 'The address must be a full https address or a path starting with one "/".');
  if (title !== undefined) {
    const problem = textProblem(title, 'The title', HEAD_LIMITS.content);
    if (problem) return refuse('value', problem);
  }
  if (allowedRel !== 'alternate') {
    if (hreflang !== undefined || type !== undefined) return refuse('shape', `A link of rel "${allowedRel}" has no language or type.`);
    return { ok: true, item: { kind: 'link', rel: allowedRel, href, ...(title !== undefined ? { title: title as string } : {}) } };
  }
  const hasLang = hreflang !== undefined;
  const hasType = type !== undefined;
  if (hasLang === hasType) return refuse('shape', 'An alternate link needs exactly one of a language or a feed type.');
  if (hasLang && !(typeof hreflang === 'string' && HREFLANG.test(hreflang))) {
    return refuse('value', 'The language must be a language tag such as "de" or "en-GB", or "x-default".');
  }
  if (hasType && !FEED_TYPES.some((t) => t === type)) {
    return refuse('value', `The type must be one of ${FEED_TYPES.join(', ')}.`);
  }
  return {
    ok: true,
    item: {
      kind: 'link',
      rel: 'alternate',
      href,
      ...(hasLang ? { hreflang: hreflang as string } : {}),
      ...(hasType ? { type: type as string } : {}),
      ...(title !== undefined ? { title: title as string } : {}),
    },
  };
}

/** schema.org as a context: the address with or without a trailing slash, http or https. */
function isSchemaContext(value: unknown): boolean {
  return typeof value === 'string' && /^https?:\/\/schema\.org\/?$/.test(value);
}

/**
 * Whether `data` is acceptable JSON-LD, and the safe copy of it. An object with a string
 * `@context` on schema.org and either an `@type` or an `@graph` array; JSON only, within the
 * depth, width and size caps. Depth and width are checked before anything is serialised.
 */
export function parseJsonLdData(data: unknown): { ok: true; data: Record<string, unknown> } | { ok: false; message: string } {
  if (!isPlain(data)) return { ok: false, message: 'Structured data must be an object.' };
  const copy = cloneJson(data, { nodes: HEAD_LIMITS.jsonLdNodes });
  if (copy === FAIL) {
    return { ok: false, message: `Structured data must be plain JSON, at most ${HEAD_LIMITS.jsonLdDepth} levels deep.` };
  }
  const record = copy as Record<string, unknown>;
  if (!isSchemaContext(own(record, '@context'))) return { ok: false, message: 'The @context must be "https://schema.org".' };
  const type = own(record, '@type');
  const graph = own(record, '@graph');
  const typed = (typeof type === 'string' && type !== '') || (Array.isArray(type) && type.length > 0 && type.every((t) => typeof t === 'string' && t !== ''));
  const graphed = Array.isArray(graph) && graph.length > 0;
  if (!typed && !graphed) return { ok: false, message: 'Structured data needs an @type or an @graph list.' };
  if (new TextEncoder().encode(JSON.stringify(record)).length > HEAD_LIMITS.jsonLdBytes) {
    return { ok: false, message: `Structured data is larger than ${HEAD_LIMITS.jsonLdBytes / 1024} kilobytes.` };
  }
  return { ok: true, data: record };
}

/**
 * The panel's JSON-LD box: text typed by a person. A top-level array is split into one item per
 * element, an object is one item. Nothing is stored that does not parse and pass.
 */
export function parseJsonLdInput(text: string): { ok: true; items: Array<Record<string, unknown>> } | { ok: false; message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, message: `Not valid JSON: ${error instanceof Error ? error.message : 'unreadable'}.` };
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  if (list.length === 0) return { ok: false, message: 'Structured data is empty.' };
  const items: Array<Record<string, unknown>> = [];
  for (const [index, entry] of list.entries()) {
    const result = parseJsonLdData(entry);
    if (!result.ok) return { ok: false, message: list.length > 1 ? `Item ${index + 1}: ${result.message}` : result.message };
    items.push(result.data);
  }
  return { ok: true, items };
}

function parseJsonLd(raw: Record<string, unknown>): HeadParse {
  const result = parseJsonLdData(own(raw, 'data'));
  return result.ok ? { ok: true, item: { kind: 'jsonld', data: result.data } } : refuse('jsonld', result.message);
}

/**
 * The single entry for a stored item, run at emission and again in the panel. It never throws
 * and returns a FRESH item built from the kind's own keys, so nothing a stored item carries
 * beyond them (a forged prototype included) reaches a caller.
 */
export function parseHeadItem(raw: unknown): HeadParse {
  if (!isPlain(raw)) return refuse('shape', 'A head item must be a plain object.');
  const kind = own(raw, 'kind');
  const known = HEAD_KINDS.find((k) => k === kind);
  if (!known) return refuse('kind', `"${typeof kind === 'string' ? kind : ''}" is not a kind of head item.`);
  const stray = Object.keys(raw).find((key) => !KIND_KEYS[known].has(key));
  if (stray !== undefined) return refuse('shape', `A ${known} item cannot hold "${stray}".`);
  switch (known) {
    case 'meta':
      return parseMeta(raw);
    case 'property':
      return parseProperty(raw);
    case 'link':
      return parseLink(raw);
    case 'jsonld':
      return parseJsonLd(raw);
  }
}

// ---------------------------------------------------------------------------
// Changing an item
// ---------------------------------------------------------------------------

/**
 * The stored item after the panel switches its kind: a new item of that kind built from fixed
 * keys, carrying over only what the two kinds share (`content`, between meta and property), so a
 * field the new kind cannot hold is gone and not merely hidden.
 */
export function changeHeadKind(raw: unknown, kind: HeadKind): StoredHeadItem {
  const old = isPlain(raw) ? raw : {};
  const content = typeof own(old, 'content') === 'string' ? (own(old, 'content') as string) : '';
  switch (kind) {
    case 'meta':
      return { kind, name: '', content };
    case 'property':
      return { kind, property: '', content };
    case 'link':
      return { kind, rel: 'alternate', href: '' };
    case 'jsonld':
      return { kind, data: {} };
  }
}

// ---------------------------------------------------------------------------
// The merge
// ---------------------------------------------------------------------------

/**
 * The key under which an item replaces another: `name`, `property`, or `rel` with `hreflang`
 * and `type`. JSON-LD has no key, so both emit.
 */
export function headItemKey(item: HeadItem): string | null {
  switch (item.kind) {
    case 'meta':
      return `meta:${item.name}`;
    case 'property':
      return `property:${item.property}`;
    case 'link':
      return `link:${item.rel}|${item.hreflang ?? ''}|${item.type ?? ''}`;
    case 'jsonld':
      return null;
  }
}

const isRepeatable = (key: string): boolean => REPEATABLE_KEYS.has(key);

/** Two parsed items that say the same thing: same key and same values. */
function sameItem(a: HeadItem, b: HeadItem): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export type HeadHome = 'site' | 'page';

/** One thing the check reports: which home and position, and why. */
export interface HeadProblem {
  home: HeadHome;
  /** The item's index in its home's stored list. */
  index: number;
  reason: 'refused' | 'over-cap' | 'duplicate' | 'over-jsonld-cap';
  message: string;
}

export interface HeadResolution {
  /** What to emit, in order: the site's items that survive, then the page's. */
  items: HeadItem[];
  /** Everything left out, for the check before publishing and the panel. */
  problems: HeadProblem[];
}

interface Candidate {
  home: HeadHome;
  index: number;
  item: HeadItem;
}

/** Parse one home: caps by stored position, refuses by reason, drops a repeated single key (the first wins). */
function resolveHome(home: HeadHome, stored: unknown, cap: number, problems: HeadProblem[]): Candidate[] {
  const list = Array.isArray(stored) ? stored : [];
  const out: Candidate[] = [];
  const seen = new Map<string, HeadItem[]>();
  list.forEach((entry, index) => {
    if (index >= cap) {
      problems.push({ home, index, reason: 'over-cap', message: `Only the first ${cap} head items of the ${home} are used.` });
      return;
    }
    const parsed = parseHeadItem(entry);
    if (!parsed.ok) {
      problems.push({ home, index, reason: 'refused', message: parsed.refusal.message });
      return;
    }
    const key = headItemKey(parsed.item);
    if (key !== null) {
      const earlier = seen.get(key) ?? [];
      if (isRepeatable(key) ? earlier.some((e) => sameItem(e, parsed.item)) : earlier.length > 0) {
        problems.push({ home, index, reason: 'duplicate', message: 'An earlier item already says this.' });
        return;
      }
      seen.set(key, [...earlier, parsed.item]);
    }
    out.push({ home, index, item: parsed.item });
  });
  return out;
}

/**
 * The items a rendered page carries, from the site's list and the page's own, both as stored.
 *
 * Order: each list is capped by stored position (30 on a page, 20 on a site), every item is
 * parsed and a refused one leaves no trace in the output (so a refused page item never displaces
 * a valid site item), a repeated single key keeps its first, a page item replaces the site items
 * with the same key (repeatable keys keep both and drop an exact duplicate), and finally JSON-LD
 * is held to 3 on the page, the page's first. Pure and total: it never throws.
 */
export function resolveHead(siteStored: unknown, pageStored: unknown): HeadResolution {
  const problems: HeadProblem[] = [];
  const site = resolveHome('site', siteStored, HEAD_LIMITS.siteItems, problems);
  const page = resolveHome('page', pageStored, HEAD_LIMITS.pageItems, problems);

  const pageKeys = new Set<string>();
  for (const { item } of page) {
    const key = headItemKey(item);
    if (key !== null && !isRepeatable(key)) pageKeys.add(key);
  }
  const keptSite: Candidate[] = [];
  for (const candidate of site) {
    const key = headItemKey(candidate.item);
    if (key !== null && pageKeys.has(key)) continue;
    if (key !== null && isRepeatable(key) && page.some((p) => sameItem(p.item, candidate.item))) {
      problems.push({ home: 'site', index: candidate.index, reason: 'duplicate', message: 'The page already carries the same item.' });
      continue;
    }
    keptSite.push(candidate);
  }

  // JSON-LD: the page's first, then the site's, three in all.
  let jsonLd = 0;
  const dropped = new Set<Candidate>();
  for (const candidate of [...page, ...keptSite]) {
    if (candidate.item.kind !== 'jsonld') continue;
    jsonLd += 1;
    if (jsonLd > HEAD_LIMITS.jsonLdPerPage) {
      dropped.add(candidate);
      problems.push({
        home: candidate.home,
        index: candidate.index,
        reason: 'over-jsonld-cap',
        message: `A page carries at most ${HEAD_LIMITS.jsonLdPerPage} structured data items, site and page together.`,
      });
    }
  }
  const items = [...keptSite, ...page].filter((c) => !dropped.has(c)).map((c) => c.item);
  return { items, problems };
}

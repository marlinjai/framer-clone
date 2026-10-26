// src/lib/pages/slug.ts
//
// The ONE set of page URL slug rules, shared by the editor (the page settings
// panel and ProjectModel's actions) and the server save path
// (SiteRepository.saveProject, behind POST /api/projects/save and /publish).
// Pure and dependency-free so it runs in the browser, in Node and in tests.
//
// A slug is the path a page is served at on the published site, without the
// leading slash: `about`, `blog/first-post`. The rules:
//   - each segment is lowercase a to z, 0 to 9 and single hyphens, with no
//     leading or trailing hyphen;
//   - segments are joined by `/` (nested paths: the published router,
//     src/server/sites/publicResolver.ts, matches multi-segment slugs);
//   - 1 to SLUG_MAX_LENGTH characters in total;
//   - the first segment must not be a reserved path (RESERVED_SLUG_SEGMENTS);
//   - unique within the project, compared case-insensitively;
//   - the HOME page has the empty slug `''` and it never changes (the router
//     serves it at `/`).
//
// Dynamic segments (`:handle`, `[handle]`) are understood by the router but are
// NOT authorable here: an existing page that already carries one keeps it (the
// server grandfathers unchanged slugs), and `slugKey` treats any two dynamic
// segments at the same position as the same path for the uniqueness check.

/** The longest slug accepted, including any `/` between segments. */
export const SLUG_MAX_LENGTH = 80;

/**
 * First segments a page may not use, because the published site's routing or
 * Next.js itself owns them on every host:
 *   - `api`, `projects`, `preview`: top-level routes in src/app (the editor
 *     plane is refused with a 404 on a published host, src/middleware.ts);
 *   - `_next`, `static`: Next.js build assets;
 *   - `images`: the one folder under public/ (static files win over pages);
 *   - `__home`: the sentinel the middleware rewrites a published `/` to
 *     (src/server/sites/homeSentinel.ts);
 *   - `home`, `index`: the router treats them as aliases of the home page;
 *   - `favicon`, `robots`, `sitemap`: the well-known files crawlers and
 *     browsers request (`favicon.ico`, `robots.txt`, `sitemap.xml`).
 * The dotted file names themselves can never be a slug (a dot is not an
 * allowed character); the bare words are reserved so a page cannot shadow or
 * be confused with them.
 */
export const RESERVED_SLUG_SEGMENTS: readonly string[] = [
  'api',
  'projects',
  'preview',
  '_next',
  'static',
  'images',
  '__home',
  'home',
  'index',
  'favicon',
  'robots',
  'sitemap',
  'favicon.ico',
  'robots.txt',
  'sitemap.xml',
];

const SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The product page's dynamic segment: the product handle the product detail resolves (`{{page.params.handle}}`). */
export const PRODUCT_PARAM_SEGMENT = ':handle';

export type SlugErrorCode =
  | 'empty'
  | 'too_long'
  | 'leading_or_trailing_slash'
  | 'empty_segment'
  | 'uppercase'
  | 'invalid_characters'
  | 'edge_hyphen'
  | 'double_hyphen'
  | 'reserved'
  | 'taken'
  | 'home_locked';

export type SlugValidation =
  | { ok: true }
  | { ok: false; code: SlugErrorCode; message: string };

/** One page as the uniqueness check sees it. */
export interface SlugPeer {
  id: string;
  slug: string;
}

export interface ValidateSlugContext {
  /** The page being edited; its own current slug never counts as taken. */
  pageId?: string;
  /** Every page of the project (the edited page may be included). */
  pages?: Iterable<SlugPeer>;
}

/** True for a router dynamic segment (`:name` or `[name]`). */
export function isDynamicSegment(segment: string): boolean {
  return segment.startsWith(':') || (segment.startsWith('[') && segment.endsWith(']'));
}

/**
 * The comparison key of a slug: lowercased, split on `/`, empty segments
 * dropped, and every dynamic segment collapsed to `:`. Two slugs with the same
 * key are served at the same path, so they collide.
 */
export function slugKey(slug: string): string {
  return slug
    .toLowerCase()
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => (isDynamicSegment(s) ? ':' : s))
    .join('/');
}

/** True when the slug's first segment is reserved. */
export function isReservedSlug(slug: string): boolean {
  const first = slug.toLowerCase().split('/')[0] ?? '';
  return RESERVED_SLUG_SEGMENTS.includes(first);
}

function fail(code: SlugErrorCode, message: string): SlugValidation {
  return { ok: false, code, message };
}

/**
 * Check a slug's FORMAT only (no uniqueness): the shape every new or changed
 * non-home slug must have. Returns the first rule it breaks.
 */
export function validateSlugFormat(slug: string): SlugValidation {
  if (slug.length === 0) return fail('empty', 'Enter a URL slug.');
  if (slug.length > SLUG_MAX_LENGTH) {
    return fail('too_long', `Keep the slug to ${SLUG_MAX_LENGTH} characters or fewer (it has ${slug.length}).`);
  }
  if (slug.startsWith('/') || slug.endsWith('/')) {
    return fail('leading_or_trailing_slash', 'A slug cannot start or end with a slash.');
  }
  const segments = slug.split('/');
  for (const [index, segment] of segments.entries()) {
    if (segment.length === 0) {
      return fail('empty_segment', 'Use a single slash between the parts of a nested path.');
    }
    if (SEGMENT.test(segment)) continue;
    // A product page: the one dynamic segment a page may author, `:handle` as the last part after a
    // fixed one (`products/:handle`), the parameter the product detail reads. Any other dynamic
    // segment is matched by the router when an older page has it, but cannot be authored.
    if (segment === PRODUCT_PARAM_SEGMENT && index > 0 && index === segments.length - 1) continue;
    if (isDynamicSegment(segment)) {
      return fail(
        'invalid_characters',
        'Only a product page may have a placeholder: ":handle" as the last part after a fixed one, like "products/:handle".',
      );
    }
    if (/[A-Z]/.test(segment) && SEGMENT.test(segment.toLowerCase())) {
      return fail('uppercase', 'Use lowercase letters only.');
    }
    if (/[^a-z0-9-]/.test(segment)) {
      return fail('invalid_characters', 'Use only lowercase letters a to z, digits 0 to 9 and hyphens.');
    }
    if (segment.startsWith('-') || segment.endsWith('-')) {
      return fail('edge_hyphen', 'A slug cannot start or end with a hyphen.');
    }
    return fail('double_hyphen', 'Use single hyphens between words.');
  }
  if (isReservedSlug(slug)) {
    return fail('reserved', `"/${segments[0]}" is reserved by the site itself. Choose a different slug.`);
  }
  return { ok: true };
}

/**
 * Full check for a new or changed non-home slug: format, then uniqueness
 * against the other pages of the project (case-insensitive, nested-aware).
 */
export function validateSlug(slug: string, ctx: ValidateSlugContext = {}): SlugValidation {
  const format = validateSlugFormat(slug);
  if (!format.ok) return format;
  const key = slugKey(slug);
  for (const peer of ctx.pages ?? []) {
    if (ctx.pageId !== undefined && peer.id === ctx.pageId) continue;
    if (peer.slug !== '' && slugKey(peer.slug) === key) {
      return fail('taken', `Another page already uses "/${slug}".`);
    }
  }
  return { ok: true };
}

/** German umlauts and other letters NFKD cannot decompose into ASCII. */
const TRANSLITERATIONS: Record<string, string> = {
  ä: 'ae',
  ö: 'oe',
  ü: 'ue',
  Ä: 'Ae',
  Ö: 'Oe',
  Ü: 'Ue',
  ß: 'ss',
  ẞ: 'SS',
  æ: 'ae',
  Æ: 'Ae',
  œ: 'oe',
  Œ: 'Oe',
  ø: 'o',
  Ø: 'O',
  ł: 'l',
  Ł: 'L',
  đ: 'd',
  Đ: 'D',
  þ: 'th',
  Þ: 'Th',
};

/**
 * Transliterate to ASCII: umlauts to `ae`/`oe`/`ue`, `ß` to `ss`, then every
 * other accented letter to its base letter (`é` to `e`).
 */
export function transliterate(input: string): string {
  let out = '';
  for (const ch of input) out += TRANSLITERATIONS[ch] ?? ch;
  return out.normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

/** Trim a hyphenated slug to `max` characters without leaving an edge hyphen. */
function truncate(slug: string, max: number): string {
  return slug.length <= max ? slug : slug.slice(0, max).replace(/-+$/, '');
}

/**
 * Suggest a valid, unused slug from a page name: transliterated, lowercased,
 * every run of other characters turned into one hyphen, capped at
 * SLUG_MAX_LENGTH. A name with nothing usable becomes `page`; a reserved word
 * gets `-page` appended (`API` becomes `api-page`); a taken slug gets the
 * first free `-2`, `-3`, ... suffix. `taken` is compared by slugKey.
 */
export function suggestSlug(name: string, taken: Iterable<string> = []): string {
  const takenKeys = new Set<string>();
  for (const t of taken) if (t !== '') takenKeys.add(slugKey(t));

  let base = transliterate(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  base = truncate(base, SLUG_MAX_LENGTH);
  if (!base) base = 'page';
  if (isReservedSlug(base)) base = truncate(base, SLUG_MAX_LENGTH - '-page'.length) + '-page';

  if (!takenKeys.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = truncate(base, SLUG_MAX_LENGTH - suffix.length) + suffix;
    if (!takenKeys.has(candidate)) return candidate;
  }
}

/**
 * Light clean-up of what a person typed into a slug field, applied before
 * validation: surrounding whitespace and slashes go (people paste `/about/`),
 * letters are lowercased and spaces become hyphens. Everything else is left
 * for the validator to explain rather than silently rewritten.
 */
export function tidySlugInput(raw: string): string {
  return raw.trim().replace(/^\/+|\/+$/g, '').toLowerCase().replace(/\s+/g, '-');
}

/**
 * Validate every page slug of a project snapshot before it is persisted (the
 * server save path). `stored` maps pageId to the slug the database holds for
 * that page today. Rules:
 *   - a slug identical to the stored one for the same page is accepted as is
 *     (grandfathered: older pages may predate these rules, and refusing them
 *     would make an existing project impossible to save);
 *   - the site root always serves a page: while the stored project has a home
 *     page (empty slug), the snapshot must still have one. Either a stored home
 *     page keeps the empty slug (and then no other page may take it), or the
 *     home page CHANGED: exactly one other page now holds the empty slug and
 *     every former home page is gone or at a new, valid slug (the editor's
 *     "Set as home page", ProjectModel.setHomePage). A save with no page at the
 *     root is refused, so the home page can never just be deleted or moved
 *     away. Older projects that ended up with two empty-slug pages keep saving,
 *     and may move or delete the extra one;
 *   - a project WITHOUT a home page (possible for older projects, whose home
 *     page could be deleted) may give exactly one page the empty slug: that is
 *     how the editor's "Set as home page" recovers the site root;
 *   - every other new or changed slug must pass validateSlugFormat and be
 *     unique among all pages of the snapshot.
 * Returns the first problem found, naming the page, or null when all is well.
 */
export function findProjectSlugProblem(
  pages: ReadonlyArray<{ pageId: string; slug: string; title?: string }>,
  stored: ReadonlyMap<string, string>,
): { pageId: string; code: SlugErrorCode; message: string } | null {
  const label = (p: { pageId: string; title?: string }) => (p.title ? `"${p.title}"` : p.pageId);

  const storedHomeIds = new Set([...stored].filter(([, slug]) => slug === '').map(([id]) => id));
  const incomingHomes = pages.filter((p) => p.slug === '');
  const keptHomes = incomingHomes.filter((p) => storedHomeIds.has(p.pageId));

  if (storedHomeIds.size > 0) {
    if (incomingHomes.length === 0) {
      // Nothing would be served at the root: the home page was deleted or
      // moved away without another page taking its place.
      const [homeId] = storedHomeIds;
      const moved = pages.find((p) => p.pageId === homeId);
      return {
        pageId: homeId,
        code: 'home_locked',
        message: moved
          ? `Page ${label(moved)} is the home page; its URL is the site root. Make another page the home page first.`
          : 'The home page cannot be deleted: it is what the site serves at its root. Make another page the home page first.',
      };
    }
    if (keptHomes.length > 0) {
      // The home page stays; no other page may join it at the root.
      const newHome = incomingHomes.find((p) => !storedHomeIds.has(p.pageId));
      if (newHome) {
        return {
          pageId: newHome.pageId,
          code: 'taken',
          message: `Page ${label(newHome)} has an empty slug, but only the home page may.`,
        };
      }
    } else if (incomingHomes.length > 1) {
      // The home page changed, but to exactly one page.
      const second = incomingHomes[1];
      return {
        pageId: second.pageId,
        code: 'taken',
        message: `Page ${label(second)} has an empty slug, but only the home page may.`,
      };
    }
  } else if (incomingHomes.length > 1) {
    const second = incomingHomes[1];
    return {
      pageId: second.pageId,
      code: 'taken',
      message: `Page ${label(second)} has an empty slug, but only the home page may.`,
    };
  }

  for (const page of pages) {
    const before = stored.get(page.pageId);
    if (before === page.slug) continue;
    // Empty slugs were settled above (a kept or recovered home page). An extra
    // legacy home page moving to a real slug is validated like any other.
    if (page.slug === '') continue;
    const result = validateSlug(page.slug, {
      pageId: page.pageId,
      pages: pages.map((p) => ({ id: p.pageId, slug: p.slug })),
    });
    if (!result.ok) {
      return { pageId: page.pageId, code: result.code, message: `Page ${label(page)}: ${result.message}` };
    }
  }
  return null;
}

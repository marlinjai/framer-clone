// src/lib/projects/demoAddress.ts
//
// Where the browser-only demo editor lives (docs/plans/2026-11-23-sites-home-and-light-mode.md,
// section 2). `/` is the home: signed in it leads to the projects, signed out it shows the welcome
// page. The demo stays at `/` and is chosen by the address, because a new `/demo` route would
// shadow a published site's own page of that name (see RESERVED_SLUG_SEGMENTS in src/lib/pages/slug.ts).

/** The demo editor's address. */
export const DEMO_PATH = '/?demo=1';

/** The demo editor on one of its pages (Preview's way back). */
export function demoPageHref(pageId: string): string {
  return `${DEMO_PATH}&page=${encodeURIComponent(pageId)}`;
}

type Query = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * True when a request for `/` asks for the demo editor: `?demo=1`, or the demo's own
 * `?page=` and `?preview=1`, which links and bookmarks from before the home carried.
 */
export function wantsDemo(query: Query): boolean {
  return first(query.demo) === '1' || first(query.page) !== undefined || first(query.preview) === '1';
}

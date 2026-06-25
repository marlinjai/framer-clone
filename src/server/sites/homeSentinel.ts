/**
 * The reserved sentinel slug the middleware rewrites a published-site root (`/`)
 * to. The required catch-all `(site)/[...slug]` route never matches bare `/`, so
 * the middleware rewrites a non-editor-host `/` to `/<sentinel>` and the public
 * resolver treats that single segment as the HOME request.
 *
 * This lives in its own dependency-free module ON PURPOSE: the middleware runs in
 * the edge runtime and CANNOT import `publicResolver` (it pulls `server-only` +
 * Prisma). Both the edge middleware and the server resolver import the sentinel
 * from here, so the rewrite target and the matcher can never drift, and the edge
 * bundle stays lean. A real published page can never legitimately use this as a
 * slug (it is reserved).
 */
export const HOME_REWRITE_SENTINEL = '__home';

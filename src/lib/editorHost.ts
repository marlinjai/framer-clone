// src/lib/editorHost.ts
//
// THE editor-host test, shared by the edge middleware and the server routes
// that must only ever answer on the editor plane. Dependency-free on purpose:
// the middleware runs in the edge runtime and cannot import server-only or
// Prisma modules.
//
// The editor is served on the fixed EDITOR_HOST; every other host is a
// published storefront (the published-site plane, which derives tenancy from
// the host and must never be authorized by the apex `.lumitra.co` session, D2).
// Dev / unconfigured safety: with no EDITOR_HOST, every host counts as the
// editor host, so local development is unchanged (a production start without
// it is refused, assertEditorHostConfigured). localhost and 127.0.0.1 count as
// the editor host too, but ONLY outside production: in production a Host header
// is whatever the client sends, and `Host: localhost` must never turn a
// published origin into the editor. (The container probe hits 127.0.0.1, which
// then counts as a published host; it asks only for /api/health, which every
// host serves.)
//
// SERVER ACTIONS, read before moving one: when a page posts a server action
// that its own server bundle does not contain, Next forwards the request to
// the worker that has it, over fetch to __NEXT_PRIVATE_ORIGIN. Node 22's fetch
// ignores the caller's Host header, so that forwarded hop arrives as
// `Host: localhost:<port>`, which in production is a published host, and the
// middleware refuses every server action there (404). This fails closed on
// purpose and must stay so: keep each server action imported by the pages
// that call it (directly, or through a module those pages import), so Next
// never has to forward it. src/__tests__/middleware.test.ts pins the 404.

/** Normalize a Host header value: drop the port, lowercase. */
function hostnameOf(host: string | null | undefined): string {
  return (host ?? '').split(':')[0].trim().toLowerCase();
}

/**
 * True when `host` is the editor host (see the file header for the dev rules).
 * `editorHost` defaults to `process.env.EDITOR_HOST`, `nodeEnv` to
 * `process.env.NODE_ENV`.
 */
export function isEditorHost(
  host: string | null | undefined,
  editorHost: string | null | undefined = process.env.EDITOR_HOST,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): boolean {
  const hostname = hostnameOf(host);
  if (!editorHost || hostname === editorHost.toLowerCase()) return true;
  return nodeEnv !== 'production' && (hostname === 'localhost' || hostname === '127.0.0.1');
}

/** Why a production start is refused: the message names the fix. */
export const EDITOR_HOST_MISSING_MESSAGE =
  'EDITOR_HOST is not set (or is blank) while NODE_ENV=production. Refusing to start: ' +
  'every host would be treated as a published site, the editor included. Set ' +
  'EDITOR_HOST to the editor hostname (app.lumitra.co in production), see deploy/README.md.';

/**
 * Throw when a PRODUCTION server would start without an editor host. A blank
 * value counts as missing on purpose: `isEditorHost` would then match no real
 * host, so the editor itself would be served as a published site. Outside
 * production (dev, tests) an unset EDITOR_HOST stays allowed and makes every
 * host the editor host.
 */
export function assertEditorHostConfigured(
  env: { NODE_ENV?: string; EDITOR_HOST?: string } = process.env,
): void {
  if (env.NODE_ENV !== 'production') return;
  if (!env.EDITOR_HOST || env.EDITOR_HOST.trim().length === 0) {
    throw new Error(EDITOR_HOST_MISSING_MESSAGE);
  }
}


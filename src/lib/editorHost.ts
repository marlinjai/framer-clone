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
// Dev / unconfigured safety: with no EDITOR_HOST, or on localhost / 127.0.0.1,
// EVERY host counts as the editor host, so local development is unchanged.

/** Normalize a Host header value: drop the port, lowercase. */
function hostnameOf(host: string | null | undefined): string {
  return (host ?? '').split(':')[0].trim().toLowerCase();
}

/**
 * True when `host` is the editor host (see the file header for the dev rules).
 * `editorHost` defaults to `process.env.EDITOR_HOST`.
 */
export function isEditorHost(
  host: string | null | undefined,
  editorHost: string | null | undefined = process.env.EDITOR_HOST,
): boolean {
  const hostname = hostnameOf(host);
  return (
    !editorHost ||
    hostname === editorHost.toLowerCase() ||
    hostname === 'localhost' ||
    hostname === '127.0.0.1'
  );
}

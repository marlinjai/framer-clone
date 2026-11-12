// src/lib/scene/modelFile.ts
//
// The address and the headers of a stored model, the counterpart of src/lib/site/siteImages.ts:
// GET /site-models/<sha256>.glb on a site's own hosts, content-addressed, immutable, with the
// hash as entity tag. Pure.

const FILE = /^([0-9a-f]{64})\.glb$/;

export const MODEL_CONTENT_TYPE = 'model/gltf-binary';

/** The hash named by `<sha256>.glb`, or null for anything else (another extension, upper case, a path). */
export function parseSiteModelFile(file: string): { sha256: string } | null {
  const m = FILE.exec(file);
  return m ? { sha256: m[1] } : null;
}

export type ModelVisibility = 'public' | 'private';

/**
 * The response headers of a served model. Public and immutable for a year on a published host;
 * on a preview host (a secret link that ends) it is asked for again every time and kept private.
 * `nosniff`, a policy that lets nothing load or run, and same-origin only.
 */
export function siteModelHeaders(sha256: string, visibility: ModelVisibility = 'public'): Record<string, string> {
  return {
    'content-type': MODEL_CONTENT_TYPE,
    etag: `"${sha256}"`,
    'cache-control': visibility === 'public' ? 'public, max-age=31536000, immutable' : 'private, no-cache',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    'cross-origin-resource-policy': 'same-origin',
  };
}

/** Whether an `If-None-Match` header names this hash (a list, weak tags and `*` included). */
export function matchesModelEtag(header: string | null, sha256: string): boolean {
  if (!header) return false;
  if (header.trim() === '*') return true;
  return header.split(',').some((tag) => tag.trim().replace(/^W\//, '') === `"${sha256}"`);
}

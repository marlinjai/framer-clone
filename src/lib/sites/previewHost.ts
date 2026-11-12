// src/lib/sites/previewHost.ts
//
// The address of a branch's public preview link (site branches, slice S8,
// docs/plans/2026-11-10-site-branches.md, section 7): `preview-<token>.<sites
// base host>`, one label under the wildcard that published sites already use.
// The token is 160 random bits as 32 characters of lowercase base32, so the
// label is a valid DNS label and reads the same in any letter case.
//
// Dependency-free on purpose: the edge middleware imports it. Nothing here
// says whether a link EXISTS; that is a database read on the server
// (src/server/sites/branches/previewLinks.ts). This file only tells a host of
// that shape from every other host, so the middleware can apply the preview
// rules and the published-site resolver can skip such a label without a read.

/** What every preview label starts with. No site is ever given a label that starts so. */
export const PREVIEW_LABEL_PREFIX = 'preview-';

/** 160 bits in base32: 32 characters of `a-z2-7`. */
export const PREVIEW_TOKEN_PATTERN = /^[a-z2-7]{32}$/;

function hostnameOf(host: string | null | undefined): string {
  return (host ?? '').split(':')[0].trim().toLowerCase().replace(/\.$/, '');
}

function baseOf(baseHost: string | null | undefined): string {
  return (baseHost ?? '').trim().toLowerCase().replace(/\.$/, '');
}

/** True for a label kept for preview links, whatever follows the prefix. Case-insensitive. */
export function isPreviewLabel(label: string): boolean {
  return label.toLowerCase().startsWith(PREVIEW_LABEL_PREFIX);
}

/**
 * The token a host carries when it has the exact shape of a preview address:
 * one label directly under the sites base host, `preview-` and 32 base32
 * characters. Null for everything else: another base, a custom domain, a
 * deeper name, a token of the wrong length or alphabet, and every host while
 * no sites base host is configured.
 */
export function previewTokenOfHost(
  host: string | null | undefined,
  baseHost: string | null | undefined = process.env.PUBLIC_SITE_BASE_HOST,
): string | null {
  const base = baseOf(baseHost);
  const hostname = hostnameOf(host);
  if (!base || !hostname.endsWith(`.${base}`)) return null;
  const label = hostname.slice(0, -(base.length + 1));
  if (label.includes('.') || !label.startsWith(PREVIEW_LABEL_PREFIX)) return null;
  const token = label.slice(PREVIEW_LABEL_PREFIX.length);
  return PREVIEW_TOKEN_PATTERN.test(token) ? token : null;
}

/**
 * True for any host whose first label is kept for preview links under the
 * sites base host, well-formed token or not. Such a host is never a published
 * site: the middleware gives it the preview rules (GET only, never indexed,
 * never stored) even when the token is malformed, and the page then answers 404.
 */
export function isPreviewHost(
  host: string | null | undefined,
  baseHost: string | null | undefined = process.env.PUBLIC_SITE_BASE_HOST,
): boolean {
  const base = baseOf(baseHost);
  const hostname = hostnameOf(host);
  if (!base || !hostname.endsWith(`.${base}`)) return false;
  return isPreviewLabel(hostname.slice(0, -(base.length + 1)));
}

/** The preview address of a token, without a scheme. Null while no sites base host is configured. */
export function previewHostOf(token: string, baseHost: string | null | undefined = process.env.PUBLIC_SITE_BASE_HOST): string | null {
  const base = baseOf(baseHost);
  return base ? `${PREVIEW_LABEL_PREFIX}${token}.${base}` : null;
}

/**
 * What a rendered site is a preview of. Present on the site object only when
 * the request came in on a preview host: the renderer shows the band and makes
 * forms and checkout inert by it, and the metadata is never indexed.
 */
export interface PreviewOf {
  branchId: string;
  branchName: string;
  /** ISO time the link stops working. */
  expiresAt: string;
}

// src/lib/links/safeHref.ts
//
// The one rule for where a link on a published page may point: a page of
// the site, an in-page anchor, http(s), mailto or tel. Used wherever a link
// target comes from the owner or from data: the sticky call to action, the
// Link component's field, and every bound `href` (a CMS cell bound to a link
// must never become `javascript:`). React does not block such URLs reliably,
// so the check runs before the value reaches the element. A backslash is
// refused anywhere: browsers read it as a slash, so `/\evil.example` would
// leave the site while looking like one of its paths.

/** Allowed link targets: http(s), mailto, tel, an in-page anchor or a site path. */
export function isSafeHref(value: string): boolean {
  const v = value.trim();
  if (v.length === 0 || v.length > 500) return false;
  if (/[\u0000-\u001f\u007f\s<>"\\]/.test(v)) return false;
  if (v.startsWith('#') || (v.startsWith('/') && !v.startsWith('//'))) return true;
  return /^(https?:\/\/|mailto:|tel:)/i.test(v);
}

/**
 * A link target from data, made usable: spaces inside it (a mail subject, a
 * file name) are encoded as %20 the way a browser would, then the target must
 * pass isSafeHref. Null when it cannot be a link.
 */
export function safeHrefFromData(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const encoded = value.trim().replace(/ /g, '%20');
  return isSafeHref(encoded) ? encoded : null;
}

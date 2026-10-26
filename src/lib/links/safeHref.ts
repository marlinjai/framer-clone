// src/lib/links/safeHref.ts
//
// The one rule for where a link on a published page may point: a page of
// the site, an in-page anchor, http(s), mailto or tel. Used wherever a link
// target comes from the owner or from data: the sticky call to action, the
// Link component's field, and every bound `href` (a CMS cell bound to a link
// must never become `javascript:`). React does not block such URLs reliably,
// so the check runs before the value reaches the element.

/** Allowed link targets: http(s), mailto, tel, an in-page anchor or a site path. */
export function isSafeHref(value: string): boolean {
  const v = value.trim();
  if (v.length === 0 || v.length > 500) return false;
  if (/[\u0000-\u001f\u007f\s<>"]/.test(v)) return false;
  if (v.startsWith('#') || (v.startsWith('/') && !v.startsWith('//'))) return true;
  return /^(https?:\/\/|mailto:|tel:)/i.test(v);
}

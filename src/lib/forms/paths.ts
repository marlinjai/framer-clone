// src/lib/forms/paths.ts
//
// The site path of a page, for a form's success target and the "page" column of
// a submission. Client-safe.

import { isDynamicSegment } from '@/lib/pages/slug';

function segmentsOf(slug: string): string[] {
  return slug
    .split('/')
    .map((seg) => seg.trim())
    .filter((seg) => seg.length > 0);
}

/** True when a page can be the target of a link: the home page or a slug without `:param` segments. */
export function isLinkablePageSlug(slug: string): boolean {
  return segmentsOf(slug).every((seg) => !isDynamicSegment(seg) && seg !== '.' && seg !== '..');
}

/**
 * The path a visitor is sent to for this page (`/`, `/danke`, `/a/b`),
 * percent-encoded per segment so a stored slug can never become an off-site
 * address. Null for a dynamic page (no single address to send anyone to).
 */
export function linkPathOfSlug(slug: string): string | null {
  if (!isLinkablePageSlug(slug)) return null;
  const segments = segmentsOf(slug);
  return segments.length === 0 ? '/' : '/' + segments.map((seg) => encodeURIComponent(seg)).join('/');
}

/** The page as the submissions view names it: its path, `:param` segments kept as written. */
export function displayPathOfSlug(slug: string): string {
  const segments = segmentsOf(slug);
  return segments.length === 0 ? '/' : `/${segments.join('/')}`.slice(0, 2000);
}

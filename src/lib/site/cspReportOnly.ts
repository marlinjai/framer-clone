// src/lib/site/cspReportOnly.ts
//
// The report-only Content Security Policy of published pages. It measures what
// an enforced policy would block and blocks nothing: stored rules, images and
// backgrounds can make third-party requests that tell a host what a visitor did
// before consent (docs/plans/2026-11-02-selector-styling.md, open question 1),
// and whether to enforce is an open decision. Dependency-free on purpose: the
// edge middleware sends the header and cannot import server-only or Prisma
// modules.
//
// What it allows is what legitimate pages load today:
//   - the site itself: uploads and catalogue images (/api/catalog/images), the
//     image optimizer (/_next/image), the self-hosted fonts (/fonts);
//   - images.unsplash.com, the only external host the page generator places;
//   - `data:` and `blob:`, which send nothing to any third party.
// The analytics tracker has no entry because it needs none here: it is a script
// import plus fetch and sendBeacon calls, and script-src and connect-src are not
// measured. No default-src for the same reason: it would report every inline
// style and script and bury the third-party hosts this exists to find.
//
// report-uri and not report-to: Chromium ignores report-uri once report-to is
// present, report-to only delivers batched and late, and Firefox and Safari
// still only speak report-uri.

export const CSP_REPORT_ONLY_HEADER = 'content-security-policy-report-only';

/** The same-origin path browsers post violations to, on whichever host served the page. */
export const CSP_REPORT_PATH = '/api/csp-report';

/** Every directive the policy measures, so anything else in a report is junk. */
export const REPORTED_DIRECTIVES = ['img-src', 'font-src', 'media-src'] as const;
export type ReportedDirective = (typeof REPORTED_DIRECTIVES)[number];

export const PUBLISHED_REPORT_ONLY_POLICY = [
  "img-src 'self' data: blob: https://images.unsplash.com",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  `report-uri ${CSP_REPORT_PATH}`,
].join('; ');

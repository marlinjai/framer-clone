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
// Frames are measured too (frame-src). The render gate drops every iframe a node
// stores, so the only frame a published page can hold is a Google Maps embed, which
// its island creates after the visitor consents to maps (src/lib/mapEmbed). Google
// is allowed only on a response to a visitor whose `maps` consent is recorded in the
// cookie MAPS_CONSENT_COOKIE below, which the consent runtime (src/lib/consent)
// sets and clears with the choice: a Google frame anywhere else is exactly what this
// policy exists to find. The page view on which a visitor first says yes still
// counts one report, because its header was sent before the choice; that is the
// price of measuring the case that matters, a map loading before consent.
// The analytics tracker has no entry because it needs none here: it is a script
// import plus fetch and sendBeacon calls, and script-src and connect-src are not
// measured. No default-src for the same reason: it would report every inline
// style and script and bury the third-party hosts this exists to find.
//
// report-uri and not report-to: Chromium ignores report-uri once report-to is
// present, and report-to delivers batched and late, where report-uri posts at once.

export const CSP_REPORT_ONLY_HEADER = 'content-security-policy-report-only';

/**
 * The cookie that says this visitor consented to maps, so Google frames are allowed.
 * The consent runtime writes it (src/lib/consent/consent.ts imports it from here).
 */
export const MAPS_CONSENT_COOKIE = 'lumitra-consent-maps';

/** The same-origin path browsers post violations to, on whichever host served the page. */
export const CSP_REPORT_PATH = '/api/csp-report';

/** Every directive the policy measures, so anything else in a report is junk. */
export const REPORTED_DIRECTIVES = ['img-src', 'font-src', 'media-src', 'frame-src'] as const;
export type ReportedDirective = (typeof REPORTED_DIRECTIVES)[number];

/** The external image hosts the policy allows, over https. */
export const ALLOWED_IMAGE_HOSTS = ['images.unsplash.com'] as const;

/** The frame host allowed after maps consent, over https. */
export const ALLOWED_FRAME_ORIGIN = 'https://www.google.com';

const policy = (frames: string) =>
  [
    `img-src 'self' data: blob: ${ALLOWED_IMAGE_HOSTS.map((host) => `https://${host}`).join(' ')}`,
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    `frame-src ${frames}`,
    `report-uri ${CSP_REPORT_PATH}`,
  ].join('; ');

/** The policy for a visitor without maps consent: any frame reports. */
export const PUBLISHED_REPORT_ONLY_POLICY = policy("'self'");

/** The policy for a visitor who consented to maps: Google Maps frames are expected. */
export const PUBLISHED_REPORT_ONLY_POLICY_MAPS = policy(`'self' ${ALLOWED_FRAME_ORIGIN}`);

/** The policy for one response, by whether its request carries the maps consent cookie. */
export function reportOnlyPolicy(mapsConsented: boolean): string {
  return mapsConsented ? PUBLISHED_REPORT_ONLY_POLICY_MAPS : PUBLISHED_REPORT_ONLY_POLICY;
}

// ---------------------------------------------------------------------------
// The enforced frame policy (decision D6 of docs/plans/2026-11-02-sandboxed-custom-code.md)
// ---------------------------------------------------------------------------
//
// Two directives, enforced, beside the report-only policy above, which stays as it
// is. A published page holds exactly two kinds of frame: the Google map after the
// visitor consents to maps, and a sandboxed custom code block, whose frame is the
// box's (`https://run.<box domain>/box/`). So `frame-src` names those two and
// nothing else, and `object-src 'none'` refuses every `object` and `embed` (no
// published page uses one; WebKit loads them under `frame-src` alone). The browser
// then refuses every other frame or plugin a stored page could sneak past the
// render gate that makes a request. It cannot refuse a frame that makes none: an
// `iframe srcdoc` or an `about:blank` frame runs in the page's own origin whatever
// `frame-src` says, so the render gate refusing `iframe` stays the line that holds.
// Constant per consent state and per server configuration, so the middleware needs
// no database read for it. With no box source (no origin configured, or the kill
// switch on) and no consent it is `frame-src 'none'`. The standalone preview route
// of the editor host sends the same policy (src/middleware.ts), joined to its
// `frame-ancestors 'none'`.

/** The enforced policy's header. */
export const CSP_ENFORCED_HEADER = 'content-security-policy';

/**
 * The enforced policy for one response, `frame-src` then `object-src 'none'`: the box's path when this server
 * may frame it (customCode.ts, boxFrameSource), and Google when the request
 * carries maps consent.
 */
export function enforcedFramePolicy(mapsConsented: boolean, boxSource: string | null): string {
  const sources = [...(boxSource ? [boxSource] : []), ...(mapsConsented ? [ALLOWED_FRAME_ORIGIN] : [])];
  return `frame-src ${sources.length > 0 ? sources.join(' ') : "'none'"}; object-src 'none'`;
}

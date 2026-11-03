// @vitest-environment node
//
// The middleware matcher, compiled exactly as Next compiles it (Next's own
// getMiddlewareMatchers, path-to-regexp with the transport suffixes, and its
// route matcher), checked in both directions against the host route table:
//   - every route a published host must NOT serve is matched, so the allowlist
//     in src/middleware.ts runs before it and answers 404;
//   - every path that falls to the site catch-all `(site)/[...slug]` is
//     matched, so a published host never serves one without the allowlist,
//     the server-action refusal, the cookie filter and the policy;
//   - only the deliberate bypasses (build output, the per-host files and one
//     uploaded site image) are left out.
//
// next.config.ts sets no basePath and no i18n, so the compile uses neither.

import { describe, expect, it } from 'vitest';
import * as pageStaticInfo from 'next/dist/build/analysis/get-page-static-info';
import type { MiddlewareMatcher } from 'next/dist/build/analysis/get-page-static-info';
import { getMiddlewareRouteMatcher } from 'next/dist/shared/lib/router/utils/middleware-route-matcher';
import { config } from '@/middleware';
import { HOST_ROUTES } from '@/lib/hostRoutes';

// The very function `next build` compiles a middleware config with. Next exports
// it from the module but leaves it out of the type declarations.
const { getMiddlewareMatchers } = pageStaticInfo as unknown as {
  getMiddlewareMatchers: (matcher: readonly string[], nextConfig: Record<string, unknown>) => MiddlewareMatcher[];
};

const matchers = getMiddlewareMatchers(config.matcher, {});
const routeMatcher = getMiddlewareRouteMatcher(matchers);
const runsOn = (pathname: string) =>
  routeMatcher(pathname, { headers: {}, cookies: {} } as never, {} as never);

function samplePath(route: string): string {
  return route.replace(/\[\.\.\.[^\]]+\]/g, 'some/page').replace(/\[[^\]]+\]/g, 'x1');
}

/** Routes the middleware never sees, on purpose: each answers per host itself and reads no session. */
const BYPASSED = new Set(['/favicon.ico', '/robots.txt', '/sitemap.xml', '/site.webmanifest', '/site-images/[file]']);

describe('middleware matcher, as Next compiles it', () => {
  it('compiles every entry', () => {
    expect(matchers).toHaveLength(config.matcher.length);
  });

  it.each(HOST_ROUTES.filter((entry) => !entry.published).map((entry) => [entry.route]))(
    'runs on the editor-only route %s',
    (route) => {
      expect(runsOn(samplePath(route))).toBe(true);
    },
  );

  it.each(HOST_ROUTES.filter((entry) => entry.published && !BYPASSED.has(entry.route)).map((entry) => [entry.route]))(
    'runs on the published route %s',
    (route) => {
      expect(runsOn(samplePath(route))).toBe(true);
    },
  );

  it('runs on every path that falls to the site catch-all', () => {
    for (const path of [
      '/about',
      '/images/x',
      '/images/a.png',
      '/fonts/x',
      '/fonts/inter/5/a.woff2',
      '/site-images/a/b',
      '/site-images/',
      '/_nextx',
      '/apitude',
      '/favicon.ico/x',
      '/robots.txt.bak',
      '/preview/x',
      '/projects/p1/other',
    ]) {
      expect(runsOn(path), path).toBe(true);
    }
  });

  it('runs on the RSC transport forms of a page too', () => {
    for (const path of ['/about.rsc', '/', '/index.rsc']) {
      expect(runsOn(path), path).toBe(true);
    }
  });

  it('leaves out only build output, the per-host files and one site image', () => {
    for (const route of BYPASSED) expect(runsOn(samplePath(route)), route).toBe(false);
    for (const path of ['/_next/static/chunk.js', '/_next/image', `/site-images/${'a'.repeat(64)}.png`]) {
      expect(runsOn(path), path).toBe(false);
    }
  });
});

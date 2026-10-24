// src/server/sites/primaryHost.ts
//
// A published site's PRIMARY host: the one address canonical URLs, Open Graph
// URLs, sitemap.xml and robots.txt name, whichever host the request came in on.
//
//   1. the oldest live custom domain (a DNS-verified claim, status `verified`
//      or `active`, oldest activation first: the first domain the owner
//      connected stays primary when they add more);
//   2. else the platform subdomain under PUBLIC_SITE_BASE_HOST;
//   3. else (local development without a base host) the request host.
//
// pickPrimaryHost is pure and also backs SiteRepository.getSiteAddress, the
// address the editor shows, so the editor and the published head never
// disagree. loadSitePrimaryHost reads the domains UNCACHED on purpose: the
// cross-request site cache is keyed per host and is not invalidated for the
// subdomain when a custom domain is claimed or released, so caching the
// primary host there would keep pointing canonicals at a stale address. One
// indexed read per request (deduped by the caller's React cache) keeps it exact.

import type { PrismaClient } from '@prisma/client';

export interface DomainRowForHost {
  subdomain: string | null;
  customHostname: string | null;
  verificationStatus: string;
  activatedAt: Date | null;
  createdAt: Date;
}

export function pickPrimaryHost(
  domains: readonly DomainRowForHost[],
  baseHost: string | null | undefined,
  fallbackHost: string | null = null,
): string | null {
  const custom = domains
    .filter(
      (d) =>
        d.customHostname &&
        (d.verificationStatus === 'verified' || d.verificationStatus === 'active'),
    )
    .sort(
      (a, b) =>
        (a.activatedAt ?? a.createdAt).getTime() - (b.activatedAt ?? b.createdAt).getTime(),
    )[0];
  if (custom?.customHostname) return custom.customHostname;
  const platform = domains.find((d) => d.subdomain);
  const base = baseHost?.trim().toLowerCase().replace(/\.$/, '');
  if (platform?.subdomain && base) return `${platform.subdomain}.${base}`;
  return fallbackHost;
}

/** The primary host of a site, read fresh from its domain rows. */
export async function loadSitePrimaryHost(
  prisma: PrismaClient,
  siteId: string,
  requestHost: string | null,
  baseHost: string | null | undefined = process.env.PUBLIC_SITE_BASE_HOST,
): Promise<string | null> {
  const domains = await prisma.siteDomain.findMany({
    where: { siteId },
    select: {
      subdomain: true,
      customHostname: true,
      verificationStatus: true,
      activatedAt: true,
      createdAt: true,
    },
  });
  return pickPrimaryHost(domains, baseHost, requestHost);
}

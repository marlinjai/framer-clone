import 'server-only';

// src/server/domains/service.ts
//
// Custom domains for a published site (plan
// docs/plans/2026-06-25-framer-custom-domains.md): add, list, verify,
// disconnect, plus the feed of hostnames the proxy must route.
//
// THE LIFECYCLE of one custom-domain row (site_domains, `hostname` set):
//
//   add       -> pending: a fresh random token (32 bytes) is minted for the
//                claim. Adding the same hostname to the same site again returns
//                the same row (same claim, same token). A pending claim never
//                reserves the hostname: `customHostname` (the unique LIVE claim)
//                stays null, so nobody can squat a domain by adding it first.
//   verify    -> TXT ownership + routing checked over DNS (dnsCheck.ts).
//                success: the row takes the live claim (customHostname set,
//                `verified`); if another site held it, that site loses it in
//                the same transaction (the DNS owner proved control just now,
//                so the latest proof wins) and is told why. Then a TLS probe
//                (tlsProbe.ts) moves it to `active` once the certificate is
//                live; until then it stays `verified` with a note.
//                definitive failure: `failed` with the reason; a domain that
//                was serving loses the live claim and stops serving.
//                transient failure (DNS timeout): nothing changes but the note.
//   disconnect-> the row is deleted. Its token dies with it; adding the domain
//                again mints a new one (tokens are never reused, and a unique
//                index on verification_token guarantees it).
//
// Every write invalidates the published-site cache for the hostname, so a
// domain starts or stops serving on the very next request.
//
// AUTHORIZATION is the route's job (src/server/domains/guard.ts): every method
// here takes a site id the caller was already authorized for, and every query
// is scoped by that site id, so a domain of another site can never be read or
// changed through it.

import { randomBytes } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { getPrismaClient } from '@/server/db';
import { revalidateCustomHostCache } from '@/server/sites/cachedResolver';
import type { CustomDomainConfig } from './config';
import { checkDomainDns, createDnsLookup, type DnsLookup } from './dnsCheck';
import {
  hostnameForDisplay,
  isClaimableHostname,
  looksLikeApex,
  normalizeHostnameInput,
  platformZones,
  verificationRecordName,
  verificationRecordValue,
} from './hostname';
import { probeCertificate, type TlsProbe } from './tlsProbe';

/** How many custom domains one site may carry. */
export const MAX_DOMAINS_PER_SITE = 10;

/** The most hostnames the proxy feed returns (a backstop against runaway rows). */
export const MAX_PROXY_HOSTNAMES = 1_000;

export type DomainStatus = 'pending' | 'verified' | 'active' | 'failed';

/** One DNS record the owner must create, exactly as their provider asks for it. */
export interface DnsRecordInstruction {
  type: 'TXT' | 'CNAME' | 'A' | 'AAAA';
  name: string;
  value: string;
  purpose: 'ownership' | 'routing';
  /** For routing records: the one we expect for this hostname (apex or not). */
  recommended: boolean;
  /** Plain-language note, e.g. "for a root domain". */
  note?: string;
}

/** A custom domain as the editor sees it. */
export interface DomainView {
  id: string;
  hostname: string;
  displayHostname: string;
  status: DomainStatus;
  /** True while requests for this hostname serve the site (when published). */
  serving: boolean;
  lastErrorCode: string | null;
  lastError: string | null;
  lastCheckedAt: string | null;
  verifiedAt: string | null;
  activatedAt: string | null;
  records: DnsRecordInstruction[];
}

export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

type DomainRow = {
  id: string;
  siteId: string;
  hostname: string | null;
  customHostname: string | null;
  verificationStatus: string;
  verificationToken: string | null;
  verifiedAt: Date | null;
  activatedAt: Date | null;
  lastCheckedAt: Date | null;
  lastErrorCode: string | null;
  lastError: string | null;
};

const ROW_SELECT = {
  id: true,
  siteId: true,
  hostname: true,
  customHostname: true,
  verificationStatus: true,
  verificationToken: true,
  verifiedAt: true,
  activatedAt: true,
  lastCheckedAt: true,
  lastErrorCode: true,
  lastError: true,
} as const;

/** The DNS records an owner creates for `hostname` (TXT first, then routing). */
export function dnsRecordsFor(
  hostname: string,
  token: string,
  config: CustomDomainConfig,
): DnsRecordInstruction[] {
  const apex = looksLikeApex(hostname);
  const cname: DnsRecordInstruction = {
    type: 'CNAME',
    name: hostname,
    value: config.targetHost,
    purpose: 'routing',
    recommended: !apex,
    note: apex
      ? 'only if your DNS provider supports CNAME (or ALIAS / flattening) on a root domain'
      : undefined,
  };
  const a: DnsRecordInstruction[] = config.ipv4.map((ip) => ({
    type: 'A' as const,
    name: hostname,
    value: ip,
    purpose: 'routing' as const,
    recommended: apex,
    note: apex ? 'for a root domain' : 'instead of the CNAME, if you cannot use one',
  }));
  const aaaa: DnsRecordInstruction[] = apex
    ? config.ipv6.map((ip) => ({
        type: 'AAAA' as const,
        name: hostname,
        value: ip,
        purpose: 'routing' as const,
        recommended: true,
        note: 'optional, for IPv6 visitors',
      }))
    : [];
  return [
    {
      type: 'TXT',
      name: verificationRecordName(hostname),
      value: verificationRecordValue(token),
      purpose: 'ownership',
      recommended: true,
    },
    ...(apex ? [...a, ...aaaa, cname] : [cname, ...a]),
  ];
}

function toStatus(value: string): DomainStatus {
  return value === 'verified' || value === 'active' || value === 'failed' ? value : 'pending';
}

function toView(row: DomainRow, config: CustomDomainConfig | null): DomainView {
  const hostname = row.hostname ?? '';
  const status = toStatus(row.verificationStatus);
  return {
    id: row.id,
    hostname,
    displayHostname: hostnameForDisplay(hostname),
    status,
    serving: row.customHostname === hostname && (status === 'verified' || status === 'active'),
    lastErrorCode: row.lastErrorCode,
    lastError: row.lastError,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    activatedAt: row.activatedAt?.toISOString() ?? null,
    records: config && row.verificationToken ? dnsRecordsFor(hostname, row.verificationToken, config) : [],
  };
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/** A fresh claim token: 32 random bytes, hex. Never derived, never reused. */
export function mintVerificationToken(): string {
  return randomBytes(32).toString('hex');
}

export interface DomainServiceDeps {
  prisma?: PrismaClient;
  dns?: DnsLookup;
  probe?: TlsProbe;
  invalidateHost?: (hostname: string) => void;
  now?: () => Date;
  mintToken?: () => string;
}

export class DomainService {
  private readonly prisma: PrismaClient;
  private readonly invalidateHost: (hostname: string) => void;
  private readonly now: () => Date;
  private readonly mintToken: () => string;

  constructor(private readonly deps: DomainServiceDeps = {}) {
    this.prisma = deps.prisma ?? getPrismaClient();
    this.invalidateHost = deps.invalidateHost ?? revalidateCustomHostCache;
    this.now = deps.now ?? (() => new Date());
    this.mintToken = deps.mintToken ?? mintVerificationToken;
  }

  /** The site's custom domains, oldest first. */
  async listDomains(siteId: string, config: CustomDomainConfig | null): Promise<DomainView[]> {
    const rows = await this.prisma.siteDomain.findMany({
      where: { siteId, hostname: { not: null } },
      orderBy: { createdAt: 'asc' },
      select: ROW_SELECT,
    });
    return rows.map((row) => toView(row, config));
  }

  /**
   * Add a custom domain to a site (pending). Idempotent per site and hostname:
   * the existing claim (same token, same status) is returned unchanged.
   */
  async addDomain(
    site: { id: string; workspaceId: string; tenantGroupId: string },
    rawHostname: unknown,
    config: CustomDomainConfig,
  ): Promise<{ domain: DomainView; created: boolean }> {
    const parsed = normalizeHostnameInput(rawHostname, platformZones());
    if (!parsed.ok) throw new DomainError(parsed.code, parsed.message, 400);
    const { hostname } = parsed;

    const existing = await this.findBySiteAndHostname(site.id, hostname);
    if (existing) return { domain: toView(existing, config), created: false };

    const count = await this.prisma.siteDomain.count({
      where: { siteId: site.id, hostname: { not: null } },
    });
    if (count >= MAX_DOMAINS_PER_SITE) {
      throw new DomainError(
        'domain_limit_reached',
        `A site can have at most ${MAX_DOMAINS_PER_SITE} custom domains. Disconnect one first.`,
        409,
      );
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const row = await this.prisma.siteDomain.create({
          data: {
            siteId: site.id,
            workspaceId: site.workspaceId,
            tenantGroupId: site.tenantGroupId,
            hostname,
            verificationToken: this.mintToken(),
            verificationStatus: 'pending',
            isPrimary: false,
          },
          select: ROW_SELECT,
        });
        return { domain: toView(row, config), created: true };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // A concurrent add of the same hostname to the same site won the race:
        // return its row. Otherwise the token collided (2^-256): mint again.
        const raced = await this.findBySiteAndHostname(site.id, hostname);
        if (raced) return { domain: toView(raced, config), created: false };
      }
    }
    throw new DomainError('domain_add_failed', 'Could not create the domain, try again.', 500);
  }

  /**
   * Check DNS (and the certificate) for one domain of a site and record the
   * outcome. Always returns the updated view; the outcome is in its status and
   * last error.
   */
  async verifyDomain(
    siteId: string,
    domainId: string,
    config: CustomDomainConfig,
  ): Promise<DomainView> {
    const row = await this.findOwned(siteId, domainId);
    const hostname = row.hostname as string;
    const holdsClaim = row.customHostname === hostname;
    const now = this.now();

    // A row without a token predates this feature or was tampered with: it can
    // never prove ownership, so it is a definitive failure, never a pass.
    if (!row.verificationToken) {
      return this.recordFailure(row, holdsClaim, now, config, {
        code: 'token_missing',
        message: 'This domain has no verification token. Disconnect it and add it again.',
      });
    }

    const dns = this.deps.dns ?? createDnsLookup(config);
    const check = await checkDomainDns({
      hostname,
      token: row.verificationToken,
      requireTxt: !holdsClaim,
      config,
      dns,
    });

    if (!check.ok && check.transient) {
      const updated = await this.prisma.siteDomain.update({
        where: { id: row.id },
        data: { lastCheckedAt: now, lastErrorCode: check.code, lastError: check.message },
        select: ROW_SELECT,
      });
      return toView(updated, config);
    }
    if (!check.ok) {
      return this.recordFailure(row, holdsClaim, now, config, check);
    }

    let current: DomainRow = row;
    if (!holdsClaim) {
      current = await this.takeClaim(row, hostname, now);
      this.invalidateHost(hostname);
    }
    return this.probeAndRecord(current, hostname, now, config);
  }

  /** Disconnect (delete) one domain of a site. */
  async removeDomain(siteId: string, domainId: string): Promise<void> {
    const row = await this.findOwned(siteId, domainId);
    const result = await this.prisma.siteDomain.deleteMany({ where: { id: row.id, siteId } });
    if (result.count === 0) throw notFound();
    if (row.hostname) this.invalidateHost(row.hostname);
    if (row.customHostname && row.customHostname !== row.hostname) {
      this.invalidateHost(row.customHostname);
    }
  }

  /**
   * Every hostname the proxy must route: the live claims of verified and
   * active domains, re-checked against the hostname contract, sorted, capped.
   * Unpublished sites keep their routes (and certificates): flapping routes on
   * every publish would spend Let's Encrypt quota for nothing.
   */
  async listProxyHostnames(): Promise<string[]> {
    const rows = await this.prisma.siteDomain.findMany({
      where: {
        customHostname: { not: null },
        verificationStatus: { in: ['verified', 'active'] },
      },
      select: { customHostname: true },
      orderBy: { customHostname: 'asc' },
      take: MAX_PROXY_HOSTNAMES,
    });
    const zones = platformZones();
    const names = new Set<string>();
    for (const row of rows) {
      const name = row.customHostname;
      if (name && isClaimableHostname(name, zones)) names.add(name);
    }
    return [...names].sort();
  }

  // --- internals ------------------------------------------------------------

  private async findBySiteAndHostname(siteId: string, hostname: string): Promise<DomainRow | null> {
    return this.prisma.siteDomain.findUnique({
      where: { siteId_hostname: { siteId, hostname } },
      select: ROW_SELECT,
    });
  }

  private async findOwned(siteId: string, domainId: string): Promise<DomainRow> {
    const row = await this.prisma.siteDomain.findFirst({
      where: { id: domainId, siteId, hostname: { not: null } },
      select: ROW_SELECT,
    });
    if (!row) throw notFound();
    return row;
  }

  /** Take the live claim, releasing it from another site in the same transaction. */
  private async takeClaim(row: DomainRow, hostname: string, now: Date): Promise<DomainRow> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.siteDomain.updateMany({
          where: { customHostname: hostname, id: { not: row.id } },
          data: {
            customHostname: null,
            verificationStatus: 'failed',
            activatedAt: null,
            lastCheckedAt: now,
            lastErrorCode: 'claimed_elsewhere',
            lastError:
              'The owner of this domain verified it for another site, so it no longer serves this one. Verify it again here to move it back.',
          },
        });
        return tx.siteDomain.update({
          where: { id: row.id },
          data: {
            customHostname: hostname,
            verificationStatus: 'verified',
            verifiedAt: now,
            activatedAt: null,
            lastCheckedAt: now,
            lastErrorCode: null,
            lastError: null,
          },
          select: ROW_SELECT,
        });
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new DomainError(
          'verify_conflict',
          'This domain was verified somewhere else at the same moment. Try again.',
          409,
        );
      }
      throw err;
    }
  }

  /** After DNS passed: probe the certificate and record verified or active. */
  private async probeAndRecord(
    row: DomainRow,
    hostname: string,
    now: Date,
    config: CustomDomainConfig,
  ): Promise<DomainView> {
    if (!config.tlsProbe) {
      const updated = await this.prisma.siteDomain.update({
        where: { id: row.id },
        data: { lastCheckedAt: now, lastErrorCode: null, lastError: null },
        select: ROW_SELECT,
      });
      return toView(updated, config);
    }
    const probe = this.deps.probe ?? probeCertificate;
    const result = await probe(hostname, config.ipv4[0]);
    const wasActive = row.verificationStatus === 'active';
    if (result.ok) {
      const updated = await this.prisma.siteDomain.update({
        where: { id: row.id },
        data: {
          verificationStatus: 'active',
          activatedAt: row.activatedAt ?? now,
          lastCheckedAt: now,
          lastErrorCode: null,
          lastError: null,
        },
        select: ROW_SELECT,
      });
      return toView(updated, config);
    }
    // DNS is fine; the certificate is not (yet). A verified domain waits for
    // it; an active one keeps serving and gets the warning (a probe hiccup must
    // not take a live domain down, the DNS check is what decides that).
    const updated = await this.prisma.siteDomain.update({
      where: { id: row.id },
      data: {
        lastCheckedAt: now,
        lastErrorCode: wasActive ? 'certificate_check_failed' : 'certificate_pending',
        lastError: wasActive
          ? `DNS is correct, but the certificate check failed (${result.reason}). The domain keeps serving; check again in a few minutes.`
          : `DNS is verified. The certificate is being issued (${result.reason}); this usually takes a minute or two. Check again shortly.`,
      },
      select: ROW_SELECT,
    });
    return toView(updated, config);
  }

  private async recordFailure(
    row: DomainRow,
    holdsClaim: boolean,
    now: Date,
    config: CustomDomainConfig,
    failure: { code: string; message: string },
  ): Promise<DomainView> {
    const updated = await this.prisma.siteDomain.update({
      where: { id: row.id },
      data: {
        verificationStatus: 'failed',
        lastCheckedAt: now,
        lastErrorCode: failure.code,
        lastError: failure.message,
        ...(holdsClaim ? { customHostname: null, activatedAt: null } : {}),
      },
      select: ROW_SELECT,
    });
    if (holdsClaim && row.hostname) this.invalidateHost(row.hostname);
    return toView(updated, config);
  }
}

function notFound(): DomainError {
  return new DomainError('domain_not_found', 'That domain is not connected to this site.', 404);
}

let cached: DomainService | null = null;

/** The process-wide service over the shared Prisma client (lazy, build-safe). */
export function getDomainService(): DomainService {
  if (!cached) cached = new DomainService();
  return cached;
}

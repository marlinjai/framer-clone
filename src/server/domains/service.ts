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

/** How many custom domains one workspace (one company's sites) may carry. */
export const MAX_DOMAINS_PER_WORKSPACE = 50;

/** The most hostnames the proxy feed returns (a backstop against runaway rows). */
export const MAX_PROXY_HOSTNAMES = 1_000;

/** Rows per page while building the proxy feed. */
export const PROXY_PAGE_SIZE = 500;

/** A live domain is re-checked when its last check is older than this. */
export const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** At most this many domains are re-checked per scheduled call. */
export const RECHECK_BATCH_SIZE = 20;

/** Definitive routing failures in a row after which a live claim is released. */
export const RECHECK_RELEASE_AFTER = 3;

/** What the proxy feed returns: the hostnames, and whether the cap cut it. */
export interface ProxyHostnameList {
  hostnames: string[];
  truncated: boolean;
}

/** What one scheduled re-check pass did. */
export interface RecheckSummary {
  checked: number;
  ok: number;
  transient: number;
  failing: number;
  released: number;
  /** Writes not applied because the row changed meanwhile. */
  skipped: number;
  /** True when the circuit breaker held back every failure of this pass. */
  circuitOpen: boolean;
}

/** The breaker needs at least this many rows in a pass to judge it. */
export const RECHECK_BREAKER_MIN_CHECKED = 5;

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
  consecutiveFailures: number;
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
  consecutiveFailures: true,
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
  /** Test seams for the proxy feed's cap and page size. */
  maxProxyHostnames?: number;
  proxyPageSize?: number;
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

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const row = await this.prisma.$transaction(
          async (tx) => {
            // Count-then-create runs under a per-workspace advisory lock (held
            // until the transaction ends), so two concurrent adds can never
            // both pass the caps. A site belongs to one workspace, so the same
            // lock also serializes the per-site cap.
            await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`site_domains:${site.workspaceId}`}))::text AS locked`;
            const count = await tx.siteDomain.count({
              where: { siteId: site.id, hostname: { not: null } },
            });
            if (count >= MAX_DOMAINS_PER_SITE) {
              throw new DomainError(
                'domain_limit_reached',
                `A site can have at most ${MAX_DOMAINS_PER_SITE} custom domains. Disconnect one first.`,
                409,
              );
            }
            // Fairness across companies: one workspace cannot take the whole
            // proxy feed (and the Let's Encrypt account's quota) by spreading
            // over sites.
            const workspaceCount = await tx.siteDomain.count({
              where: { workspaceId: site.workspaceId, hostname: { not: null } },
            });
            if (workspaceCount >= MAX_DOMAINS_PER_WORKSPACE) {
              throw new DomainError(
                'workspace_domain_limit_reached',
                `This company already has ${MAX_DOMAINS_PER_WORKSPACE} custom domains across its sites. Disconnect one first.`,
                409,
              );
            }
            return tx.siteDomain.create({
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
          },
          { maxWait: 10_000, timeout: 15_000 },
        );
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
   * active domains, re-checked against the hostname contract, capped at
   * MAX_PROXY_HOSTNAMES. Order decides who keeps a route when the cap bites:
   * ACTIVE domains first (they already have a certificate and visitors), then
   * verified ones, each oldest `verifiedAt` first, so a flood of new claims can
   * never push established domains out. Hitting the cap is logged and reported
   * (`truncated`). Unpublished sites keep their routes (and certificates):
   * flapping routes on every publish would spend Let's Encrypt quota for
   * nothing.
   */
  async listProxyHostnames(): Promise<ProxyHostnameList> {
    const zones = platformZones();
    const cap = this.deps.maxProxyHostnames ?? MAX_PROXY_HOSTNAMES;
    const pageSize = this.deps.proxyPageSize ?? PROXY_PAGE_SIZE;
    const names: string[] = [];
    const seen = new Set<string>();
    // Pages through each status until the cap is full or the rows run out, so
    // rows skipped by the hostname check can never let a verified domain take
    // the place of an active one. Once the cap is full, the scan continues only
    // until it finds ONE more valid hostname: `truncated` is then exact.
    for (const status of ['active', 'verified'] as const) {
      for (let skip = 0; ; skip += pageSize) {
        const rows = await this.prisma.siteDomain.findMany({
          where: { customHostname: { not: null }, verificationStatus: status },
          select: { customHostname: true },
          orderBy: [{ verifiedAt: 'asc' }, { id: 'asc' }],
          skip,
          take: pageSize,
        });
        for (const row of rows) {
          const name = row.customHostname;
          if (!name || seen.has(name) || !isClaimableHostname(name, zones)) continue;
          if (names.length >= cap) {
            console.error(
              `[domains] the proxy feed reached its cap of ${cap} hostnames; the newest verified domains get no route until some are removed`,
            );
            return { hostnames: names, truncated: true };
          }
          seen.add(name);
          names.push(name);
        }
        if (rows.length < pageSize) break;
      }
    }
    return { hostnames: names, truncated: false };
  }

  /**
   * The scheduled re-check of LIVE domains (verified or active): at most
   * RECHECK_BATCH_SIZE claims whose last check is older than
   * RECHECK_INTERVAL_MS, least recently checked first, which spreads the
   * checks out over time on its own. Each gets the routing-only DNS check (the
   * TXT record may have been tidied away, that is fine):
   *   - routing fine: the failure counter resets, and the certificate probe
   *     runs (a verified domain whose certificate arrived becomes active);
   *   - transient DNS error: only the "last checked" note, never counted;
   *   - definitive failure: counted, the domain keeps serving with a warning,
   *     and at RECHECK_RELEASE_AFTER failures in a row it is marked failed and
   *     its claim released (it stops serving, the proxy drops its route).
   * The owner's own "Check again" stays immediate: a definitive failure there
   * releases at once, since the owner is looking at the result.
   */
  async recheckDue(config: CustomDomainConfig): Promise<RecheckSummary> {
    const now = this.now();
    const cutoff = new Date(now.getTime() - RECHECK_INTERVAL_MS);
    const rows = await this.prisma.siteDomain.findMany({
      where: {
        customHostname: { not: null },
        hostname: { not: null },
        verificationStatus: { in: ['verified', 'active'] },
        OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: cutoff } }],
      },
      orderBy: [{ lastCheckedAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
      take: RECHECK_BATCH_SIZE,
      select: ROW_SELECT,
    });
    const summary: RecheckSummary = {
      checked: rows.length,
      ok: 0,
      transient: 0,
      failing: 0,
      released: 0,
      skipped: 0,
      circuitOpen: false,
    };
    const dns = this.deps.dns ?? createDnsLookup(config);

    // Phase 1: look everything up, write nothing.
    type Outcome =
      | { kind: 'mismatch' }
      | { kind: 'error' }
      | { kind: 'check'; check: Awaited<ReturnType<typeof checkDomainDns>> };
    const outcomes: Outcome[] = [];
    for (const row of rows) {
      if (row.customHostname !== row.hostname) {
        outcomes.push({ kind: 'mismatch' });
        continue;
      }
      try {
        const check = await checkDomainDns({
          hostname: row.hostname as string,
          token: row.verificationToken ?? '',
          requireTxt: false,
          config,
          dns,
        });
        outcomes.push({ kind: 'check', check });
      } catch (err) {
        console.error(`[domains] re-check of ${row.hostname} failed:`, err);
        outcomes.push({ kind: 'error' });
      }
    }

    // Circuit breaker: when most of a pass fails definitively, the likeliest
    // cause is OUR side (a wrong CUSTOM_DOMAIN_TARGET_* value, a broken
    // resolver), not dozens of customers changing DNS at once. Then no failure
    // is counted, so a misconfiguration can never release every domain.
    const definitive = outcomes.filter(
      (o) => o.kind === 'check' && !o.check.ok && !o.check.transient,
    ).length;
    if (rows.length >= RECHECK_BREAKER_MIN_CHECKED && definitive * 2 > rows.length) {
      summary.circuitOpen = true;
      console.error(
        `[domains] RE-CHECK CIRCUIT OPEN: ${definitive} of ${rows.length} live domains failed definitively in one pass; no failure was counted. Check CUSTOM_DOMAIN_TARGET_HOST / CUSTOM_DOMAIN_TARGET_IPV4 / CUSTOM_DOMAIN_TARGET_IPV6 and the resolver.`,
      );
    }

    // Phase 2: record, each write guarded on the row as it was read, so a
    // concurrent verify, disconnect, claim move or overlapping pass is never
    // overwritten (nothing matched: skipped, the newer state wins).
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const outcome = outcomes[i];
      const hostname = row.hostname as string;
      try {
        if (outcome.kind === 'mismatch' || outcome.kind === 'error') {
          // Stamp the check so a broken row cannot hold a batch slot forever.
          await this.guardedRecheckWrite(row, { lastCheckedAt: now }, summary);
          summary.transient += outcome.kind === 'error' ? 1 : 0;
          continue;
        }
        const { check } = outcome;
        if (check.ok) {
          const data = await this.probeData(row, hostname, now, config);
          if (await this.guardedRecheckWrite(row, data, summary)) summary.ok += 1;
          continue;
        }
        if (check.transient) {
          if (
            await this.guardedRecheckWrite(
              row,
              { lastCheckedAt: now, lastErrorCode: check.code, lastError: check.message },
              summary,
            )
          ) {
            summary.transient += 1;
          }
          continue;
        }
        if (summary.circuitOpen) {
          // Count nothing, but move the row to the back of the queue so a
          // cluster of genuine failures cannot hold every batch slot forever.
          await this.guardedRecheckWrite(row, { lastCheckedAt: now }, summary);
          continue;
        }
        const failures = row.consecutiveFailures + 1;
        if (failures >= RECHECK_RELEASE_AFTER) {
          const released = await this.guardedRecheckWrite(
            row,
            this.failureData(now, true, {
              code: check.code,
              message: `${check.message} (Checked ${failures} times in a row, so the domain was disconnected from the site. Fix the record and verify again.)`,
            }),
            summary,
          );
          if (released) {
            this.invalidateHost(hostname);
            summary.released += 1;
          }
        } else if (
          await this.guardedRecheckWrite(
            row,
            {
              consecutiveFailures: failures,
              lastCheckedAt: now,
              lastErrorCode: check.code,
              lastError: `${check.message} (Failed check ${failures} of ${RECHECK_RELEASE_AFTER}; the domain keeps serving until then.)`,
            },
            summary,
          )
        ) {
          summary.failing += 1;
        }
      } catch (err) {
        // One broken row must not stop the pass; it is retried next time.
        console.error(`[domains] recording the re-check of ${hostname} failed:`, err);
      }
    }
    return summary;
  }

  /**
   * One re-check write, applied only if the row is still exactly as it was
   * read (id, live claim, status, failure counter). Returns whether it applied;
   * a miss is counted as skipped.
   */
  private async guardedRecheckWrite(
    row: DomainRow,
    data: Prisma.SiteDomainUpdateManyMutationInput,
    summary: RecheckSummary,
  ): Promise<boolean> {
    const result = await this.prisma.siteDomain.updateMany({
      where: {
        id: row.id,
        customHostname: row.customHostname,
        verificationStatus: row.verificationStatus as DomainStatus,
        consecutiveFailures: row.consecutiveFailures,
      },
      data,
    });
    if (result.count === 0) summary.skipped += 1;
    return result.count > 0;
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
            consecutiveFailures: 0,
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
    const updated = await this.prisma.siteDomain.update({
      where: { id: row.id },
      data: await this.probeData(row, hostname, now, config),
      select: ROW_SELECT,
    });
    return toView(updated, config);
  }

  /** The write after DNS passed: probe the certificate, decide verified or active. */
  private async probeData(
    row: DomainRow,
    hostname: string,
    now: Date,
    config: CustomDomainConfig,
  ): Promise<Prisma.SiteDomainUpdateManyMutationInput> {
    if (!config.tlsProbe) {
      return { lastCheckedAt: now, lastErrorCode: null, lastError: null, consecutiveFailures: 0 };
    }
    const probe = this.deps.probe ?? probeCertificate;
    const result = await probe(hostname, config.ipv4[0]);
    if (result.ok) {
      return {
        verificationStatus: 'active',
        activatedAt: row.activatedAt ?? now,
        lastCheckedAt: now,
        lastErrorCode: null,
        lastError: null,
        consecutiveFailures: 0,
      };
    }
    // DNS is fine; the certificate is not (yet). A verified domain waits for
    // it; an active one keeps serving and gets the warning (a probe hiccup must
    // not take a live domain down, the DNS check is what decides that).
    const wasActive = row.verificationStatus === 'active';
    return {
      lastCheckedAt: now,
      consecutiveFailures: 0,
      lastErrorCode: wasActive ? 'certificate_check_failed' : 'certificate_pending',
      lastError: wasActive
        ? `DNS is correct, but the certificate check failed (${result.reason}). The domain keeps serving; check again in a few minutes.`
        : `DNS is verified. The certificate is being issued (${result.reason}); this usually takes a minute or two. Check again shortly.`,
    };
  }

  /** The write for a definitive failure (releasing the live claim if held). */
  private failureData(
    now: Date,
    holdsClaim: boolean,
    failure: { code: string; message: string },
  ): Prisma.SiteDomainUpdateManyMutationInput {
    return {
      verificationStatus: 'failed',
      lastCheckedAt: now,
      lastErrorCode: failure.code,
      lastError: failure.message,
      consecutiveFailures: 0,
      ...(holdsClaim ? { customHostname: null, activatedAt: null } : {}),
    };
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
      data: this.failureData(now, holdsClaim, failure),
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

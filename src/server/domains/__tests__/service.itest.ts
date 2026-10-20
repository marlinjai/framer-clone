// DomainService against a real Postgres (the shared integration container,
// DATABASE_URL from vitest.integration.setup.ts). DNS and the TLS probe are
// fakes; the database, its unique indexes and the transactions are real.
//
// Covers the lifecycle and the four stateful-flow paths
// (knowledge-base/standards/stateful-flow-testing.md) on the server side:
//   forward:   add -> pending -> verify -> verified -> active, and the resolver
//              serves the site only from verified on;
//   revise:    a hostname typo is disconnected and the corrected one gets a
//              fresh token; re-adding the SAME hostname keeps its token;
//   resume:    a new service instance (a reload) sees the same claim, token
//              and status from the database alone;
//   re-entry:  a failed check recovers cleanly; disconnect then re-add starts
//              over with a new token and no leftover error.
// Plus: a pending claim never blocks the real owner, DNS proof moves a claim
// between sites, a lost claim stops serving, transient DNS changes nothing.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

vi.mock('next/cache', () => ({ unstable_cache: vi.fn(), revalidateTag: vi.fn() }));

import { getPrismaClient } from '@/server/db';
import { resolvePublishedSite } from '@/server/sites/publicResolver';
import type { CustomDomainConfig } from '../config';
import type { DnsLookup } from '../dnsCheck';
import { DomainError, DomainService, RECHECK_INTERVAL_MS, type DomainServiceDeps } from '../service';
import type { TlsProbe } from '../tlsProbe';

const CONFIG: CustomDomainConfig = {
  targetHost: 'domains.lumitra.co',
  ipv4: ['203.0.113.10'],
  ipv6: [],
  dnsServers: [],
  tlsProbe: true,
};

const TG = '018f9c10-0000-7000-8000-0000000000d1';
let prisma: PrismaClient;

// A fake DNS: per hostname, which TXT values exist and where it routes.
const txt = new Map<string, string[]>();
const routes = new Map<string, string[] | 'timeout'>();
const dns: DnsLookup = {
  resolveTxt: async (name) => {
    const values = txt.get(name.replace(/^_lumitra-verify\./, ''));
    if (!values) throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
    return values.map((v) => [v]);
  },
  resolveCname: async () => {
    throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
  },
  resolve4: async (name) => {
    const r = routes.get(name);
    if (r === 'timeout') throw Object.assign(new Error('ETIMEOUT'), { code: 'ETIMEOUT' });
    if (!r) throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
    return r;
  },
  resolve6: async () => {
    throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
  },
};
let certReady = false;
const probe: TlsProbe = async () => (certReady ? { ok: true } : { ok: false, reason: 'ECONNRESET' });
const invalidated: string[] = [];

let clock = new Date('2026-10-20T00:00:00Z');
function service(extra: Partial<DomainServiceDeps> = {}): DomainService {
  return new DomainService({
    prisma,
    dns,
    probe,
    invalidateHost: (h) => invalidated.push(h),
    now: () => clock,
    ...extra,
  });
}

async function makeSite(id: string, workspaceId = 'ws_dom') {
  const now = new Date();
  await prisma.site.create({
    data: {
      id,
      workspaceId,
      tenantGroupId: TG,
      name: id,
      status: 'published',
      projectCreatedAt: now,
      projectUpdatedAt: now,
    },
  });
  return { id, workspaceId, tenantGroupId: TG };
}

function tokenOf(view: { records: { type: string; value: string }[] }): string {
  const record = view.records.find((r) => r.type === 'TXT');
  return record!.value.replace('lumitra-verify=', '');
}

function publishDns(hostname: string, token: string) {
  txt.set(hostname, [`lumitra-verify=${token}`]);
  routes.set(hostname, ['203.0.113.10']);
}

beforeAll(() => {
  prisma = getPrismaClient();
});

beforeEach(async () => {
  await prisma.siteDomain.deleteMany({ where: { tenantGroupId: TG } });
  await prisma.site.deleteMany({ where: { tenantGroupId: TG } });
  txt.clear();
  routes.clear();
  certReady = false;
  invalidated.length = 0;
  clock = new Date('2026-10-20T00:00:00Z');
});

afterAll(async () => {
  await prisma.siteDomain.deleteMany({ where: { tenantGroupId: TG } });
  await prisma.site.deleteMany({ where: { tenantGroupId: TG } });
});

describe('forward: add, verify, activate, serve', () => {
  it('walks pending -> verified -> active and serves only once verified', async () => {
    const site = await makeSite('dom_site_fwd');
    const { domain, created } = await service().addDomain(site, 'WWW.Shop-Example.com', CONFIG);
    expect(created).toBe(true);
    expect(domain).toMatchObject({ hostname: 'www.shop-example.com', status: 'pending', serving: false });
    expect(tokenOf(domain)).toMatch(/^[0-9a-f]{64}$/);
    expect(await resolvePublishedSite('www.shop-example.com', prisma, 'sites.lumitra.co')).toBeNull();

    publishDns('www.shop-example.com', tokenOf(domain));
    const verified = await service().verifyDomain(site.id, domain.id, CONFIG);
    expect(verified).toMatchObject({ status: 'verified', serving: true, lastErrorCode: 'certificate_pending' });
    expect(invalidated).toContain('www.shop-example.com');
    expect((await resolvePublishedSite('www.shop-example.com', prisma, 'sites.lumitra.co'))?.siteId).toBe(site.id);
    expect((await service().listProxyHostnames()).hostnames).toEqual(['www.shop-example.com']);

    certReady = true;
    const active = await service().verifyDomain(site.id, domain.id, CONFIG);
    expect(active).toMatchObject({ status: 'active', serving: true, lastError: null });
    expect(active.activatedAt).not.toBeNull();
  });
});

describe('backtrack and revise', () => {
  it('a corrected hostname gets a fresh token; re-adding the same one keeps it', async () => {
    const site = await makeSite('dom_site_rev');
    const typo = (await service().addDomain(site, 'www.exmple.com', CONFIG)).domain;
    const again = await service().addDomain(site, 'www.exmple.com', CONFIG);
    expect(again.created).toBe(false);
    expect(tokenOf(again.domain)).toBe(tokenOf(typo));

    await service().removeDomain(site.id, typo.id);
    const fixed = (await service().addDomain(site, 'www.example.com', CONFIG)).domain;
    expect(tokenOf(fixed)).not.toBe(tokenOf(typo));
    const list = await service().listDomains(site.id, CONFIG);
    expect(list.map((d) => d.hostname)).toEqual(['www.example.com']);
  });
});

describe('resume', () => {
  it('a fresh service instance sees the same claim, token and status', async () => {
    const site = await makeSite('dom_site_res');
    const added = (await service().addDomain(site, 'shop.example.org', CONFIG)).domain;
    const [reloaded] = await new DomainService({ prisma }).listDomains(site.id, CONFIG);
    expect(reloaded).toMatchObject({ id: added.id, status: 'pending' });
    expect(tokenOf(reloaded)).toBe(tokenOf(added));
  });
});

describe('re-entry after failure or completion', () => {
  it('a failed check records the reason, then a fixed DNS verifies and clears it', async () => {
    const site = await makeSite('dom_site_fail');
    const d = (await service().addDomain(site, 'fail.example.net', CONFIG)).domain;
    const failed = await service().verifyDomain(site.id, d.id, CONFIG);
    expect(failed).toMatchObject({ status: 'failed', lastErrorCode: 'txt_missing', serving: false });

    publishDns('fail.example.net', tokenOf(d));
    certReady = true;
    const ok = await service().verifyDomain(site.id, d.id, CONFIG);
    expect(ok).toMatchObject({ status: 'active', lastErrorCode: null, lastError: null });
  });

  it('disconnect then re-add starts over: new token, pending, no old error', async () => {
    const site = await makeSite('dom_site_again');
    const first = (await service().addDomain(site, 'again.example.net', CONFIG)).domain;
    publishDns('again.example.net', tokenOf(first));
    certReady = true;
    await service().verifyDomain(site.id, first.id, CONFIG);
    await service().removeDomain(site.id, first.id);
    expect(await resolvePublishedSite('again.example.net', prisma, 'sites.lumitra.co')).toBeNull();
    expect((await service().listProxyHostnames()).hostnames).toEqual([]);

    const second = (await service().addDomain(site, 'again.example.net', CONFIG)).domain;
    expect(second).toMatchObject({ status: 'pending', serving: false, lastError: null });
    expect(tokenOf(second)).not.toBe(tokenOf(first));
    // The old TXT value no longer proves anything.
    const stale = await service().verifyDomain(site.id, second.id, CONFIG);
    expect(stale).toMatchObject({ status: 'failed', lastErrorCode: 'txt_mismatch' });
  });
});

describe('ownership rules', () => {
  it('a pending claim on another site never blocks the real owner', async () => {
    const squatter = await makeSite('dom_site_squat', 'ws_other');
    const owner = await makeSite('dom_site_owner');
    await service().addDomain(squatter, 'brand.example.com', CONFIG);
    const mine = (await service().addDomain(owner, 'brand.example.com', CONFIG)).domain;
    publishDns('brand.example.com', tokenOf(mine));
    const verified = await service().verifyDomain(owner.id, mine.id, CONFIG);
    expect(verified.serving).toBe(true);
    expect((await resolvePublishedSite('brand.example.com', prisma, 'sites.lumitra.co'))?.siteId).toBe(owner.id);
  });

  it('fresh DNS proof moves a live claim to another site, which the first is told', async () => {
    const a = await makeSite('dom_site_a');
    const b = await makeSite('dom_site_b', 'ws_other');
    const da = (await service().addDomain(a, 'moved.example.com', CONFIG)).domain;
    publishDns('moved.example.com', tokenOf(da));
    await service().verifyDomain(a.id, da.id, CONFIG);

    const db = (await service().addDomain(b, 'moved.example.com', CONFIG)).domain;
    publishDns('moved.example.com', tokenOf(db));
    await service().verifyDomain(b.id, db.id, CONFIG);

    expect((await resolvePublishedSite('moved.example.com', prisma, 'sites.lumitra.co'))?.siteId).toBe(b.id);
    const [lost] = await service().listDomains(a.id, CONFIG);
    expect(lost).toMatchObject({ status: 'failed', serving: false, lastErrorCode: 'claimed_elsewhere' });
    expect((await service().listProxyHostnames()).hostnames).toEqual(['moved.example.com']);
  });

  it('a serving domain whose DNS moved away loses the claim and stops serving', async () => {
    const site = await makeSite('dom_site_drift');
    const d = (await service().addDomain(site, 'drift.example.com', CONFIG)).domain;
    publishDns('drift.example.com', tokenOf(d));
    await service().verifyDomain(site.id, d.id, CONFIG);
    // The owner tidies the TXT away (fine) and points the host elsewhere (not).
    txt.delete('drift.example.com');
    routes.set('drift.example.com', ['198.51.100.9']);
    const after = await service().verifyDomain(site.id, d.id, CONFIG);
    expect(after).toMatchObject({ status: 'failed', serving: false, lastErrorCode: 'routing_mismatch' });
    expect(await resolvePublishedSite('drift.example.com', prisma, 'sites.lumitra.co')).toBeNull();
  });

  it('a transient DNS failure changes nothing but the note', async () => {
    const site = await makeSite('dom_site_flaky');
    const d = (await service().addDomain(site, 'flaky.example.com', CONFIG)).domain;
    publishDns('flaky.example.com', tokenOf(d));
    certReady = true;
    await service().verifyDomain(site.id, d.id, CONFIG);
    routes.set('flaky.example.com', 'timeout');
    const after = await service().verifyDomain(site.id, d.id, CONFIG);
    expect(after).toMatchObject({ status: 'active', serving: true, lastErrorCode: 'dns_unavailable' });
  });

  it('a domain of another site can be neither verified nor removed through this one', async () => {
    const a = await makeSite('dom_site_x');
    const b = await makeSite('dom_site_y', 'ws_other');
    const d = (await service().addDomain(a, 'x.example.com', CONFIG)).domain;
    await expect(service().verifyDomain(b.id, d.id, CONFIG)).rejects.toBeInstanceOf(DomainError);
    await expect(service().removeDomain(b.id, d.id)).rejects.toMatchObject({ status: 404 });
  });

  it('refuses platform zones and caps domains per site', async () => {
    const site = await makeSite('dom_site_cap');
    await expect(service().addDomain(site, 'shop.lumitra.co', CONFIG)).rejects.toMatchObject({
      code: 'reserved_hostname',
    });
    for (let i = 0; i < 10; i += 1) await service().addDomain(site, `d${i}.example.com`, CONFIG);
    await expect(service().addDomain(site, 'd10.example.com', CONFIG)).rejects.toMatchObject({
      code: 'domain_limit_reached',
    });
  });
});

describe('caps and feed fairness', () => {
  it('caps custom domains per workspace across its sites', async () => {
    const sites = [];
    for (let i = 0; i < 6; i += 1) sites.push(await makeSite(`dom_site_ws${i}`, 'ws_cap'));
    let n = 0;
    for (const site of sites.slice(0, 5)) {
      for (let j = 0; j < 10; j += 1) {
        await service().addDomain(site, `w${n}.example.com`, CONFIG);
        n += 1;
      }
    }
    await expect(service().addDomain(sites[5], 'w50.example.com', CONFIG)).rejects.toMatchObject({
      code: 'workspace_domain_limit_reached',
      status: 409,
    });
  });

  it('orders the feed active first, then by oldest verification', async () => {
    const site = await makeSite('dom_site_order');
    const add = async (host: string) => {
      const d = (await service().addDomain(site, host, CONFIG)).domain;
      publishDns(host, tokenOf(d));
      return d;
    };
    const old = await add('old-verified.example.com');
    await service().verifyDomain(site.id, old.id, CONFIG);
    clock = new Date(clock.getTime() + 60_000);
    const newer = await add('new-verified.example.com');
    await service().verifyDomain(site.id, newer.id, CONFIG);
    clock = new Date(clock.getTime() + 60_000);
    certReady = true;
    const live = await add('zz-active.example.com');
    await service().verifyDomain(site.id, live.id, CONFIG);

    const feed = await service().listProxyHostnames();
    expect(feed).toEqual({
      hostnames: ['zz-active.example.com', 'old-verified.example.com', 'new-verified.example.com'],
      truncated: false,
    });
  });
});

describe('scheduled re-check of live domains', () => {
  async function liveDomain(id: string, host: string) {
    const site = await makeSite(id);
    const d = (await service().addDomain(site, host, CONFIG)).domain;
    publishDns(host, tokenOf(d));
    certReady = true;
    await service().verifyDomain(site.id, d.id, CONFIG);
    return { site, d };
  }
  const later = (hours: number) => {
    clock = new Date(clock.getTime() + hours * 60 * 60 * 1000);
  };

  it('only checks domains whose last check is older than the interval', async () => {
    await liveDomain('dom_site_rc1', 'rc1.example.com');
    expect((await service().recheckDue(CONFIG)).checked).toBe(0);
    clock = new Date(clock.getTime() + RECHECK_INTERVAL_MS + 1);
    expect((await service().recheckDue(CONFIG)).checked).toBe(1);
    expect((await service().recheckDue(CONFIG)).checked).toBe(0);
  });

  it('needs routing only: a tidied-away TXT record keeps the domain', async () => {
    const { site } = await liveDomain('dom_site_rc2', 'rc2.example.com');
    txt.delete('rc2.example.com');
    later(7);
    expect(await service().recheckDue(CONFIG)).toMatchObject({ ok: 1 });
    const [d] = await service().listDomains(site.id, CONFIG);
    expect(d).toMatchObject({ status: 'active', serving: true });
  });

  it('releases a domain after three definitive failures in a row, not before', async () => {
    const { site } = await liveDomain('dom_site_rc3', 'rc3.example.com');
    routes.set('rc3.example.com', ['198.51.100.9']);
    later(7);
    expect(await service().recheckDue(CONFIG)).toMatchObject({ failing: 1 });
    later(7);
    expect(await service().recheckDue(CONFIG)).toMatchObject({ failing: 1 });
    let [d] = await service().listDomains(site.id, CONFIG);
    expect(d).toMatchObject({ status: 'active', serving: true, lastErrorCode: 'routing_mismatch' });
    expect(d.lastError).toContain('2 of 3');
    expect((await resolvePublishedSite('rc3.example.com', prisma, 'sites.lumitra.co'))?.siteId).toBe(site.id);

    later(7);
    expect(await service().recheckDue(CONFIG)).toMatchObject({ released: 1 });
    [d] = await service().listDomains(site.id, CONFIG);
    expect(d).toMatchObject({ status: 'failed', serving: false });
    expect(await resolvePublishedSite('rc3.example.com', prisma, 'sites.lumitra.co')).toBeNull();
    expect((await service().listProxyHostnames()).hostnames).toEqual([]);
    expect(invalidated).toContain('rc3.example.com');
  });

  it('transient errors never count, and a success resets the counter', async () => {
    const { site } = await liveDomain('dom_site_rc4', 'rc4.example.com');
    routes.set('rc4.example.com', ['198.51.100.9']);
    later(7);
    await service().recheckDue(CONFIG);
    later(7);
    await service().recheckDue(CONFIG);
    routes.set('rc4.example.com', 'timeout');
    for (let i = 0; i < 4; i += 1) {
      later(7);
      expect(await service().recheckDue(CONFIG)).toMatchObject({ transient: 1 });
    }
    routes.set('rc4.example.com', ['203.0.113.10']);
    later(7);
    expect(await service().recheckDue(CONFIG)).toMatchObject({ ok: 1 });
    // Two more failures after the reset still do not release it.
    routes.set('rc4.example.com', ['198.51.100.9']);
    later(7);
    await service().recheckDue(CONFIG);
    later(7);
    await service().recheckDue(CONFIG);
    const [d] = await service().listDomains(site.id, CONFIG);
    expect(d).toMatchObject({ status: 'active', serving: true });
  });

  it('moves a verified domain to active once its certificate answers', async () => {
    const site = await makeSite('dom_site_rc5');
    const d = (await service().addDomain(site, 'rc5.example.com', CONFIG)).domain;
    publishDns('rc5.example.com', tokenOf(d));
    await service().verifyDomain(site.id, d.id, CONFIG);
    certReady = true;
    later(7);
    await service().recheckDue(CONFIG);
    const [after] = await service().listDomains(site.id, CONFIG);
    expect(after.status).toBe('active');
  });
});

describe('review fixes: breaker, guarded writes, paging, cap race', () => {
  const later = (hours: number) => {
    clock = new Date(clock.getTime() + hours * 60 * 60 * 1000);
  };
  async function live(siteId: string, host: string) {
    const site = await makeSite(siteId);
    const d = (await service().addDomain(site, host, CONFIG)).domain;
    publishDns(host, tokenOf(d));
    certReady = true;
    await service().verifyDomain(site.id, d.id, CONFIG);
    return { site, d };
  }

  it('the circuit breaker counts nothing when most of a pass fails (a wrong target value)', async () => {
    for (let i = 0; i < 6; i += 1) await live(`dom_site_br${i}`, `br${i}.example.com`);
    // The platform target is misconfigured: every domain "points elsewhere".
    const wrong = { ...CONFIG, ipv4: ['192.0.2.99'] };
    for (let pass = 0; pass < 4; pass += 1) {
      later(7);
      const summary = await service().recheckDue(wrong);
      expect(summary).toMatchObject({ checked: 6, circuitOpen: true, failing: 0, released: 0 });
    }
    const rows = await prisma.siteDomain.findMany({ where: { hostname: { startsWith: 'br' } } });
    expect(rows.every((r) => r.consecutiveFailures === 0 && r.customHostname !== null)).toBe(true);
    // Fixed config: the next pass is ordinary again.
    expect(await service().recheckDue(CONFIG)).toMatchObject({ circuitOpen: false, ok: 6 });
  });

  it('a minority of failures in a pass of five or more still counts', async () => {
    for (let i = 0; i < 5; i += 1) await live(`dom_site_mn${i}`, `mn${i}.example.com`);
    routes.set('mn0.example.com', ['198.51.100.9']);
    later(7);
    expect(await service().recheckDue(CONFIG)).toMatchObject({ circuitOpen: false, failing: 1, ok: 4 });
  });

  it('a re-check write never overwrites a row that changed after it was read', async () => {
    const { site, d } = await live('dom_site_race', 'race.example.com');
    routes.set('race.example.com', ['198.51.100.9']);
    later(7);
    // A DNS lookup slow enough that the owner disconnects and re-adds meanwhile.
    const slowDns: DnsLookup = {
      ...dns,
      resolve4: async (name) => {
        await prisma.siteDomain.update({
          where: { id: d.id },
          data: { consecutiveFailures: 2, lastErrorCode: 'changed_meanwhile' },
        });
        return dns.resolve4(name);
      },
    };
    const summary = await service({ dns: slowDns }).recheckDue(CONFIG);
    expect(summary).toMatchObject({ skipped: 1, failing: 0, released: 0 });
    const [after] = await service().listDomains(site.id, CONFIG);
    expect(after).toMatchObject({ status: 'active', serving: true, lastErrorCode: 'changed_meanwhile' });
  });

  it('a row whose claim does not match its hostname is stamped, so it frees its batch slot', async () => {
    const { d } = await live('dom_site_mm', 'mm.example.com');
    await prisma.siteDomain.update({ where: { id: d.id }, data: { hostname: 'mm-renamed.example.com' } });
    later(7);
    await service().recheckDue(CONFIG);
    const row = await prisma.siteDomain.findUnique({ where: { id: d.id } });
    expect(row?.lastCheckedAt?.getTime()).toBe(clock.getTime());
  });

  it('skipped feed rows never let a verified domain displace an active one; truncated is exact', async () => {
    const site = await makeSite('dom_site_page');
    const now = new Date();
    const mk = (host: string, status: 'active' | 'verified', minutes: number) =>
      prisma.siteDomain.create({
        data: {
          siteId: site.id,
          workspaceId: site.workspaceId,
          tenantGroupId: TG,
          hostname: host,
          customHostname: host,
          verificationToken: `tok-${host}`,
          verificationStatus: status,
          verifiedAt: new Date(now.getTime() + minutes * 60_000),
        },
      });
    // Oldest active rows are invalid (a tampered platform name), so they are
    // skipped; the valid active rows come after them on a later page.
    await mk('a.lumitra.co', 'active', 0);
    await mk('b.lumitra.co', 'active', 1);
    await mk('act1.example.com', 'active', 2);
    await mk('act2.example.com', 'active', 3);
    await mk('ver1.example.com', 'verified', 0);

    const capped = await service({ maxProxyHostnames: 2, proxyPageSize: 2 }).listProxyHostnames();
    expect(capped).toEqual({ hostnames: ['act1.example.com', 'act2.example.com'], truncated: true });

    const exact = await service({ maxProxyHostnames: 3, proxyPageSize: 2 }).listProxyHostnames();
    expect(exact).toEqual({
      hostnames: ['act1.example.com', 'act2.example.com', 'ver1.example.com'],
      truncated: false,
    });
  });

  it('concurrent adds can never exceed the workspace cap', async () => {
    const sites = [];
    for (let i = 0; i < 6; i += 1) sites.push(await makeSite(`dom_site_cc${i}`, 'ws_race'));
    const attempts = sites.flatMap((site, i) =>
      Array.from({ length: 10 }, (_, j) =>
        service().addDomain(site, `c${i}-${j}.example.com`, CONFIG).then(
          () => 'ok' as const,
          (err: unknown) => (err as DomainError).code,
        ),
      ),
    );
    const results = await Promise.all(attempts);
    expect(results.filter((r) => r === 'ok')).toHaveLength(50);
    expect(results.filter((r) => r === 'workspace_domain_limit_reached')).toHaveLength(10);
    expect(await prisma.siteDomain.count({ where: { workspaceId: 'ws_race' } })).toBe(50);
  });
});

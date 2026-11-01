// The report route against a real Postgres (pnpm test:integration): host ->
// published site -> one aggregate row, what that row holds, the cap per site, the
// delete with the site, and the summary the operator reads.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// unstable_cache needs a running Next server; the site resolves uncached here.
vi.mock('next/cache', () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));

import {
  createPublishedSite,
  openStorefrontFixtures,
  type StorefrontFixtures,
} from '@/server/commerce/__tests__/storefrontFixtures';
import { __resetCspReportLimiterForTests } from '@/server/sites/cspReports';
import {
  formatCspReportSummary,
  MAX_ROWS_PER_SITE,
  OTHER_BLOCKED_HOST,
  readCspReportSummary,
} from '@/server/sites/cspReportStore';
import { middleware } from '@/middleware';
import { POST } from '../route';

const VISITOR_QUERY = 'email=visitor%40example.com&token=visitor-token';

let fx: StorefrontFixtures;
let site: { host: string; siteId: string; workspaceId: string };
let other: { host: string; siteId: string; workspaceId: string };

function report(host: string, blockedUri: string, directive = 'img-src', headers: Record<string, string> = {}) {
  return POST(
    new Request(`https://${host}/api/csp-report`, {
      method: 'POST',
      headers: { host, 'content-type': 'application/csp-report', ...headers },
      body: JSON.stringify({
        'csp-report': {
          'document-uri': `https://${host}/thanks?${VISITOR_QUERY}`,
          referrer: `https://search.example/?${VISITOR_QUERY}`,
          'effective-directive': directive,
          'violated-directive': directive,
          'original-policy': "img-src 'self'",
          disposition: 'report',
          'blocked-uri': blockedUri,
        },
      }),
    }),
  );
}

const rowsOf = (siteId: string) =>
  fx.prisma.cspReportCount.findMany({ where: { siteId }, orderBy: { blockedHost: 'asc' } });

beforeAll(async () => {
  process.env.EDITOR_HOST = 'app.example.org';
  fx = openStorefrontFixtures();
  site = await createPublishedSite(fx, randomUUID(), 'csp');
  other = await createPublishedSite(fx, randomUUID(), 'csp-other');
});

beforeEach(async () => {
  __resetCspReportLimiterForTests();
  await fx.prisma.cspReportCount.deleteMany({ where: { siteId: { in: [site.siteId, other.siteId] } } });
});

afterAll(async () => {
  delete process.env.EDITOR_HOST;
  await fx.prisma.site.deleteMany({ where: { id: { in: [site.siteId, other.siteId] } } });
  await fx.close();
});

describe('POST /api/csp-report', () => {
  it('adds up reports per site, directive and host, and keeps no address beyond the host', async () => {
    const first = await report(site.host, `https://tracker.example/a.png?${VISITOR_QUERY}`);
    expect(first.status).toBe(204);
    await report(site.host, `https://tracker.example/other/path.png?${VISITOR_QUERY}`);
    await report(site.host, 'https://tracker.example/f.woff2', 'font-src');
    await report(other.host, 'https://tracker.example/a.png');

    const rows = await rowsOf(site.siteId);
    expect(rows.map((r) => [r.directive, r.blockedHost, r.count])).toEqual(
      expect.arrayContaining([
        ['img-src', 'tracker.example', 2],
        ['font-src', 'tracker.example', 1],
      ]),
    );
    expect(rows).toHaveLength(2);
    expect(await rowsOf(other.siteId)).toHaveLength(1);
    expect(rows[0].lastSeenAt.getTime()).toBeGreaterThanOrEqual(rows[0].firstSeenAt.getTime());

    const stored = JSON.stringify(rows);
    for (const leak of ['visitor', 'token', 'thanks', 'search.example', '/a.png']) expect(stored).not.toContain(leak);
  });

  it('takes a report through the middleware and into the table on a published host, however it is marked', async () => {
    const fromBrowser = (headers: Record<string, string>) =>
      new NextRequest(`https://${site.host}/api/csp-report`, {
        method: 'POST',
        headers: { host: site.host, 'content-type': 'application/csp-report', ...headers },
        body: JSON.stringify({ 'csp-report': { 'effective-directive': 'img-src', 'blocked-uri': 'https://through.example/a.png' } }),
      });
    const markings: Record<string, string>[] = [
      { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'no-cors', origin: `https://${site.host}` },
      { 'sec-fetch-site': 'cross-site' },
      { origin: 'null' },
      {},
    ];
    for (const headers of markings) {
      const request = fromBrowser(headers);
      expect((await middleware(request)).headers.get('x-middleware-next')).toBe('1');
      expect((await POST(request)).status).toBe(204);
    }
    expect((await rowsOf(site.siteId)).map((r) => [r.blockedHost, r.count])).toEqual([['through.example', markings.length]]);
  });

  it('stores no report naming the site, an allowed host or the row for replaced counts', async () => {
    expect((await report(site.host, `https://${site.host}/a.png`)).status).toBe(204);
    expect((await report(site.host, 'https://images.unsplash.com/a.png')).status).toBe(204);
    expect((await report(site.host, 'https://(other)/a.png')).status).toBe(204);
    expect(await rowsOf(site.siteId)).toEqual([]);
  });

  it('stores nothing for junk, and tells a browser nothing went wrong', async () => {
    const junk = await POST(
      new Request(`https://${site.host}/api/csp-report`, { method: 'POST', headers: { host: site.host }, body: 'nonsense' }),
    );
    expect(junk.status).toBe(204);
    expect((await report(site.host, 'https://x.example/a.png', 'script-src')).status).toBe(204);
    expect((await report(site.host, 'inline')).status).toBe(204);
    expect(await rowsOf(site.siteId)).toEqual([]);
  });

  it('answers 404 on the editor host and on a host with no site, storing nothing', async () => {
    const before = await fx.prisma.cspReportCount.count();
    expect((await report('app.example.org', 'https://x.example/a.png')).status).toBe(404);
    expect((await report('nobody-here.example.com', 'https://x.example/a.png')).status).toBe(404);
    expect(await fx.prisma.cspReportCount.count()).toBe(before);
  });

  it('answers 429 past the limit per address and writes nothing more', async () => {
    const headers = { 'x-forwarded-for': '203.0.113.7' };
    for (let i = 0; i < 120; i += 1) {
      expect((await report(site.host, 'https://x.example/a.png', 'img-src', headers)).status).toBe(204);
    }
    const refused = await report(site.host, 'https://x.example/a.png', 'img-src', headers);
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBeTruthy();
    expect((await rowsOf(site.siteId))[0].count).toBe(120);
  });

  it('at the cap replaces the lowest count, keeps its count, and a real host survives a flood', async () => {
    await fx.prisma.cspReportCount.createMany({
      data: Array.from({ length: MAX_ROWS_PER_SITE }, (_, i) => ({
        siteId: site.siteId,
        directive: 'img-src',
        blockedHost: `junk-${i}.example`,
        // Every row above the lowest, which is the one to go. Row 7 is the real host.
        count: i === 0 ? 1 : i === 7 ? 50 : 2,
      })),
    });
    await report(site.host, 'https://new-1.example/a.png');

    let rows = await rowsOf(site.siteId);
    expect(rows).toHaveLength(MAX_ROWS_PER_SITE + 1);
    expect(rows.find((r) => r.blockedHost === 'new-1.example')?.count).toBe(1);
    expect(rows.some((r) => r.blockedHost === 'junk-0.example')).toBe(false);
    expect(rows.find((r) => r.blockedHost === OTHER_BLOCKED_HOST)?.count).toBe(1);

    // A flood of one-off hosts only displaces itself.
    for (let i = 2; i < 6; i += 1) await report(site.host, `https://new-${i}.example/a.png`);
    await report(site.host, 'https://junk-7.example/a.png');
    rows = await rowsOf(site.siteId);
    expect(rows).toHaveLength(MAX_ROWS_PER_SITE + 1);
    expect(rows.find((r) => r.blockedHost === 'junk-7.example')?.count).toBe(51);
    expect(rows.filter((r) => r.blockedHost.startsWith('new-')).map((r) => r.blockedHost)).toEqual(['new-5.example']);
    expect(rows.find((r) => r.blockedHost === OTHER_BLOCKED_HOST)?.count).toBe(5);
    // A full site does not stop another one.
    await report(other.host, 'https://new-1.example/a.png');
    expect((await rowsOf(other.siteId)).map((r) => r.blockedHost)).toEqual(['new-1.example']);
  });

  it('counts two first reports for one host once each', async () => {
    await Promise.all([report(site.host, 'https://race.example/a.png'), report(site.host, 'https://race.example/b.png')]);
    expect((await rowsOf(site.siteId)).map((r) => r.count)).toEqual([2]);
  });

  it('goes with the site when the site is deleted', async () => {
    const doomed = await createPublishedSite(fx, randomUUID(), 'csp-doomed');
    await report(doomed.host, 'https://x.example/a.png');
    expect(await rowsOf(doomed.siteId)).toHaveLength(1);
    await fx.prisma.site.delete({ where: { id: doomed.siteId } });
    expect(await rowsOf(doomed.siteId)).toEqual([]);
  });
});

describe('readCspReportSummary', () => {
  it('gives one line per directive and host across sites, highest count first', async () => {
    await report(site.host, 'https://busy.example/a.png');
    await report(site.host, 'https://busy.example/a.png');
    await report(other.host, 'https://busy.example/a.png');
    await report(other.host, 'https://rare.example/f.woff2', 'font-src');

    const summary = (await readCspReportSummary(fx.prisma)).filter((row) => /busy|rare/.test(row.blockedHost));
    expect(summary.map((row) => [row.directive, row.blockedHost, row.count])).toEqual([
      ['img-src', 'busy.example', 3],
      ['font-src', 'rare.example', 1],
    ]);
    expect(summary[0].sites.map((s) => [s.siteId, s.count])).toEqual([
      [site.siteId, 2],
      [other.siteId, 1],
    ]);
    const lines = formatCspReportSummary(summary);
    expect(lines[0]).toBe('Counts are leads and can be forged: check a host before acting on it.');
    expect(lines[1]).toMatch(/^3\timg-src\tbusy\.example\tlast /);
    expect(lines[1]).toContain('Store csp (2), Store csp-other (1)');
  });

  it('says an empty result proves nothing', () => {
    expect(formatCspReportSummary([])).toEqual(['No reports stored, which proves nothing.']);
  });

  const row = (blockedHost: string, name: string) => ({
    directive: 'img-src',
    blockedHost,
    count: 1,
    lastSeenAt: new Date(0),
    sites: [{ siteId: 's', name, count: 1 }],
  });

  it('warns once for a site with hosts replaced, across directives', () => {
    const lines = formatCspReportSummary([
      row(OTHER_BLOCKED_HOST, 'Busy'),
      { ...row(OTHER_BLOCKED_HOST, 'Busy'), directive: 'font-src' },
      row('x.example', 'Calm'),
    ]);
    expect(lines.filter((line) => line.startsWith('Warning: Busy reached the cap'))).toHaveLength(1);
    expect(lines.some((line) => line.startsWith('Warning: Calm'))).toBe(false);
  });

  it('strips control characters from a site name and a host, in the warning too', () => {
    const name = 'Shop\u001b[2J\u0007\u202e\u2028\nname';
    const output = formatCspReportSummary([row('x\u001b[31m.example', name), row(OTHER_BLOCKED_HOST, name)]).join('\n');
    // Only the newlines and tabs this function writes itself may remain.
    expect(output.replace(/[\n\t]/g, '')).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    expect(output).toContain('Shop[2Jname');
    expect(output).toContain('x[31m.example');
  });
});

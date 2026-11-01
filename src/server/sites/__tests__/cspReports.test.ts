// The report endpoint's flow and what it keeps, with its dependencies faked. The
// real route against a real Postgres: src/app/api/csp-report/__tests__/route.itest.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CSP_REPORT_LIMITS,
  createCspReportDrops,
  createCspReportLimiter,
  handleCspReport,
  parseCspReport,
  type CspReportDeps,
} from '../cspReports';

const OWN = 'demo.sites.lumitra.co';

/** The body Chromium posts for a report-uri, with a visitor's data in the addresses. */
function chromiumReport(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    'csp-report': {
      'document-uri': 'https://demo.sites.lumitra.co/danke?email=a%40b.c',
      referrer: 'https://search.example/?q=name',
      'violated-directive': 'img-src',
      'effective-directive': 'img-src',
      'original-policy': "img-src 'self'",
      disposition: 'report',
      'blocked-uri': 'https://user:pass@Tracker.Example:8443/pixel.png?email=a%40b.c#x',
      'status-code': 200,
      'script-sample': '',
      ...over,
    },
  });
}

describe('parseCspReport', () => {
  it('keeps the directive and the host and port, and nothing else', () => {
    expect(parseCspReport(chromiumReport(), OWN)).toEqual({ directive: 'img-src', blockedHost: 'tracker.example:8443' });
  });

  it('reads a browser that only sends violated-directive, with the source list behind it', () => {
    const report = chromiumReport({ 'effective-directive': undefined, 'violated-directive': "font-src 'self' data:" });
    expect(parseCspReport(report, OWN)).toEqual({ directive: 'font-src', blockedHost: 'tracker.example:8443' });
  });

  it.each([
    ['not json', 'nonsense'],
    ['empty', ''],
    ['null', 'null'],
    ['a list', '[]'],
    ['no report', '{}'],
    ['a report that is a list', '{"csp-report":[]}'],
    ['a directive this policy does not hold', chromiumReport({ 'effective-directive': 'script-src' })],
    ['a directive that is no text', chromiumReport({ 'effective-directive': 7 })],
    ['no address', chromiumReport({ 'blocked-uri': undefined })],
    ['an address that is no text', chromiumReport({ 'blocked-uri': {} })],
    ['an address that is no address', chromiumReport({ 'blocked-uri': 'inline' })],
    ['another scheme', chromiumReport({ 'blocked-uri': 'chrome-extension://abc/x.png' })],
    ['a data address', chromiumReport({ 'blocked-uri': 'data:image/png;base64,AAAA' })],
    ['a host too long to be one', chromiumReport({ 'blocked-uri': `https://${'a.'.repeat(200)}example/x` })],
  ])('drops %s', (_name, text) => {
    expect(parseCspReport(text, OWN)).toBeNull();
  });

  const naming = (uri: string, directive = 'img-src') =>
    chromiumReport({ 'blocked-uri': uri, 'effective-directive': directive });

  it.each([
    ['an allowed host', naming('https://images.unsplash.com/photo?w=1')],
    ['the site itself', naming(`https://${OWN}/a.png`)],
    ['the site itself in capitals', naming(`https://${OWN.toUpperCase()}/a.png`)],
    ['the name of the row for replaced counts', naming('https://(other)/a.png')],
  ])('drops a report no browser sends: %s', (_name, text) => {
    expect(parseCspReport(text, OWN)).toBeNull();
  });

  it('compares the own host without a default port, and keeps another port', () => {
    expect(parseCspReport(naming(`https://${OWN}/a.png`), `${OWN}:443`)).toBeNull();
    expect(parseCspReport(naming(`https://${OWN}:8443/a.png`), OWN)).toEqual({ directive: 'img-src', blockedHost: `${OWN}:8443` });
  });

  it('keeps what a browser does report about an allowed host: plain http, or another directive', () => {
    expect(parseCspReport(naming('http://images.unsplash.com/a.png'), OWN)?.blockedHost).toBe('images.unsplash.com');
    expect(parseCspReport(naming('https://images.unsplash.com/a.woff2', 'font-src'), OWN)?.directive).toBe('font-src');
  });
});

describe('createCspReportDrops', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('logs the counts once a minute, then starts again, and stays quiet with nothing to say', () => {
    const log = vi.fn();
    const drops = createCspReportDrops(log);
    vi.advanceTimersByTime(120_000);
    expect(log).not.toHaveBeenCalled();

    drops.rateLimited();
    drops.rateLimited();
    drops.failed();
    vi.advanceTimersByTime(59_999);
    expect(log).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(log).toHaveBeenCalledExactlyOnceWith('[csp-report] last minute: 2 rate limited, 1 failed');

    vi.advanceTimersByTime(120_000);
    expect(log).toHaveBeenCalledTimes(1);
    drops.failed();
    vi.advanceTimersByTime(60_000);
    expect(log).toHaveBeenLastCalledWith('[csp-report] last minute: 0 rate limited, 1 failed');
  });
});

describe('createCspReportLimiter', () => {
  const limits = { ip: { max: 2, windowMs: 1000 }, everyone: { max: 3, windowMs: 1000 } };

  it('limits one address, then everyone, and a window ending frees both', () => {
    const limiter = createCspReportLimiter(limits);
    expect(limiter.hit('a', 0).ok).toBe(true);
    expect(limiter.hit('a', 0).ok).toBe(true);
    expect(limiter.hit('a', 0).ok).toBe(false);
    expect(limiter.hit('b', 0).ok).toBe(true);
    expect(limiter.hit('c', 0).ok).toBe(false);
    expect(limiter.hit('a', 1000).ok).toBe(true);
  });

  it('a report refused for its address does not use up the shared window', () => {
    const limiter = createCspReportLimiter(limits);
    limiter.hit('a', 0);
    limiter.hit('a', 0);
    for (let i = 0; i < 10; i += 1) limiter.hit('a', 0);
    expect(limiter.hit('b', 0).ok).toBe(true);
  });
});

describe('handleCspReport', () => {
  let store: ReturnType<typeof vi.fn<CspReportDeps['store']>>;
  let deps: CspReportDeps;

  const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
    new Request('https://demo.sites.lumitra.co/api/csp-report', {
      method: 'POST',
      headers: { host: 'demo.sites.lumitra.co', 'content-type': 'application/csp-report', ...headers },
      body,
    });

  beforeEach(() => {
    store = vi.fn<CspReportDeps['store']>().mockResolvedValue(undefined);
    deps = {
      resolveSiteId: vi.fn(async () => 'site-1'),
      store,
      limiter: createCspReportLimiter(),
      drops: { rateLimited: vi.fn(), failed: vi.fn() },
      now: () => 0,
    };
  });

  it('stores a report under the site the host names and answers 204 with no body', async () => {
    const res = await handleCspReport(post(chromiumReport()), deps);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(store).toHaveBeenCalledExactlyOnceWith('site-1', { directive: 'img-src', blockedHost: 'tracker.example:8443' });
  });

  it('drops a report naming the host it was posted to', async () => {
    const res = await handleCspReport(post(chromiumReport({ 'blocked-uri': `https://${OWN}/a.png` })), deps);
    expect(res.status).toBe(204);
    expect(store).not.toHaveBeenCalled();
  });

  it('answers junk with 204 and stores nothing', async () => {
    for (const body of ['nonsense', '', '{}', chromiumReport({ 'blocked-uri': 'eval' })]) {
      expect((await handleCspReport(post(body), deps)).status).toBe(204);
    }
    expect(store).not.toHaveBeenCalled();
  });

  it('answers 404 and stores nothing for a host with no published site', async () => {
    deps.resolveSiteId = async () => null;
    const res = await handleCspReport(post(chromiumReport()), deps);
    expect(res.status).toBe(404);
    expect(store).not.toHaveBeenCalled();
  });

  it('refuses a declared and an undeclared oversized body with 413', async () => {
    const huge = chromiumReport({ 'blocked-uri': `https://a.example/${'x'.repeat(CSP_REPORT_LIMITS.maxBodyBytes)}` });
    expect((await handleCspReport(post(huge), deps)).status).toBe(413);
    const undeclared = new Request('https://demo.sites.lumitra.co/api/csp-report', {
      method: 'POST',
      headers: { host: 'demo.sites.lumitra.co' },
      body: new Blob([huge]).stream(),
      duplex: 'half',
    } as RequestInit);
    expect((await handleCspReport(undeclared, deps)).status).toBe(413);
    expect(store).not.toHaveBeenCalled();
  });

  it('answers 429 with a retry time before resolving anything', async () => {
    deps.limiter = createCspReportLimiter({ ip: { max: 1, windowMs: 60_000 }, everyone: { max: 100, windowMs: 60_000 } });
    const headers = { 'x-forwarded-for': '203.0.113.9' };
    expect((await handleCspReport(post(chromiumReport(), headers), deps)).status).toBe(204);
    const resolve = vi.fn(async () => 'site-1');
    deps.resolveSiteId = resolve;
    const refused = await handleCspReport(post(chromiumReport(), headers), deps);
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('60');
    expect(resolve).not.toHaveBeenCalled();
    expect(deps.drops.rateLimited).toHaveBeenCalledTimes(1);
  });

  it('answers 500 when the write fails and logs the error, never the report', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    store.mockRejectedValue(new Error('database down'));
    const res = await handleCspReport(post(chromiumReport()), deps);
    expect(res.status).toBe(500);
    expect(deps.drops.failed).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(error.mock.calls)).not.toContain('a%40b.c');
    expect(JSON.stringify(await res.json())).not.toContain('tracker');
    error.mockRestore();
  });
});

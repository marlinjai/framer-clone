import { describe, expect, it } from 'vitest';
import {
  BOX_COMMON_HEADERS,
  BOX_DOCUMENT_POLICY,
  BOX_DOCUMENT_PREFIX,
  BOX_LIMITS,
  BOX_REFUSAL_POLICY,
} from '../../../src/lib/customCode/contract';
import type { BoxConfig } from '../src/config';
import { createBoxHandler, type BoxHandlerOptions, type BoxRequest, type BoxResponse } from '../src/handler';
import type { BoxRow, BoxStore } from '../src/store';

const SITE_A = '0b0e7c1a-5d2f-4c3b-9a8e-1f2d3c4b5a69';
const SITE_B = '7a1f3c55-0e2d-4b6a-8c9d-2e3f4a5b6c7d';
const HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);
const FRAME = { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'cross-site' };

const config: BoxConfig = {
  listenHost: '127.0.0.1',
  port: 0,
  databaseUrl: 'postgres://unused',
  editorHost: 'app.lumitra.co',
  sitesBaseHost: 'sites.lumitra.co',
  trustedProxies: [],
  abuseContact: 'abuse@lumitrausercontent.com',
  securityContact: 'security@lumitrausercontent.com',
  takedownUrl: null,
  securityTxtExpires: '2027-11-01T00:00:00Z',
};

class FakeStore implements BoxStore {
  rows = new Map<string, BoxRow>();
  finds = 0;
  pings = 0;
  failure: unknown = null;
  gate: Promise<void> | null = null;

  put(siteId: string, sha256: string, row: Partial<BoxRow> = {}) {
    this.rows.set(`${siteId}/${sha256}`, { document: '<p>hello</p>', live: true, subdomainLabels: ['shop'], customHostnames: ['www.example.com'], ...row });
  }
  async find(siteId: string, sha256: string) {
    this.finds += 1;
    if (this.gate) await this.gate;
    if (this.failure) throw this.failure;
    return this.rows.get(`${siteId}/${sha256}`) ?? null;
  }
  async ping() {
    this.pings += 1;
    if (this.failure) throw this.failure;
  }
  async close() {}
}

function setup(overrides: Partial<BoxHandlerOptions> = {}) {
  const store = new FakeStore();
  const clock = { now: 1_000_000 };
  const kill = { on: false };
  const handle = createBoxHandler({ config, store, killSwitchOn: () => kill.on, now: () => clock.now, ...overrides });
  const get = (url: string, headers: BoxRequest['headers'] = FRAME, extra: Partial<BoxRequest> = {}) =>
    handle({ method: 'GET', url, headers, remoteAddress: '203.0.113.7', ...extra });
  return { store, clock, kill, handle, get };
}

function expectRefusal(response: BoxResponse, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers['Content-Security-Policy']).toBe(BOX_REFUSAL_POLICY);
  expect(response.headers['Cache-Control']).toBe('no-store');
  expect(response.headers['Content-Type']).toBe('text/plain; charset=utf-8');
  for (const [name, value] of Object.entries(BOX_COMMON_HEADERS)) expect(response.headers[name]).toBe(value);
  expect(Object.keys(response.headers).map((name) => name.toLowerCase())).not.toContain('set-cookie');
  expect(response.headers['Content-Length']).toBe(String(response.body.length));
}

describe('a block', () => {
  it('is served to a cross-site frame, shell first, with the decided headers', async () => {
    const { store, get } = setup();
    store.put(SITE_A, HASH);
    const response = await get(`/box/${SITE_A}/${HASH}`);
    expect(response.status).toBe(200);
    expect(response.body.toString('utf8')).toBe(`${BOX_DOCUMENT_PREFIX}<p>hello</p>`);
    expect(response.headers).toEqual({
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': `${BOX_DOCUMENT_POLICY}; frame-ancestors https://shop.sites.lumitra.co https://www.example.com https://app.lumitra.co; report-uri https://app.lumitra.co/api/csp-report/box`,
      ...BOX_COMMON_HEADERS,
      'Cache-Control': 'private, max-age=300',
      Vary: 'Sec-Fetch-Dest, Sec-Fetch-Site',
      'Content-Length': String(response.body.length),
    });
    expect(response.siteId).toBe(SITE_A);
  });

  it('never names a branch preview host or a malformed host as an ancestor', async () => {
    const { store, get } = setup();
    store.put(SITE_A, HASH, {
      subdomainLabels: ['preview-abcdefghijklmnopqrstuvwxyz234567', '*', 'shop'],
      customHostnames: ['preview-x.sites.lumitra.co', '*.sites.lumitra.co', "evil.example; script-src 'unsafe-eval'", 'victim.sites.lumitra.co', 'ok.example.com'],
    });
    const response = await get(`/box/${SITE_A}/${HASH}`);
    expect(response.headers['Content-Security-Policy']).toContain(
      '; frame-ancestors https://shop.sites.lumitra.co https://ok.example.com https://app.lumitra.co; report-uri ',
    );
    expect(response.headers['Content-Security-Policy']).not.toContain('preview-');
    expect(response.headers['Content-Security-Policy']).not.toContain('victim');
    expect(response.headers['Content-Security-Policy']).not.toContain('*');
    expect(response.headers['Content-Security-Policy']).not.toContain('unsafe-eval');
  });

  it('with no host of its own can be framed by the editor host only', async () => {
    const { store, get } = setup();
    store.put(SITE_A, HASH, { subdomainLabels: null, customHostnames: 'www.example.com' });
    const response = await get(`/box/${SITE_A}/${HASH}`);
    expect(response.headers['Content-Security-Policy']).toContain('; frame-ancestors https://app.lumitra.co; report-uri ');
  });

  it('is refused to everything that is not a cross-site frame, before the database is asked', async () => {
    const { store, get } = setup();
    store.put(SITE_A, HASH);
    const cases: BoxRequest['headers'][] = [
      {},
      { 'sec-fetch-dest': 'iframe' },
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-dest': 'document', 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none' },
      { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'same-site' },
      { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'same-origin' },
      { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'none' },
      { 'sec-fetch-dest': 'iframe, iframe', 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-dest': ['iframe', 'document'], 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-dest': 'IFRAME', 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-dest': 'empty', 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-dest': 'script', 'sec-fetch-site': 'cross-site' },
    ];
    for (const headers of cases) expectRefusal(await get(`/box/${SITE_A}/${HASH}`, headers), 403);
    // A direct visit to a malformed address says no more than one to a real address.
    expectRefusal(await get('/box/anything', {}), 403);
    expect(store.finds).toBe(0);
  });

  it('answers 400 to any query string', async () => {
    const { store, get } = setup();
    store.put(SITE_A, HASH);
    for (const url of [`/box/${SITE_A}/${HASH}?`, `/box/${SITE_A}/${HASH}?x=1`, `/box/${SITE_A}/${HASH}?data=secret`, '/health?x', '/?x', '/health/db?x', '/.well-known/security.txt?x']) {
      expectRefusal(await get(url), 400);
    }
    expect(store.finds).toBe(0);
  });

  it('answers 404 to a malformed pair without asking the database', async () => {
    const { store, get } = setup();
    for (const url of [
      `/box/${SITE_A}/${'A'.repeat(64)}`,
      `/box/${SITE_A.toUpperCase()}/${HASH}`,
      `/box/${SITE_A}/${'a'.repeat(63)}`,
      `/box/${SITE_A}/${HASH}/`,
      `/box/${SITE_A}/${HASH}/x`,
      `/box/${SITE_A}`,
      '/box/',
      `/box/${SITE_A}/${'a'.repeat(63)}%61`,
      `/box/${SITE_A}%2f${HASH}`,
      `/box/../box/${SITE_A}/${HASH}`,
      `/box/${SITE_A}/${HASH};x`,
      `/box/' OR 1=1 --/${HASH}`.replace(/ /g, '%20'),
    ]) {
      const response = await get(url);
      expectRefusal(response, 404);
      expect(response.siteId).toBeNull();
    }
    expect(store.finds).toBe(0);
  });

  it('answers 404 to an unknown hash and to another site naming a real hash', async () => {
    const { store, get } = setup();
    store.put(SITE_A, HASH);
    expectRefusal(await get(`/box/${SITE_A}/${OTHER_HASH}`), 404);
    expectRefusal(await get(`/box/${SITE_B}/${HASH}`), 404);
    expect((await get(`/box/${SITE_A}/${HASH}`)).status).toBe(200);
  });

  it('answers 410 when the site is off or the blob is blocked, whatever `live` holds that is not true', async () => {
    const { store, get } = setup();
    const values: unknown[] = [false, null, undefined, 'true', 1, 't', {}];
    for (let i = 0; i < values.length; i++) {
      const hash = String(i).repeat(64);
      store.put(SITE_A, hash, { live: values[i] });
      expectRefusal(await get(`/box/${SITE_A}/${hash}`), 410);
    }
  });

  it('answers 410 to everything while the kill switch is on, without asking the database', async () => {
    const { store, kill, get } = setup();
    store.put(SITE_A, HASH);
    expect((await get(`/box/${SITE_A}/${HASH}`)).status).toBe(200);
    kill.on = true;
    // Also for what the cache already holds: the switch is read on every request.
    expectRefusal(await get(`/box/${SITE_A}/${HASH}`), 410);
    expectRefusal(await get(`/box/${SITE_A}/${OTHER_HASH}`), 410);
    expect(store.finds).toBe(1);
    kill.on = false;
    expect((await get(`/box/${SITE_A}/${HASH}`)).status).toBe(200);
  });

  it('refuses a row that is not text or is larger than a block may be', async () => {
    const { store, get } = setup();
    store.put(SITE_A, HASH, { document: 'x'.repeat(BOX_LIMITS.documentBytes + 1) });
    store.put(SITE_A, OTHER_HASH, { document: { toString: () => '<script>' } });
    store.put(SITE_B, HASH, { document: 'ü'.repeat(BOX_LIMITS.documentBytes / 2 + 1) });
    store.put(SITE_B, OTHER_HASH, { document: 'x'.repeat(BOX_LIMITS.documentBytes) });
    expectRefusal(await get(`/box/${SITE_A}/${HASH}`), 410);
    expectRefusal(await get(`/box/${SITE_A}/${OTHER_HASH}`), 410);
    expectRefusal(await get(`/box/${SITE_B}/${HASH}`), 410);
    expect((await get(`/box/${SITE_B}/${OTHER_HASH}`)).status).toBe(200);
  });

  it('serves a hostile document unchanged, behind the shell and under the same policy', async () => {
    const { store, get } = setup();
    const hostile = '</script><script>parent.location="https://evil.example"</script><meta http-equiv="Content-Security-Policy" content="default-src *"><iframe src="//evil.example">';
    store.put(SITE_A, HASH, { document: hostile });
    const response = await get(`/box/${SITE_A}/${HASH}`);
    expect(response.body.toString('utf8')).toBe(BOX_DOCUMENT_PREFIX + hostile);
    expect(response.headers['Content-Security-Policy']?.startsWith(`${BOX_DOCUMENT_POLICY}; frame-ancestors `)).toBe(true);
  });
});

describe('failure and recovery', () => {
  it('answers 503 without a word of the error, remembers nothing, and serves again when the database is back', async () => {
    const { store, get } = setup();
    store.put(SITE_A, HASH);
    store.failure = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432 role box_reader password hunter2'), { code: 'ECONNREFUSED' });
    const down = await get(`/box/${SITE_A}/${HASH}`);
    expectRefusal(down, 503);
    expect(down.headers['Retry-After']).toBe('5');
    expect(down.body.length).toBe(0);
    expect(JSON.stringify(down)).not.toContain('hunter2');
    expect(JSON.stringify(down)).not.toContain('10.0.0.5');
    store.failure = null;
    expect((await get(`/box/${SITE_A}/${HASH}`)).status).toBe(200);
  });

  it('reports the database health as one word', async () => {
    const { store, clock, get } = setup();
    expect((await get('/health/db', {})).body.toString()).toBe('ok');
    clock.now += 6000;
    store.failure = Object.assign(new Error('password authentication failed for user "box_reader"'), { code: '28P01' });
    const down = await get('/health/db', {});
    expectRefusal(down, 503);
    expect(down.body.toString()).toBe('unavailable: denied');
    clock.now += 6000;
    store.failure = null;
    expect((await get('/health/db', {})).status).toBe(200);
  });

  it('asks the database for its health at most once in five seconds', async () => {
    const { store, clock, get } = setup();
    for (let i = 0; i < 20; i++) await get('/health/db', {});
    expect(store.pings).toBe(1);
    clock.now += 5001;
    await get('/health/db', {});
    expect(store.pings).toBe(2);
  });

  it('asks the database once for many requests of one pair, and tells the overflow to come back', async () => {
    let open!: () => void;
    const { store, get } = setup({ maxPendingLookups: 2 });
    store.gate = new Promise<void>((resolve) => (open = resolve));
    store.put(SITE_A, HASH);
    const same = [get(`/box/${SITE_A}/${HASH}`), get(`/box/${SITE_A}/${HASH}`), get(`/box/${SITE_A}/${HASH}`)];
    const second = get(`/box/${SITE_A}/${OTHER_HASH}`);
    const third = await get(`/box/${SITE_B}/${HASH}`);
    expectRefusal(third, 503);
    open();
    expect((await Promise.all(same)).map((r) => r.status)).toEqual([200, 200, 200]);
    expect((await second).status).toBe(404);
    expect(store.finds).toBe(2);
  });

  it('a flood of unknown addresses pushes out other misses, never a document', async () => {
    const { store, get } = setup({ cacheMisses: 50 });
    store.put(SITE_A, HASH);
    expect((await get(`/box/${SITE_A}/${HASH}`)).status).toBe(200);
    const before = store.finds;
    for (let i = 0; i < 500; i++) {
      const hash = i.toString(16).padStart(64, '0');
      await get(`/box/${SITE_B}/${hash}`, FRAME, { remoteAddress: `198.51.${i >> 8}.${i & 255}` });
    }
    expect(store.finds).toBe(before + 500);
    // The document is still remembered: asking for it does not reach the database.
    expect((await get(`/box/${SITE_A}/${HASH}`, FRAME, { remoteAddress: '192.0.2.1' })).status).toBe(200);
    expect(store.finds).toBe(before + 500);
  });

  it('by default measures time with a clock that a step of the wall clock cannot move', async () => {
    const store = new FakeStore();
    store.put(SITE_A, HASH);
    const handle = createBoxHandler({ config, store, killSwitchOn: () => false, cacheTtlMs: 150 });
    const get = () => handle({ method: 'GET', url: `/box/${SITE_A}/${HASH}`, headers: FRAME, remoteAddress: '203.0.113.7' });
    const realNow = Date.now;
    try {
      expect((await get()).status).toBe(200);
      store.put(SITE_A, HASH, { live: false });
      // The wall clock goes back an hour: the remembered answer must still run out on time.
      Date.now = () => realNow() - 3_600_000;
      await new Promise((resolve) => setTimeout(resolve, 200));
      expectRefusal(await get(), 410);
    } finally {
      Date.now = realNow;
    }
  });

  it('remembers an answer for 60 seconds and then asks again, so a disabled block stops', async () => {
    const { store, clock, get } = setup();
    store.put(SITE_A, HASH);
    expect((await get(`/box/${SITE_A}/${HASH}`)).status).toBe(200);
    store.put(SITE_A, HASH, { live: false });
    clock.now += 59_000;
    expect((await get(`/box/${SITE_A}/${HASH}`)).status).toBe(200);
    clock.now += 2000;
    expectRefusal(await get(`/box/${SITE_A}/${HASH}`), 410);
    expect(store.finds).toBe(2);
  });
});

describe('rate limits', () => {
  it('answers 429 past 60 requests a minute for one path, before the database is asked again', async () => {
    const { store, clock, get } = setup();
    store.put(SITE_A, HASH);
    for (let i = 0; i < 60; i++) expect((await get(`/box/${SITE_A}/${HASH}`)).status).toBe(200);
    const limited = await get(`/box/${SITE_A}/${HASH}`);
    expectRefusal(limited, 429);
    expect(limited.headers['Retry-After']).toBe('60');
    // Another path of the same address still answers, and so does another address.
    expect((await get(`/box/${SITE_A}/${OTHER_HASH}`)).status).toBe(404);
    expect((await get(`/box/${SITE_A}/${HASH}`, FRAME, { remoteAddress: '203.0.113.8' })).status).toBe(200);
    // The 61st request never reached the database: one read for each of the two paths.
    expect(store.finds).toBe(2);
    clock.now += 60_000;
    expect((await get(`/box/${SITE_A}/${HASH}`)).status).toBe(200);
  });

  it('answers 429 past 600 requests a minute for one address, whatever it asks for', async () => {
    const { store, get } = setup();
    for (let i = 0; i < 600; i++) await get(`/box/${SITE_A}/${String(i % 10).repeat(64)}`);
    expectRefusal(await get(`/box/${SITE_A}/${HASH}`), 429);
    expectRefusal(await get('/health', {}), 429);
    expectRefusal(await get('/', {}), 429);
    expect(store.finds).toBeLessThanOrEqual(10);
  });

  it('does not believe X-Forwarded-For from a peer that is not a configured proxy', async () => {
    const { store, get } = setup();
    store.put(SITE_A, HASH);
    for (let i = 0; i < 60; i++) await get(`/box/${SITE_A}/${HASH}`, { ...FRAME, 'x-forwarded-for': `198.51.100.${i}` });
    expectRefusal(await get(`/box/${SITE_A}/${HASH}`, { ...FRAME, 'x-forwarded-for': '198.51.100.200' }), 429);
  });

  it('counts by the forwarded address when the peer is a configured proxy', async () => {
    const proxied: BoxConfig = { ...config, trustedProxies: [{ bytes: new Uint8Array([10, 0, 0, 0]), bits: 8 }] };
    const { store, handle } = setup({ config: proxied });
    store.put(SITE_A, HASH);
    const from = (forwarded: string) =>
      handle({ method: 'GET', url: `/box/${SITE_A}/${HASH}`, headers: { ...FRAME, 'x-forwarded-for': forwarded }, remoteAddress: '10.0.0.2' });
    for (let i = 0; i < 60; i++) expect((await from('198.51.100.1')).status).toBe(200);
    expectRefusal(await from('198.51.100.1'), 429);
    // A client cannot pick its own bucket by writing a first entry: only what the proxy appended counts.
    expectRefusal(await from('192.0.2.99, 198.51.100.1'), 429);
    expect((await from('198.51.100.2')).status).toBe(200);
    expect((await from('198.51.100.2')).logPrefix).toBe('198.51.100.0/24');
  });

  it('forgets the address used longest ago once it holds its bound, and no more', async () => {
    const { get } = setup({ rateLimitKeys: 100 });
    const from = (remoteAddress: string) => get('/nothing', {}, { remoteAddress });
    for (let i = 0; i < 600; i++) await from('203.0.113.50');
    expectRefusal(await from('203.0.113.50'), 429);
    // 99 other addresses: the limited one is still remembered, and still limited.
    for (let i = 0; i < 99; i++) await from(`198.51.100.${i}`);
    expectRefusal(await from('203.0.113.50'), 429);
    // 100 more push it out: the bound holds, so it starts again with a full bucket.
    for (let i = 0; i < 100; i++) await from(`192.0.2.${i}`);
    expectRefusal(await from('203.0.113.50'), 404);
  });

  it('a client behind a proxy cannot move into the proxy\'s own bucket with a long header', async () => {
    const proxied: BoxConfig = { ...config, trustedProxies: [{ bytes: new Uint8Array([10, 0, 0, 0]), bits: 8 }] };
    const { handle } = setup({ config: proxied });
    const from = (forwarded: string) => handle({ method: 'GET', url: '/health', headers: { 'x-forwarded-for': forwarded }, remoteAddress: '10.0.0.2' });
    // The client wrote 5,000 characters; the proxy appended the client's real address.
    const long = `${'1.1.1.1, '.repeat(600)}198.51.100.77`;
    expect((await from(long)).logPrefix).toBe('198.51.100.0/24');
    for (let i = 0; i < 599; i++) await from(long);
    expectRefusal(await from(long), 429);
    // The proxy's own bucket, and so every other visitor, is untouched.
    expect((await from('198.51.100.78')).status).toBe(200);
  });
});

describe('everything else', () => {
  it('answers health without fetch metadata and without the database', async () => {
    const { store, get } = setup();
    const response = await get('/health', {});
    expectRefusal(response, 200);
    expect(response.body.toString()).toBe('ok');
    expect(store.finds + store.pings).toBe(0);
  });

  it('says what the domain is, with the contacts, and no customer content', async () => {
    const { get } = setup();
    const response = await get('/', {});
    expectRefusal(response, 200);
    expect(response.body.toString()).toContain('sandboxed customer code for sites hosted by Lumitra');
    expect(response.body.toString()).toContain('Abuse: abuse@lumitrausercontent.com');
    const securityTxt = await get('/.well-known/security.txt', {});
    expectRefusal(securityTxt, 200);
    expect(securityTxt.body.toString()).toBe('Contact: mailto:security@lumitrausercontent.com\nExpires: 2027-11-01T00:00:00Z\n');
  });

  it('answers 404 for security.txt until a contact and an expiry are configured', async () => {
    const { get } = setup({ config: { ...config, securityTxtExpires: null } });
    expectRefusal(await get('/.well-known/security.txt', {}), 404);
  });

  it('answers 404 with no body to any other path', async () => {
    const { get } = setup();
    for (const url of ['/box', '/Box/x', '/favicon.ico', '/robots.txt', '/health/', '/health/db/', '/.env', '/api/commerce', '//', '/%2e%2e/health']) {
      const response = await get(url);
      expectRefusal(response, 404);
      expect(response.body.length).toBe(0);
    }
  });

  it('answers 405 to every other method, also on a real address', async () => {
    const { store, handle } = setup();
    store.put(SITE_A, HASH);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT', 'PROPFIND', 'get', undefined]) {
      const response = await handle({ method, url: `/box/${SITE_A}/${HASH}`, headers: FRAME, remoteAddress: '203.0.113.7' });
      expectRefusal(response, 405);
      expect(response.headers.Allow).toBe('GET, HEAD');
    }
    expect(store.finds).toBe(0);
  });

  it('answers HEAD as GET', async () => {
    const { store, handle } = setup();
    store.put(SITE_A, HASH);
    const response = await handle({ method: 'HEAD', url: `/box/${SITE_A}/${HASH}`, headers: FRAME, remoteAddress: '203.0.113.7' });
    expect(response.status).toBe(200);
    expect(response.headers['Content-Length']).toBe(String(Buffer.byteLength(`${BOX_DOCUMENT_PREFIX}<p>hello</p>`)));
  });

  it('answers 400 to a request target that is not a plain path', async () => {
    const { get } = setup();
    for (const url of [
      'http://run.example.com/health',
      '//evil.example/health',
      'health',
      '*',
      '',
      '/health#x',
      '/health\\x',
      '/hea lth',
      '/health\r\nX: y',
      '/héalth',
      `/${'a'.repeat(3000)}`,
      undefined,
    ]) {
      const response = await get(url as string, {});
      // `//evil.example/health` is a plain path to the box, and no path it knows.
      expectRefusal(response, url === '//evil.example/health' ? 404 : 400);
    }
  });

  it('never sets a cookie, on any status', async () => {
    const { store, kill, get, handle } = setup();
    store.put(SITE_A, HASH);
    const responses = [
      await get(`/box/${SITE_A}/${HASH}`),
      await get(`/box/${SITE_A}/${HASH}`, {}),
      await get(`/box/${SITE_A}/${HASH}?x`),
      await get(`/box/${SITE_A}/${OTHER_HASH}`),
      await get('/health', {}),
      await get('/health/db', {}),
      await get('/', {}),
      await get('/nothing', {}),
      await handle({ method: 'POST', url: '/', headers: {}, remoteAddress: '203.0.113.7' }),
    ];
    kill.on = true;
    responses.push(await get(`/box/${SITE_A}/${HASH}`));
    expect(responses.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 400, 403, 404, 404, 405, 410]);
    for (const response of responses) {
      expect(Object.keys(response.headers).map((name) => name.toLowerCase())).not.toContain('set-cookie');
    }
  });

  it('logs a site id only for a well-formed pair that came as a frame, and never a whole address', async () => {
    const { get } = setup();
    expect((await get(`/box/${SITE_A}/${OTHER_HASH}`)).siteId).toBe(SITE_A);
    expect((await get(`/box/${SITE_A}/${OTHER_HASH}`, {})).siteId).toBeNull();
    expect((await get('/box/secret-data-in-the-path/x')).siteId).toBeNull();
    expect((await get('/health', {})).logPrefix).toBe('203.0.113.0/24');
    expect((await get('/health', {}, { remoteAddress: '2001:db8:1:2:3:4:5:6' })).logPrefix).toBe('20010db80001::/48');
    // A request without a Host header is answered like any other: the box does not use the header.
    expectRefusal(await get('/health', {}), 200);
    expect((await get('/health', {}, { remoteAddress: undefined })).logPrefix).toBe('unknown');
  });
});

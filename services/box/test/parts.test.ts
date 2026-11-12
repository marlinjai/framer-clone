import { describe, expect, it } from 'vitest';
import { LookupCache } from '../src/cache';
import { clientAddressOf, parseAddress, parseCidr, type Cidr } from '../src/clientAddress';
import { ConfigError, isKillSwitchOn, readConfig } from '../src/config';
import { RateLimiter } from '../src/rateLimit';
import { storeFailureOf, withTimeout } from '../src/store';

describe('the rate limiter', () => {
  it('allows a burst of the capacity and gives tokens back over the window', () => {
    const limiter = new RateLimiter({ capacity: 3, windowMs: 3000, maxKeys: 10 });
    expect([limiter.take('a', 0), limiter.take('a', 0), limiter.take('a', 0), limiter.take('a', 0)]).toEqual([true, true, true, false]);
    expect(limiter.take('a', 999)).toBe(false);
    expect(limiter.take('a', 1000)).toBe(true);
    expect(limiter.take('a', 1000)).toBe(false);
    expect(limiter.take('b', 1000)).toBe(true);
  });

  it('never holds more keys than its bound, and forgets the one used longest ago', () => {
    const limiter = new RateLimiter({ capacity: 1, windowMs: 60_000, maxKeys: 3 });
    for (let i = 0; i < 10_000; i++) limiter.take(`k${i}`, i);
    expect(limiter.size).toBe(3);
    // k9999 was used last and is still out of tokens; k1 was forgotten long ago.
    expect(limiter.take('k9999', 10_000)).toBe(false);
    expect(limiter.take('k1', 10_000)).toBe(true);
  });

  it('is not confused by a clock that goes back', () => {
    const limiter = new RateLimiter({ capacity: 1, windowMs: 1000, maxKeys: 3 });
    expect(limiter.take('a', 5000)).toBe(true);
    expect(limiter.take('a', 1000)).toBe(false);
  });

  it('refuses options that would switch it off', () => {
    expect(() => new RateLimiter({ capacity: 0, windowMs: 1, maxKeys: 1 })).toThrow();
    expect(() => new RateLimiter({ capacity: 1, windowMs: 0, maxKeys: 1 })).toThrow();
    expect(() => new RateLimiter({ capacity: 1, windowMs: 1, maxKeys: 0 })).toThrow();
    expect(() => new RateLimiter({ capacity: Number.NaN, windowMs: 1, maxKeys: 1 })).toThrow();
  });
});

describe('the lookup cache', () => {
  const found = (bytes: number) => ({ kind: 'found' as const, live: true, body: Buffer.alloc(bytes), frameAncestorHosts: [] });

  it('forgets an entry after its time', () => {
    const cache = new LookupCache(1_000_000, 60_000);
    cache.set('a', { kind: 'missing' }, 0);
    expect(cache.get('a', 59_999)).toEqual({ kind: 'missing' });
    expect(cache.get('a', 60_000)).toBeUndefined();
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
  });

  it('stays within its byte budget, dropping the least recently used', () => {
    const cache = new LookupCache(100_000, 60_000);
    cache.set('a', found(30_000), 0);
    cache.set('b', found(30_000), 0);
    expect(cache.get('a', 1)).toBeDefined();
    cache.set('c', found(30_000), 2);
    expect(cache.get('b', 3)).toBeUndefined();
    expect(cache.get('a', 3)).toBeDefined();
    expect(cache.get('c', 3)).toBeDefined();
    for (let i = 0; i < 1000; i++) cache.set(`k${i}`, found(10_000), 4);
    expect(cache.bytes).toBeLessThanOrEqual(100_000);
  });

  it('does not keep an entry larger than the whole budget, and replaces an entry without counting it twice', () => {
    const cache = new LookupCache(50_000, 60_000);
    cache.set('big', found(60_000), 0);
    expect(cache.get('big', 0)).toBeUndefined();
    cache.set('a', found(10_000), 0);
    const once = cache.bytes;
    cache.set('a', found(10_000), 0);
    expect(cache.bytes).toBe(once);
  });

  it('keeps misses apart from documents, bounded by their number', () => {
    const cache = new LookupCache(100_000, 60_000, 10);
    cache.set('doc', found(50_000), 0);
    for (let i = 0; i < 10_000; i++) cache.set(`miss${i}`, { kind: 'missing' }, 0);
    expect(cache.missCount).toBe(10);
    expect(cache.get('doc', 1)).toBeDefined();
    expect(cache.get('miss9999', 1)).toEqual({ kind: 'missing' });
    expect(cache.get('miss0', 1)).toBeUndefined();
    // A pair that was missing and now exists is a document, not both.
    cache.set('miss9999', found(10), 2);
    expect(cache.get('miss9999', 3)).toMatchObject({ kind: 'found' });
    expect(cache.missCount).toBe(9);
  });

  it('keeps upper and lower case keys apart', () => {
    const cache = new LookupCache(1_000_000, 60_000);
    cache.set('site/abc', { kind: 'missing' }, 0);
    expect(cache.get('site/ABC', 0)).toBeUndefined();
  });
});

describe('addresses', () => {
  it('reads IPv4, IPv6 and an IPv4 address mapped into IPv6', () => {
    expect([...parseAddress('203.0.113.7')!]).toEqual([203, 0, 113, 7]);
    expect([...parseAddress('::ffff:203.0.113.7')!]).toEqual([203, 0, 113, 7]);
    expect(parseAddress('2001:db8::1')).toHaveLength(16);
    expect(parseAddress('::')).toHaveLength(16);
    // A dotted tail is allowed only as the very end of the address.
    expect(parseAddress('64:ff9b::192.0.2.1')).toHaveLength(16);
    expect(parseAddress('1:2:3:4:5:6:1.2.3.4')).toHaveLength(16);
  });

  it.each([
    '', ' ', '1.2.3', '1.2.3.4.5', '256.1.1.1', '01.2.3.4', '1.2.3.4 ', '1.2.3.4:80', '[::1]', '::1%eth0', ':::', '1::2::3',
    '12345::', 'g::1', '1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7', 'example.com', '0x7f.0.0.1', '1.2.3.4, 5.6.7.8',
    '1.2.3.4::', '1:1.2.3.4::5', '1.2.3.4::5.6.7.8', '::1.2.3.4:5', '1.2.3.4:5::',
  ])('refuses %j', (text) => {
    expect(parseAddress(text)).toBeNull();
  });

  it('reads a network and refuses a malformed one', () => {
    expect(parseCidr('10.0.0.0/8')).toEqual({ bytes: new Uint8Array([10, 0, 0, 0]), bits: 8 });
    expect(parseCidr('10.0.0.5')?.bits).toBe(32);
    expect(parseCidr('fd00::/8')?.bits).toBe(8);
    for (const text of ['10.0.0.0/33', '10.0.0.0/', '10.0.0.0/-1', '10.0.0.0/08', 'fd00::/129', 'x/8', '/8']) expect(parseCidr(text)).toBeNull();
  });

  const proxies: Cidr[] = [parseCidr('10.0.0.0/8')!, parseCidr('fd00::/8')!];

  it('uses the socket address unless the peer is a configured proxy', () => {
    expect(clientAddressOf('203.0.113.7', '198.51.100.1', []).key).toBe('4:203.0.113.7');
    expect(clientAddressOf('203.0.113.7', '198.51.100.1', proxies).key).toBe('4:203.0.113.7');
    expect(clientAddressOf('10.1.2.3', '198.51.100.1', proxies).key).toBe('4:198.51.100.1');
    expect(clientAddressOf('::ffff:10.1.2.3', '198.51.100.1', proxies).key).toBe('4:198.51.100.1');
  });

  it('reads X-Forwarded-For from the right, past configured proxies only', () => {
    expect(clientAddressOf('10.1.2.3', '192.0.2.1, 198.51.100.1', proxies).key).toBe('4:198.51.100.1');
    expect(clientAddressOf('10.1.2.3', '192.0.2.1, 198.51.100.1, 10.9.9.9', proxies).key).toBe('4:198.51.100.1');
    // A hop that is not an address, an empty header, only proxies: the peer itself.
    expect(clientAddressOf('10.1.2.3', '198.51.100.1, garbage', proxies).key).toBe('4:10.1.2.3');
    expect(clientAddressOf('10.1.2.3', '', proxies).key).toBe('4:10.1.2.3');
    expect(clientAddressOf('10.1.2.3', undefined, proxies).key).toBe('4:10.1.2.3');
    expect(clientAddressOf('10.1.2.3', ['198.51.100.1'], proxies).key).toBe('4:10.1.2.3');
    expect(clientAddressOf('10.1.2.3', '10.4.4.4, 10.5.5.5', proxies).key).toBe('4:10.1.2.3');
    // A header of any length: only its end is read, so what the proxy appended still counts.
    expect(clientAddressOf('10.1.2.3', `${'1.1.1.1, '.repeat(2000)}198.51.100.1`, proxies).key).toBe('4:198.51.100.1');
    expect(clientAddressOf('10.1.2.3', `${'x'.repeat(5000)}, 198.51.100.1`, proxies).key).toBe('4:198.51.100.1');
    // A cut header whose only whole hops are proxies, or whose first piece is a fragment: the peer.
    expect(clientAddressOf('10.1.2.3', `${'9'.repeat(300)}`, proxies).key).toBe('4:10.1.2.3');
  });

  it('counts an IPv6 client by its /64 and logs a prefix only', () => {
    const a = clientAddressOf('2001:db8:1:2:aaaa::1', undefined, []);
    const b = clientAddressOf('2001:db8:1:2:bbbb::2', undefined, []);
    expect(a.key).toBe(b.key);
    expect(a.logPrefix).toBe('20010db80001::/48');
    expect(clientAddressOf('203.0.113.7', undefined, []).logPrefix).toBe('203.0.113.0/24');
  });

  it('puts every unreadable address into one limited bucket', () => {
    expect(clientAddressOf(undefined, undefined, proxies)).toEqual({ key: 'unknown', logPrefix: 'unknown' });
    expect(clientAddressOf('not an address', undefined, proxies).key).toBe('unknown');
  });
});

describe('the configuration', () => {
  const env = {
    BOX_DATABASE_URL: 'postgres://box_reader@db.internal:5432/app',
    BOX_EDITOR_HOST: 'app.lumitra.co',
    BOX_SITES_BASE_HOST: 'sites.lumitra.co',
  };

  it('reads a complete configuration', () => {
    const config = readConfig({ ...env, BOX_TRUSTED_PROXIES: '10.0.1.0/24, fd00::/64', BOX_PORT: '9000', BOX_ABUSE_CONTACT: 'abuse@example.com' });
    expect(config.port).toBe(9000);
    expect(config.trustedProxies).toHaveLength(2);
    expect(config.abuseContact).toBe('abuse@example.com');
    expect(config.securityContact).toBeNull();
    expect(readConfig(env).port).toBe(8080);
    expect(readConfig(env).trustedProxies).toEqual([]);
  });

  it.each([
    ['no database', { ...env, BOX_DATABASE_URL: undefined }],
    ['an empty database', { ...env, BOX_DATABASE_URL: '' }],
    ['a database that is not Postgres', { ...env, BOX_DATABASE_URL: 'mysql://x' }],
    ['a database that is not an address', { ...env, BOX_DATABASE_URL: 'box_reader' }],
    ['no editor host', { ...env, BOX_EDITOR_HOST: undefined }],
    ['an editor host with a scheme', { ...env, BOX_EDITOR_HOST: 'https://app.lumitra.co' }],
    ['a wildcard editor host', { ...env, BOX_EDITOR_HOST: '*.lumitra.co' }],
    ['an editor host that adds a directive', { ...env, BOX_EDITOR_HOST: 'app.lumitra.co; sandbox allow-same-origin' }],
    ['no sites base host', { ...env, BOX_SITES_BASE_HOST: undefined }],
    ['a sites base host with a port', { ...env, BOX_SITES_BASE_HOST: 'sites.lumitra.co:443' }],
    ['a port that is not a number', { ...env, BOX_PORT: '80a' }],
    ['a port out of range', { ...env, BOX_PORT: '70000' }],
    ['a proxy that is not a network', { ...env, BOX_TRUSTED_PROXIES: 'traefik' }],
    ['a proxy network that is everyone', { ...env, BOX_TRUSTED_PROXIES: '0.0.0.0/0' }],
    ['a listen host that is a name', { ...env, BOX_LISTEN_HOST: 'localhost' }],
    ['an abuse contact that is not an address', { ...env, BOX_ABUSE_CONTACT: 'abuse@example.com\nX: y' }],
    ['a takedown address without https', { ...env, BOX_TAKEDOWN_URL: 'http://example.com/takedown' }],
    ['a takedown address with a script', { ...env, BOX_TAKEDOWN_URL: 'javascript:alert(1)' }],
    ['an expiry that is not a date', { ...env, BOX_SECURITY_TXT_EXPIRES: 'next year' }],
  ])('refuses %s, naming the variable and never its value', (_name, bad) => {
    let message = '';
    try {
      readConfig(bad);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      message = (error as Error).message;
    }
    expect(message).toMatch(/^BOX_[A-Z_]+ /);
    for (const value of Object.values(bad)) {
      if (value) expect(message).not.toContain(value);
    }
  });

  it('keeps the kill switch on unless it is exactly 0 (D16)', () => {
    expect(isKillSwitchOn({ CUSTOM_CODE_DISABLED: '0' })).toBe(false);
    for (const value of [undefined, '', '1', 'true', 'false', 'no', 'off', ' 0', '0 ', '00', 'O']) {
      expect(isKillSwitchOn({ CUSTOM_CODE_DISABLED: value })).toBe(true);
    }
  });
});

describe('store failures', () => {
  it('are one of four words', () => {
    expect(storeFailureOf(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe('connect');
    expect(storeFailureOf(Object.assign(new Error('x'), { code: 'CONNECTION_CLOSED' }))).toBe('connect');
    expect(storeFailureOf(Object.assign(new Error('x'), { code: '57P01' }))).toBe('connect');
    expect(storeFailureOf(Object.assign(new Error('x'), { code: 'CONNECT_TIMEOUT' }))).toBe('timeout');
    expect(storeFailureOf(Object.assign(new Error('x'), { code: '57014' }))).toBe('timeout');
    expect(storeFailureOf(Object.assign(new Error('x'), { code: '28P01' }))).toBe('denied');
    expect(storeFailureOf(Object.assign(new Error('x'), { code: '42501' }))).toBe('denied');
    expect(storeFailureOf(new Error('anything'))).toBe('query');
    expect(storeFailureOf('text')).toBe('query');
    expect(storeFailureOf(null)).toBe('query');
  });

  it('a database that never answers is given up on', async () => {
    let cancelled = 0;
    await expect(withTimeout(new Promise(() => {}), 20, () => (cancelled += 1))).rejects.toMatchObject({ code: 'BOX_TIMEOUT' });
    expect(cancelled).toBe(1);
    // A cancel that itself fails does not change the answer, and an answer in time cancels nothing.
    await expect(withTimeout(new Promise(() => {}), 20, () => { throw new Error('no'); })).rejects.toMatchObject({ code: 'BOX_TIMEOUT' });
    await expect(withTimeout(Promise.resolve(7), 20, () => (cancelled += 1))).resolves.toBe(7);
    expect(cancelled).toBe(1);
    await expect(withTimeout(Promise.resolve(7), 20)).resolves.toBe(7);
    await expect(withTimeout(Promise.reject(new Error('no')), 20)).rejects.toThrow('no');
  });
});

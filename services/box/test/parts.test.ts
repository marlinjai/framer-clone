import { describe, expect, it } from 'vitest';
import { LookupCache } from '../src/cache';
import { clientAddressOf, parseAddress, parseCidr, type Cidr } from '../src/clientAddress';
import { ConfigError, isKillSwitchOn, readConfig } from '../src/config';
import { RateLimiter } from '../src/rateLimit';
import { createServer, type Socket } from 'node:net';
import { DatabaseUrlError, parseDatabaseUrl } from '../src/databaseUrl';
import { createPostgresStore, openPostgresPool, storeFailureOf, withTimeout, type BoxPool, type BoxRow } from '../src/store';

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

  it('reads a hop written with brackets or a port', () => {
    expect(clientAddressOf('10.1.2.3', '198.51.100.1:51234', proxies).key).toBe('4:198.51.100.1');
    expect(clientAddressOf('10.1.2.3', '[2001:db8::1]', proxies).key).toBe(clientAddressOf('2001:db8::1', undefined, []).key);
    expect(clientAddressOf('10.1.2.3', '[2001:db8::1]:443', proxies).key).toBe(clientAddressOf('2001:db8::1', undefined, []).key);
    // Still not an address: the peer.
    expect(clientAddressOf('10.1.2.3', '198.51.100.1:port', proxies).key).toBe('4:10.1.2.3');
    expect(clientAddressOf('10.1.2.3', '[198.51.100.1', proxies).key).toBe('4:10.1.2.3');
  });

  it('counts an IPv6 client by its /56 and logs a prefix only', () => {
    const a = clientAddressOf('2001:db8:1:200:aaaa::1', undefined, []);
    const b = clientAddressOf('2001:db8:1:2ff:bbbb::2', undefined, []);
    expect(a.key).toBe(b.key);
    expect(clientAddressOf('2001:db8:1:300::1', undefined, []).key).not.toBe(a.key);
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
    ['a database address with two hosts', { ...env, BOX_DATABASE_URL: 'postgres://box_reader@db1,db2/app' }],
    ['a database address with an escaped second host', { ...env, BOX_DATABASE_URL: 'postgres://box_reader@db%2cevil/app' }],
    ['a database address with a bracketed address', { ...env, BOX_DATABASE_URL: 'postgres://box_reader@[fd00::5]:5432/app' }],
    ['a database address with a malformed escape', { ...env, BOX_DATABASE_URL: 'postgres://box_reader:a%zzb@db.internal/app' }],
    ['a database address with an unknown sslmode', { ...env, BOX_DATABASE_URL: 'postgres://box_reader@db.internal/app?sslmode=bogus' }],
    ['a database address with an sslmode that only prefers', { ...env, BOX_DATABASE_URL: 'postgres://box_reader@db.internal/app?sslmode=prefer' }],
    // Encryption is not built in this version (D23): asking for it is refused, never half honoured.
    ['a database address that asks for an unchecked certificate', { ...env, BOX_DATABASE_URL: 'postgres://box_reader@db.internal/app?sslmode=require' }],
    ['a database address that asks for a checked certificate', { ...env, BOX_DATABASE_URL: 'postgres://box_reader@10.0.0.5/app?sslmode=verify-full' }],
    ['a database name that adds a startup parameter', { ...env, BOX_DATABASE_URL: 'postgres://box_reader@db.internal/app%00search_path%00evil' }],
    ['a role that adds a startup parameter', { ...env, BOX_DATABASE_URL: 'postgres://box%00statement_timeout%000@db.internal/app' }],
    ['a password with a line break', { ...env, BOX_DATABASE_URL: 'postgres://box_reader:a%0Ab@db.internal/app' }],
    ['a database address with sslmode twice', { ...env, BOX_DATABASE_URL: 'postgres://box_reader@db.internal/app?sslmode=verify-full&sslmode=disable' }],
    ['a database address that lifts the statement timeout', { ...env, BOX_DATABASE_URL: 'postgres://box_reader@db.internal/app?statement_timeout=0' }],
    ['a database address with an ssl parameter', { ...env, BOX_DATABASE_URL: 'postgres://box_reader@db.internal/app?ssl=false' }],
    ['a database address without a role', { ...env, BOX_DATABASE_URL: 'postgres://db.internal/app' }],
    ['a database address without a database', { ...env, BOX_DATABASE_URL: 'postgres://box_reader@db.internal' }],
    ['an editor host that is a branch preview host', { ...env, BOX_EDITOR_HOST: 'preview-abcdefghijklmnopqrstuvwxyz234567.sites.lumitra.co' }],
    ['a sites base host that is a branch preview host', { ...env, BOX_SITES_BASE_HOST: 'preview-x.lumitra.co' }],
    ['an expiry on a day that does not exist', { ...env, BOX_SECURITY_TXT_EXPIRES: '2027-02-30T00:00:00Z' }],
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

  it('reads the database address into the parts the driver is given', () => {
    expect(parseDatabaseUrl('postgres://box_reader:p%40ss@db.internal:6543/app?sslmode=disable')).toEqual({
      host: 'db.internal', port: 6543, database: 'app', username: 'box_reader', password: 'p@ss',
    });
    expect(parseDatabaseUrl('postgresql://box_reader@10.0.0.5/app')).toMatchObject({ host: '10.0.0.5', port: 5432 });
    // Names as a private network gives them: any case, a closing dot, an underscore.
    expect(parseDatabaseUrl('postgres://box_reader@DB.Internal./app').host).toBe('db.internal');
    expect(parseDatabaseUrl('postgres://box_reader@framer_clone_db/app').host).toBe('framer_clone_db');
    for (const hostile of ['postgres://box_reader:secret-value@db%2cevil/app', 'postgres://box_reader:secret-value@db/app%00search_path%00evil']) {
      let message = '';
      try {
        parseDatabaseUrl(hostile);
      } catch (error) {
        expect(error).toBeInstanceOf(DatabaseUrlError);
        message = (error as Error).message;
      }
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toMatch(/secret-value|evil|box_reader|search_path/);
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
    expect(storeFailureOf(Object.assign(new Error('x'), { code: 'CONNECTION_PAUSED' }))).toBe('connect');
    expect(storeFailureOf(Object.assign(new Error('x'), { code: 'ERR_SOCKET_CLOSED' }))).toBe('connect');
    expect(storeFailureOf(Object.assign(new Error('x'), { code: '57P01' }))).toBe('connect');
    expect(storeFailureOf(Object.assign(new Error('x'), { code: 'CONNECT_TIMEOUT' }))).toBe('timeout');
    expect(storeFailureOf(Object.assign(new Error('x'), { code: '57014' }))).toBe('timeout');
    expect(storeFailureOf(Object.assign(new Error('x'), { code: '28P01' }))).toBe('denied');
    expect(storeFailureOf(Object.assign(new Error('x'), { code: '42501' }))).toBe('denied');
    expect(storeFailureOf(new Error('anything'))).toBe('query');
    expect(storeFailureOf('text')).toBe('query');
    expect(storeFailureOf(null)).toBe('query');
  });

  describe('against a listener that goes silent', () => {
    it.each([
      ['before it says anything', false],
      ['after it let the box log in', true],
    ])('%s: gives up after the timeout, closes the silent connections for real, and starts on fresh ones', async (_when, logsIn) => {
      const sockets: Socket[] = [];
      // Takes what is sent and answers nothing, not even the other end's goodbye: a client that only
      // asks to close (a half close) keeps its socket for ever against this listener. Only a client
      // that destroys its socket lets go of it.
      const server = createServer({ allowHalfOpen: true }, (socket) => {
        sockets.push(socket);
        socket.on('error', () => {});
        if (logsIn) {
          // The least a Postgres says to let a client in: "authentication ok", then "ready for query".
          socket.once('data', () => socket.write(Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0, 0x5a, 0, 0, 0, 5, 0x49])));
        }
        socket.resume();
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      const stray: unknown[] = [];
      const onStray = (reason: unknown) => stray.push(reason);
      process.on('unhandledRejection', onStray);
      const store = createPostgresStore(`postgres://box_reader@127.0.0.1:${port}/app`, { queryTimeoutMs: 300, connectTimeoutMs: 250 });
      try {
        const started = Date.now();
        await expect(store.find('0b0e7c1a-5d2f-4c3b-9a8e-1f2d3c4b5a69', 'a'.repeat(64))).rejects.toMatchObject({ code: 'BOX_TIMEOUT' });
        expect(Date.now() - started).toBeLessThan(2000);
        // Five more calls, one after the other. A pool that kept its silent connections would stop at
        // its two and never open another; a pool that is replaced opens a fresh one each time.
        for (let i = 0; i < 5; i++) {
          await expect(store.ping()).rejects.toMatchObject({ code: 'BOX_TIMEOUT' });
        }
        expect(sockets.length).toBeGreaterThanOrEqual(6);
        // The listener never closes a connection by itself. It now writes to each one: a socket the box
        // destroyed answers with a reset, which closes the listener's end; a socket the box only asked
        // to close (and so still holds) takes the bytes and stays. At most the current pool's are left.
        await new Promise((resolve) => setTimeout(resolve, 200));
        for (const socket of sockets) if (!socket.destroyed) socket.write('x');
        await new Promise((resolve) => setTimeout(resolve, 200));
        for (const socket of sockets) if (!socket.destroyed) socket.write('x');
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(sockets.filter((socket) => !socket.destroyed).length).toBeLessThanOrEqual(2);
        expect(stray).toEqual([]);
      } finally {
        await store.close().catch(() => {});
        process.off('unhandledRejection', onStray);
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it('a refused connection is a failure the caller sees, not a stray one', async () => {
      const stray: unknown[] = [];
      const onStray = (reason: unknown) => stray.push(reason);
      process.on('unhandledRejection', onStray);
      // A port nothing listens on.
      const probe = createServer();
      await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
      const port = (probe.address() as { port: number }).port;
      await new Promise((resolve) => probe.close(resolve));
      const store = createPostgresStore(`postgres://box_reader@127.0.0.1:${port}/app`, { queryTimeoutMs: 2000 });
      try {
        // Six calls in a row: each one is refused as itself, quickly. None is left waiting on a
        // connection that never came (which would end as a timeout, three seconds later).
        for (let i = 0; i < 6; i++) {
          const started = Date.now();
          const failure = await store.find('0b0e7c1a-5d2f-4c3b-9a8e-1f2d3c4b5a69', 'a'.repeat(64)).then(() => null, (error: unknown) => error);
          expect(storeFailureOf(failure)).toBe('connect');
          expect(failure).not.toMatchObject({ code: 'BOX_TIMEOUT' });
          expect(Date.now() - started).toBeLessThan(1500);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(stray).toEqual([]);
      } finally {
        await store.close().catch(() => {});
        process.off('unhandledRejection', onStray);
      }
    });

    it('a listener that accepts and hangs up does not become hundreds of connections', async () => {
      let accepted = 0;
      const server = createServer((socket) => {
        accepted += 1;
        socket.on('error', () => {});
        socket.destroy();
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      const store = createPostgresStore(`postgres://box_reader@127.0.0.1:${port}/app`, { queryTimeoutMs: 1500 });
      try {
        await store.ping().catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 1000));
        // Each connection that did not last makes the next one wait longer: a handful, not hundreds.
        expect(accepted).toBeGreaterThanOrEqual(1);
        expect(accepted).toBeLessThanOrEqual(12);
      } finally {
        await store.close().catch(() => {});
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it('after a connection that did not last, new calls fail at once and open nothing until the pause is over', async () => {
      let accepted = 0;
      const server = createServer((socket) => {
        accepted += 1;
        socket.on('error', () => {});
        socket.destroy();
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      const pool = openPostgresPool(parseDatabaseUrl(`postgres://box_reader@127.0.0.1:${port}/app`), 500);
      const outcome = () => Promise.resolve().then(() => pool.ping()).then(() => 'answered', (error: { code?: string }) => error.code);
      try {
        expect(await outcome()).not.toBe('answered');
        // Straight after a connection that did not last (a moment for its close to be noticed, well
        // inside the first pause of 100 milliseconds): five calls at once.
        await new Promise((resolve) => setTimeout(resolve, 20));
        const before = accepted;
        const started = Date.now();
        const results = await Promise.all([outcome(), outcome(), outcome(), outcome(), outcome()]);
        expect(Date.now() - started).toBeLessThan(60);
        expect(results).toEqual(Array.from({ length: 5 }, () => 'CONNECTION_PAUSED'));
        expect(accepted).toBe(before);
        // And once the pause is over, a call opens a connection again.
        await new Promise((resolve) => setTimeout(resolve, 2200));
        await outcome();
        expect(accepted).toBeGreaterThan(before);
      } finally {
        pool.destroy();
        await new Promise((resolve) => server.close(resolve));
      }
    }, 15_000);

    it('the pause doubles from its first length and stops growing at its longest', async () => {
      let accepted = 0;
      const server = createServer((socket) => {
        accepted += 1;
        socket.on('error', () => {});
        socket.destroy();
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      // Pauses of 40, 80, 160, 160, ... milliseconds, with a call every 5 milliseconds for 1.5 seconds.
      const pool = openPostgresPool(parseDatabaseUrl(`postgres://box_reader@127.0.0.1:${port}/app`), 500, { firstMs: 40, maxMs: 160 });
      const calls = setInterval(() => void Promise.resolve().then(() => pool.ping()).catch(() => {}), 5);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      } finally {
        clearInterval(calls);
        pool.destroy();
        await new Promise((resolve) => server.close(resolve));
      }
      // About ten connections. A pause stuck at its first length would give more than thirty, one
      // that never stopped doubling five or six.
      expect(accepted).toBeGreaterThanOrEqual(8);
      expect(accepted).toBeLessThanOrEqual(16);
    });

    it('an address nothing can be connected to fails as a connection failure and ends no process', async () => {
      // Port 0 cannot be connected to: the socket's own error must have a listener.
      const store = createPostgresStore('postgres://box_reader@127.0.0.1:0/app', { queryTimeoutMs: 1000 });
      try {
        const failure = await store.ping().then(() => null, (error: unknown) => error);
        expect(storeFailureOf(failure)).toBe('connect');
      } finally {
        await store.close().catch(() => {});
      }
    });

    describe('against a fake database that answers', () => {
      // The least of a Postgres that answers: it lets the box log in, and answers every statement
      // with an error of its own ("42883") and "ready for query". For the store that error is an
      // answer of the database, which is all these tests need to tell "answered" from "failed".
      const READY = Buffer.from([0x5a, 0, 0, 0, 5, 0x49]);
      const LOGGED_IN = Buffer.concat([Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0]), READY]);
      const ANSWER = (() => {
        const fields = Buffer.from('SERROR\0C42883\0Mno such function\0\0', 'latin1');
        const head = Buffer.alloc(5);
        head[0] = 0x45;
        head.writeInt32BE(4 + fields.length, 1);
        return Buffer.concat([head, fields, READY]);
      })();

      /** `fate(n)` says what happens to the n-th connection: it is answered, or hung up on at once. */
      async function fakeDatabase(fate: (n: number) => 'answer' | 'hang up') {
        const state = { accepted: 0 };
        const open = new Set<Socket>();
        const server = createServer((socket) => {
          state.accepted += 1;
          socket.on('error', () => {});
          if (fate(state.accepted) === 'hang up') {
            socket.destroy();
            return;
          }
          open.add(socket);
          socket.on('close', () => open.delete(socket));
          let loggedIn = false;
          socket.on('data', (chunk: Buffer) => {
            if (!loggedIn) {
              loggedIn = true;
              socket.write(LOGGED_IN);
              return;
            }
            // One answer for each statement the driver parses ('P').
            for (let i = 0; i + 4 < chunk.length; i += 1 + chunk.readInt32BE(i + 1)) {
              if (chunk[i] === 0x50) socket.write(ANSWER);
            }
          });
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        return {
          state,
          target: parseDatabaseUrl(`postgres://box_reader@127.0.0.1:${(server.address() as { port: number }).port}/app`),
          close: async () => {
            for (const socket of open) socket.destroy();
            await new Promise((resolve) => server.close(resolve));
          },
        };
      }

      /** What became of one call: 'answered', the code it failed with, or 'still waiting' after `ms`. */
      const outcomeOf = (pool: BoxPool, ms = 1500) =>
        Promise.race([
          Promise.resolve()
            .then(() => pool.ping())
            .then(
              () => 'answered',
              (error: { name?: string; code?: string }) => (error.name === 'PostgresError' && error.code === '42883' ? 'answered' : (error.code ?? 'failed')),
            ),
          new Promise<string>((resolve) => setTimeout(() => resolve('still waiting'), ms)),
        ]);

      it('a call on a healthy database is answered, on one connection', async () => {
        const database = await fakeDatabase(() => 'answer');
        const pool = openPostgresPool(database.target, 500);
        try {
          expect(await Promise.all([outcomeOf(pool), outcomeOf(pool), outcomeOf(pool), outcomeOf(pool)])).toEqual(['answered', 'answered', 'answered', 'answered']);
          expect(database.state.accepted).toBe(1);
        } finally {
          pool.destroy();
          await database.close();
        }
      });

      it('after one hang-up the call fails quickly, and the next connection is opened when the first pause is over, not later', async () => {
        // The first connection is hung up on; every later one is answered.
        const database = await fakeDatabase((n) => (n === 1 ? 'hang up' : 'answer'));
        const pool = openPostgresPool(database.target, 500, { firstMs: 300, maxMs: 2000 });
        try {
          const started = Date.now();
          // The call that met the hang-up is told so, quickly: the driver tries it again on a socket
          // the box does not open (the pause has begun), and that socket is closed with an error.
          const first = await outcomeOf(pool, 1000);
          expect(first).not.toBe('answered');
          expect(first).not.toBe('still waiting');
          expect(Date.now() - started).toBeLessThan(250);
          // Inside the pause nothing is opened.
          expect(await outcomeOf(pool)).toBe('CONNECTION_PAUSED');
          expect(database.state.accepted).toBe(1);
          // 400 ms after the hang-up: past the first pause of 300 ms, well before the 600 ms a pause
          // started a second time would last. The database is asked again, and answers.
          await new Promise((resolve) => setTimeout(resolve, 400 - (Date.now() - started)));
          expect(await outcomeOf(pool)).toBe('answered');
          expect(database.state.accepted).toBe(2);
          // And it stays well: many calls, all answered, no further connection.
          const later = await Promise.all(Array.from({ length: 20 }, () => outcomeOf(pool)));
          expect(new Set(later)).toEqual(new Set(['answered']));
          expect(database.state.accepted).toBe(2);
        } finally {
          pool.destroy();
          await database.close();
        }
      });

      it('recovers from a database that hangs up several times and then answers', async () => {
        const database = await fakeDatabase((n) => (n <= 3 ? 'hang up' : 'answer'));
        const pool = openPostgresPool(database.target, 500, { firstMs: 30, maxMs: 120 });
        try {
          const results: string[] = [];
          const started = Date.now();
          while (Date.now() - started < 1500) {
            results.push(await outcomeOf(pool));
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          // It came back by itself, stayed back, and nothing was left waiting.
          expect(results).not.toContain('still waiting');
          expect(results.slice(-30).every((result) => result === 'answered')).toBe(true);
          expect(database.state.accepted).toBe(4);
        } finally {
          pool.destroy();
          await database.close();
        }
      });
    });

    it('against a database that keeps refusing, no caller waits: every call fails within a moment', async () => {
      // A port nothing listens on, for four seconds, with a call every 60 ms and a short pause, so the
      // driver is asked to connect again and again. With the driver's own growing wait between
      // attempts left on, a call would sit out that wait, a second and more by the fifth attempt.
      const probe = createServer();
      await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
      const port = (probe.address() as { port: number }).port;
      await new Promise((resolve) => probe.close(resolve));
      const pool = openPostgresPool(parseDatabaseUrl(`postgres://box_reader@127.0.0.1:${port}/app`), 500, { firstMs: 20, maxMs: 20 });
      let longest = 0;
      const codes = new Set<string>();
      try {
        const started = Date.now();
        while (Date.now() - started < 4000) {
          const at = Date.now();
          const code = await Promise.race([
            Promise.resolve().then(() => pool.ping()).then(() => 'answered', (error: { code?: string }) => error.code ?? 'failed'),
            new Promise<string>((resolve) => setTimeout(() => resolve('still waiting'), 2500)),
          ]);
          codes.add(code);
          longest = Math.max(longest, Date.now() - at);
          await new Promise((resolve) => setTimeout(resolve, 60));
        }
      } finally {
        pool.destroy();
      }
      expect(codes).not.toContain('still waiting');
      expect(codes).not.toContain('answered');
      expect(longest).toBeLessThan(300);
    }, 15_000);

    // That a pool which was thrown away opens no socket at all is held by the two 'goes silent' tests
    // above, which fail without that guard. This one shows the driver itself stops.
    it('a pool that was thrown away stops retrying', async () => {
      let accepted = 0;
      const server = createServer((socket) => {
        accepted += 1;
        socket.on('error', () => {});
        socket.destroy();
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      const pool = openPostgresPool(parseDatabaseUrl(`postgres://box_reader@127.0.0.1:${port}/app`), 500);
      try {
        // A call that keeps the driver retrying against the listener that hangs up.
        Promise.resolve(pool.ping()).catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 300));
        pool.destroy();
        await new Promise((resolve) => setTimeout(resolve, 100));
        const atDestroy = accepted;
        await new Promise((resolve) => setTimeout(resolve, 2500));
        expect(accepted).toBe(atDestroy);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    it('a connection that does not open in time fails as itself, before the call is given up on', async () => {
      // 192.0.2.1 is a documentation address: nothing answers, so the connection never opens.
      const store = createPostgresStore('postgres://box_reader@192.0.2.1:5432/app', { queryTimeoutMs: 1500, connectTimeoutMs: 200 });
      try {
        const started = Date.now();
        const failure = await store.ping().then(() => null, (error: unknown) => error);
        // The box's own timer, in milliseconds: the driver's, in whole seconds, would take a second.
        expect(Date.now() - started).toBeLessThan(700);
        expect(['timeout', 'connect']).toContain(storeFailureOf(failure));
        expect(failure).not.toMatchObject({ code: 'BOX_TIMEOUT' });
      } finally {
        await store.close().catch(() => {});
      }
    });
  });

  describe('when to throw a pool away', () => {
    const SITE = '0b0e7c1a-5d2f-4c3b-9a8e-1f2d3c4b5a69';
    const later = <T>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
    const never = <T>() => new Promise<T>(() => {});

    function fakePools(find: (sha256: string, generation: number) => PromiseLike<BoxRow | null>) {
      const made: { destroyed: boolean; ended: boolean }[] = [];
      const open = (): BoxPool => {
        const state = { destroyed: false, ended: false };
        const generation = made.push(state);
        return {
          find: (_siteId, sha256) => find(sha256, generation),
          ping: () => Promise.resolve(),
          end: async () => void (state.ended = true),
          destroy: () => void (state.destroyed = true),
        };
      };
      return { made, open };
    }

    it('keeps a pool that is busy but answering: one slow call does not fail the others', async () => {
      // 'slow' never comes back; 'quick' answers after 100 ms, while the slow one is waiting.
      const { made, open } = fakePools((sha256) => (sha256 === 'slow' ? never() : later(100, null)));
      const store = createPostgresStore('postgres://r@db/app', { queryTimeoutMs: 300, open });
      const slow = store.find(SITE, 'slow').then(() => 'answered', (error: { code?: string }) => error.code);
      const quick = store.find(SITE, 'quick');
      await expect(quick).resolves.toBeNull();
      expect(await slow).toBe('BOX_TIMEOUT');
      // The database answered after the slow call began, so it is not silent: same pool, nothing destroyed.
      expect(made).toHaveLength(1);
      expect(made[0]!.destroyed).toBe(false);
    });

    it('keeps a pool whose database answers with an error of its own', async () => {
      const { made, open } = fakePools((sha256) =>
        sha256 === 'slow' ? never() : later(100, null).then(() => Promise.reject(Object.assign(new Error('x'), { name: 'PostgresError', code: '57014' }))),
      );
      const store = createPostgresStore('postgres://r@db/app', { queryTimeoutMs: 300, open });
      const slow = store.find(SITE, 'slow').catch((error: { code?: string }) => error.code);
      await expect(store.find(SITE, 'other')).rejects.toMatchObject({ code: '57014' });
      expect(await slow).toBe('BOX_TIMEOUT');
      expect(made).toHaveLength(1);
    });

    it('throws away a pool that gave no answer at all, once, and serves from the new one', async () => {
      // The first pool is silent; every later one answers.
      const { made, open } = fakePools((_sha256, generation) => (generation === 1 ? never() : Promise.resolve({ document: 'x', live: true, subdomainLabels: [], customHostnames: [] })));
      const store = createPostgresStore('postgres://r@db/app', { queryTimeoutMs: 200, open });
      const results = await Promise.all(['a', 'b', 'c'].map((sha256) => store.find(SITE, sha256).then(() => 'answered', (error: { code?: string }) => error.code)));
      expect(results).toEqual(['BOX_TIMEOUT', 'BOX_TIMEOUT', 'BOX_TIMEOUT']);
      // Three calls gave up together: one replacement, not three.
      expect(made).toHaveLength(2);
      expect(made[0]!.destroyed).toBe(true);
      expect(made[1]!.destroyed).toBe(false);
      await expect(store.find(SITE, 'd')).resolves.toMatchObject({ live: true });
      await store.close();
      expect(made[1]!.ended).toBe(true);
      expect(made[0]!.ended).toBe(false);
    });

    it.each([
      ['a reset connection', { code: 'ECONNRESET' }],
      // Five characters, like an SQLSTATE, and not one.
      ['a broken pipe', { code: 'EPIPE' }],
      ['a five character code that is not the driver\'s error', { name: 'Error', code: '57014' }],
    ])('does not count %s as an answer of the database', async (_what, fields) => {
      const { made, open } = fakePools((sha256, generation) =>
        generation > 1 ? Promise.resolve(null) : sha256 === 'slow' ? never() : later(50, null).then(() => Promise.reject(Object.assign(new Error('x'), fields))),
      );
      const store = createPostgresStore('postgres://r@db/app', { queryTimeoutMs: 200, open });
      const slow = store.find(SITE, 'slow').catch((error: { code?: string }) => error.code);
      await expect(store.find(SITE, 'other')).rejects.toMatchObject({ code: fields.code });
      expect(await slow).toBe('BOX_TIMEOUT');
      expect(made).toHaveLength(2);
    });

    it('throws a pool away after 24 calls were given up on, also while something else answers', async () => {
      // One connection silent, one answering: 'slow' never returns, 'quick' always does.
      const { made, open } = fakePools((sha256, generation) => (generation === 1 && sha256 === 'slow' ? never() : Promise.resolve(null)));
      const store = createPostgresStore('postgres://r@db/app', { queryTimeoutMs: 60, open });
      const keepAnswering = setInterval(() => void store.find(SITE, 'quick').catch(() => {}), 10);
      try {
        const first = await Promise.all(Array.from({ length: 23 }, () => store.find(SITE, 'slow').then(() => 'answered', (error: { code?: string }) => error.code)));
        expect(new Set(first)).toEqual(new Set(['BOX_TIMEOUT']));
        expect(made).toHaveLength(1);
        // The 24th tips it over.
        await expect(store.find(SITE, 'slow')).rejects.toMatchObject({ code: 'BOX_TIMEOUT' });
        expect(made).toHaveLength(2);
        expect(made[0]!.destroyed).toBe(true);
        await expect(store.find(SITE, 'slow')).resolves.toBeNull();
      } finally {
        clearInterval(keepAnswering);
      }
    });
  });

  it('a database that never answers is given up on', async () => {
    await expect(withTimeout(new Promise(() => {}), 20)).rejects.toMatchObject({ code: 'BOX_TIMEOUT' });
    await expect(withTimeout(Promise.resolve(7), 20)).resolves.toBe(7);
    await expect(withTimeout(Promise.reject(new Error('no')), 20)).rejects.toThrow('no');
  });
});

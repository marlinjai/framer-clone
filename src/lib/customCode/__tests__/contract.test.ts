// @vitest-environment node
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { PREVIEW_LABEL_PREFIX } from '@/lib/sites/previewHost';
import {
  BOX_COMMON_HEADERS,
  BOX_DOCUMENT_POLICY,
  BOX_DOCUMENT_PREFIX,
  BOX_PREVIEW_LABEL_PREFIX,
  BOX_REFUSAL_POLICY,
  BOX_SHELL_MARKER,
  BOX_SHELL_SCRIPT,
  BOX_SHELL_VERSION,
  boxDocumentHeaders,
  boxPath,
  boxRefusalHeaders,
  canonicalDeclarationJson,
  composeBoxDocument,
  customCodeHash,
  frameAncestorsValue,
  isCrossSiteFrameRequest,
  isExactHostname,
  isWellFormedText,
  parseBoxPath,
  parseDeclaration,
  sha256Hex,
  siteHostsOf,
  type CustomCodeDeclaration,
} from '../contract';

const SITE = '0b0e7c1a-5d2f-4c3b-9a8e-1f2d3c4b5a69';
const HASH = 'a'.repeat(64);
const EDITOR = 'app.lumitra.co';
const declaration: CustomCodeDeclaration = { reads: [], writes: [], emits: [], sizing: 'fixed', interactive: true };

describe('the contract module itself', () => {
  const source = readFileSync(path.resolve(__dirname, '../contract.ts'), 'utf8');

  it('imports nothing', () => {
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\bfrom\s+['"]/);
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/\bimport\s*\(/);
  });

  it('keeps the preview prefix equal to the one the application uses', () => {
    expect(BOX_PREVIEW_LABEL_PREFIX).toBe(PREVIEW_LABEL_PREFIX);
  });
});

describe('the address', () => {
  it('reads a site id and a hash', () => {
    expect(parseBoxPath(`/box/${SITE}/${HASH}`)).toEqual({ siteId: SITE, sha256: HASH });
    expect(boxPath(SITE, HASH)).toBe(`/box/${SITE}/${HASH}`);
  });

  it.each([
    ['upper case hash', `/box/${SITE}/${'A'.repeat(64)}`],
    ['upper case site id', `/box/${SITE.toUpperCase()}/${HASH}`],
    ['short hash', `/box/${SITE}/${'a'.repeat(63)}`],
    ['long hash', `/box/${SITE}/${'a'.repeat(65)}`],
    ['trailing slash', `/box/${SITE}/${HASH}/`],
    ['double slash', `/box//${SITE}/${HASH}`],
    ['percent-encoded character', `/box/${SITE}/${'a'.repeat(63)}%61`],
    ['encoded slash', `/box/${SITE}%2F${HASH}`],
    ['dot segment', `/box/../box/${SITE}/${HASH}`],
    ['query in the path', `/box/${SITE}/${HASH}?x=1`],
    ['new line', `/box/${SITE}/${HASH}\n`],
    ['a site id that is not a UUID', `/box/site-1/${HASH}`],
    ['another prefix', `/Box/${SITE}/${HASH}`],
    ['empty', ''],
  ])('refuses %s', (_name, value) => {
    expect(parseBoxPath(value)).toBeNull();
  });

  it('never builds an address from anything else', () => {
    expect(() => boxPath('x', HASH)).toThrow();
    expect(() => boxPath(SITE, `${HASH}/../x`)).toThrow();
  });
});

describe('frame-ancestors', () => {
  it('names the site hosts and the editor host as https sources', () => {
    expect(frameAncestorsValue(['shop.sites.lumitra.co', 'www.example.com'], EDITOR)).toBe(
      'https://shop.sites.lumitra.co https://www.example.com https://app.lumitra.co',
    );
  });

  it('leaves out branch preview hosts, well-formed or not, under any domain (D13)', () => {
    const token = 'abcdefghijklmnopqrstuvwxyz234567';
    expect(frameAncestorsValue([`preview-${token}.sites.lumitra.co`, 'preview-x.sites.lumitra.co', 'preview-shop.example.com', 'a.sites.lumitra.co'], EDITOR)).toBe(
      'https://a.sites.lumitra.co https://app.lumitra.co',
    );
    expect(frameAncestorsValue([], `preview-${token}.sites.lumitra.co`)).toBe("'none'");
  });

  it.each([
    ['a wildcard', '*.sites.lumitra.co'],
    ['a bare wildcard', '*'],
    ['a scheme', 'https://a.example.com'],
    ['a scheme source', 'https:'],
    ['a port', 'a.example.com:8443'],
    ['a path', 'a.example.com/x'],
    ['a second source', 'a.example.com https://evil.example'],
    ['a second directive', "a.example.com; script-src 'unsafe-eval'"],
    ['a comma', 'a.example.com,b.example.com'],
    ['a new line', 'a.example.com\r\nSet-Cookie: x=1'],
    ['a keyword', "'self'"],
    ['upper case', 'A.example.com'],
    ['a trailing dot', 'a.example.com.'],
    ['a single label', 'localhost'],
    ['an address', '127.0.0.1'],
    ['an IPv6 address', '[::1]'],
    ['a non-ASCII name', 'bücher.example'],
    ['an empty text', ''],
    ['a number', 7],
    ['null', null],
    ['an object', { toString: () => 'a.example.com' }],
    ['a name longer than 253 characters', `${'a'.repeat(60)}.`.repeat(5) + 'example.com'],
  ])('drops %s instead of repairing it (D14)', (_name, value) => {
    expect(isExactHostname(value)).toBe(false);
    expect(frameAncestorsValue([value, 'ok.example.com'], EDITOR)).toBe('https://ok.example.com https://app.lumitra.co');
  });

  it('builds a platform host from a stored label and the configured base, and only from a plain label (D18)', () => {
    expect(siteHostsOf(['shop', 'a-b'], ['www.example.com'], 'sites.lumitra.co')).toEqual(['shop.sites.lumitra.co', 'a-b.sites.lumitra.co', 'www.example.com']);
    for (const label of ['*', 'a.b', 'evil.example.com', '', '-a', 'a-', 'A', 'a b', 'a;b', 'a\n', 7, null, 'x'.repeat(64)]) {
      expect(siteHostsOf([label], [], 'sites.lumitra.co')).toEqual([]);
    }
    expect(siteHostsOf(['shop'], ['www.example.com'], '*.lumitra.co')).toEqual([]);
    expect(siteHostsOf('shop', 'www.example.com', 'sites.lumitra.co')).toEqual([]);
    expect(siteHostsOf(['preview-x', 'shop'], ['preview-y.example.com'], 'sites.lumitra.co')).toEqual(['shop.sites.lumitra.co']);
  });

  it('never takes a platform address from a custom host name: one site cannot name another site there', () => {
    expect(siteHostsOf(['mine'], ['victim.sites.lumitra.co', 'sites.lumitra.co', 'a.b.sites.lumitra.co', 'notsites.lumitra.co', 'www.example.com'], 'sites.lumitra.co')).toEqual([
      'mine.sites.lumitra.co',
      'notsites.lumitra.co',
      'www.example.com',
    ]);
  });

  it('drops what is not allowed before it counts, so bad entries cannot push out a good one', () => {
    const bad = Array.from({ length: 40 }, (_, i) => `*.bad${i}.example.com`);
    expect(siteHostsOf([], [...bad, 'good.example.com'], 'sites.lumitra.co')).toEqual(['good.example.com']);
    expect(frameAncestorsValue([...bad, 'good.example.com'], EDITOR)).toBe('https://good.example.com https://app.lumitra.co');
    expect(siteHostsOf(Array.from({ length: 50 }, (_, i) => `s${i}`), ['www.example.com'], 'sites.lumitra.co')).toHaveLength(32);
  });

  it("says 'none' when nothing valid is left", () => {
    expect(frameAncestorsValue(null, undefined)).toBe("'none'");
    expect(frameAncestorsValue('a.example.com', '*')).toBe("'none'");
    expect(frameAncestorsValue([['a.example.com']], '')).toBe("'none'");
  });

  it('names a host once and at most 32 of a site', () => {
    expect(frameAncestorsValue(['a.example.com', 'a.example.com', EDITOR], EDITOR)).toBe('https://a.example.com https://app.lumitra.co');
    const many = Array.from({ length: 50 }, (_, i) => `h${i}.example.com`);
    expect(frameAncestorsValue(many, EDITOR).split(' ')).toHaveLength(33);
  });
});

describe('headers', () => {
  it('the document policy is the decided one, byte for byte', () => {
    expect(BOX_DOCUMENT_POLICY).toBe(
      "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; manifest-src 'none'; webrtc 'block'",
    );
    expect(BOX_DOCUMENT_POLICY).not.toContain('allow-same-origin');
    expect(BOX_DOCUMENT_POLICY).not.toContain('unsafe-eval');
  });

  it('a document carries every decided header and no cookie', () => {
    const headers = boxDocumentHeaders(['shop.sites.lumitra.co'], EDITOR);
    expect(headers).toEqual({
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': `${BOX_DOCUMENT_POLICY}; frame-ancestors https://shop.sites.lumitra.co https://app.lumitra.co; report-uri https://app.lumitra.co/api/csp-report/box`,
      'Permissions-Policy':
        'camera=(), microphone=(), geolocation=(), usb=(), serial=(), hid=(), bluetooth=(), midi=(), payment=(), display-capture=(), fullscreen=(), clipboard-read=(), clipboard-write=(), publickey-credentials-get=(), xr-spatial-tracking=(), accelerometer=(), gyroscope=(), magnetometer=(), idle-detection=(), screen-wake-lock=(), browsing-topics=(), attribution-reporting=()',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'X-Content-Type-Options': 'nosniff',
      'X-DNS-Prefetch-Control': 'off',
      'Referrer-Policy': 'no-referrer',
      'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
      'Cache-Control': 'private, max-age=300',
      Vary: 'Sec-Fetch-Dest, Sec-Fetch-Site',
    });
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('set-cookie');
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('cross-origin-embedder-policy');
    // A sandboxed document with an opener policy is a network error on a direct visit (D21).
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('cross-origin-opener-policy');
    expect(Object.keys(boxRefusalHeaders()).map((k) => k.toLowerCase())).not.toContain('cross-origin-opener-policy');
  });

  it('a refusal runs nothing, is framed by nothing and is never stored', () => {
    const headers = boxRefusalHeaders();
    expect(headers['Content-Security-Policy']).toBe(BOX_REFUSAL_POLICY);
    expect(BOX_REFUSAL_POLICY).toMatch(/^sandbox;/);
    expect(BOX_REFUSAL_POLICY).not.toContain('allow-');
    expect(BOX_REFUSAL_POLICY).toContain("frame-ancestors 'none'");
    expect(headers['Cache-Control']).toBe('no-store');
    expect(headers['Content-Type']).toBe('text/plain; charset=utf-8');
    for (const [name, value] of Object.entries(BOX_COMMON_HEADERS)) expect(headers[name]).toBe(value);
  });

  it('refuses an editor host that is not an exact host name', () => {
    expect(() => boxDocumentHeaders([], 'app.lumitra.co; sandbox allow-same-origin')).toThrow();
    expect(() => boxDocumentHeaders([], '*')).toThrow();
  });

  it('takes a frame request only with both fetch metadata headers', () => {
    expect(isCrossSiteFrameRequest('iframe', 'cross-site')).toBe(true);
    for (const [dest, site] of [
      ['iframe', 'same-site'], ['iframe', 'same-origin'], ['iframe', 'none'], ['iframe', undefined],
      ['document', 'cross-site'], ['frame', 'cross-site'], ['embed', 'cross-site'], [undefined, 'cross-site'],
      ['IFRAME', 'cross-site'], ['iframe', 'Cross-Site'], [['iframe'], 'cross-site'], [undefined, undefined],
    ] as const) {
      expect(isCrossSiteFrameRequest(dest, site)).toBe(false);
    }
  });
});

describe('the shell', () => {
  it('stands first, carries the marker and cannot close its own script element', () => {
    expect(composeBoxDocument('<p>hi</p>')).toBe(`${BOX_DOCUMENT_PREFIX}<p>hi</p>`);
    expect(BOX_DOCUMENT_PREFIX.startsWith('<!doctype html><meta charset="utf-8"><script>')).toBe(true);
    expect(BOX_SHELL_SCRIPT).toContain(BOX_SHELL_MARKER);
    expect(BOX_SHELL_SCRIPT.toLowerCase()).not.toContain('</script');
    expect(BOX_SHELL_SCRIPT).not.toContain('<!--');
  });

  it('falls back to deleting a name where the window refuses a fixed property', () => {
    class Fake {}
    const target: Record<string, unknown> = { RTCPeerConnection: Fake, RTCDataChannel: Fake };
    // A window like the one an engine gives that refuses a non-configurable property on it.
    const window: Record<string, unknown> = new Proxy(target, {
      defineProperty(object, key, descriptor) {
        if (descriptor.configurable === false) throw new TypeError('cannot define a fixed property on a window');
        return Reflect.defineProperty(object, key, descriptor);
      },
    });
    target.window = window;
    const context = vm.createContext({ window });
    vm.runInContext(BOX_SHELL_SCRIPT, context);
    expect(vm.runInContext('typeof window.RTCPeerConnection', context)).toBe('undefined');
    expect(vm.runInContext('typeof window.RTCDataChannel', context)).toBe('undefined');
    expect(vm.runInContext("'RTCPeerConnection' in window", context)).toBe(false);
  });

  // A model of a window, not a browser: what an engine really does is probed in three browsers by slice C6.
  it('on a model of a window, removes the WebRTC constructors so the name cannot be put back, and says hello once', () => {
    const posted: unknown[] = [];
    class Fake {}
    const window: Record<string, unknown> = {
      RTCPeerConnection: Fake, webkitRTCPeerConnection: Fake, RTCDataChannel: Fake,
      RTCIceTransport: Fake, RTCSessionDescription: Fake, RTCIceCandidate: Fake,
      parent: { postMessage: (message: unknown, target: unknown) => posted.push([message, target]) },
    };
    window.window = window;
    const context = vm.createContext(window);
    vm.runInContext(BOX_SHELL_SCRIPT, context);
    for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCIceTransport', 'RTCSessionDescription', 'RTCIceCandidate']) {
      expect(vm.runInContext(`typeof ${name}`, context)).toBe('undefined');
      // The author's code cannot put one back under the name.
      vm.runInContext(`try { window.${name} = function(){}; } catch (e) {}`, context);
      expect(vm.runInContext(`typeof window.${name}`, context)).toBe('undefined');
      expect(() => vm.runInContext(`'use strict'; Object.defineProperty(window, '${name}', { value: 1 })`, context)).toThrow();
    }
    expect(posted).toEqual([[{ fc: 1, kind: 'hello', shell: BOX_SHELL_VERSION }, '*']]);
  });

  /**
   * A model window with listeners, a parent that records posts, a port pair to stand in for the broker, and a
   * clock and timers the test moves by hand (`advance`).
   */
  function shellWindow() {
    const listeners: Record<string, ((event: unknown) => void)[]> = {};
    const parent = { postMessage: () => {} };
    let time = 1_000_000;
    let wallStep = 0;
    let nextId = 1;
    const timers = new Map<number, { at: number; fn: () => void }>();
    const window: Record<string, unknown> = {
      parent,
      addEventListener: (type: string, fn: (event: unknown) => void) => (listeners[type] ??= []).push(fn),
      // The shell times its sends with performance.now; the wall clock here may be stepped by a test.
      performance: { now: () => time },
      Date: { now: () => time + wallStep },
      setTimeout: (fn: () => void, ms: number) => {
        timers.set(nextId, { at: time + Math.max(0, ms || 0), fn });
        return nextId++;
      },
      clearTimeout: (id: number) => timers.delete(id),
    };
    /** Moves the clock on, running each timer when its time comes, in order. */
    const advance = (ms: number) => {
      const end = time + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        time = Math.max(time, due[1].at);
        due[1].fn();
      }
      time = end;
    };
    window.window = window;
    const context = vm.createContext(window);
    vm.runInContext(BOX_SHELL_SCRIPT, context);
    const sent: unknown[] = [];
    /** When each message was sent, on the model clock. */
    const times: number[] = [];
    const port = {
      onmessage: null as null | ((event: { data: unknown }) => void),
      postMessage: (message: unknown) => {
        times.push(time);
        sent.push(JSON.parse(JSON.stringify(message)));
      },
    };
    const dispatch = (type: string, event: unknown) => (listeners[type] ?? []).forEach((fn) => fn(event));
    const connect = (declaration: unknown, from: unknown = parent, ports: unknown[] = [port]) =>
      dispatch('message', { source: from, data: { fc: 1, kind: 'connect', declaration }, ports });
    const toFrame = (data: unknown) => port.onmessage?.({ data });
    const run = (code: string) => vm.runInContext(code, context);
    const stepWallClock = (ms: number) => {
      wallStep += ms;
    };
    return { context, sent, times, port, connect, toFrame, dispatch, run, advance, stepWallClock };
  }

  it('gives the author a frozen lumitra client that queues until the page connects', async () => {
    const shell = shellWindow();
    expect(shell.run('Object.isFrozen(window.lumitra) && Object.keys(window.lumitra).sort().join()')).toBe('emit,onState,read,ready,resize,setState');
    shell.run('try { window.lumitra = null; } catch (e) {}');
    expect(shell.run('typeof window.lumitra.read')).toBe('function');
    shell.run("lumitra.setState('open', true); lumitra.emit('done'); lumitra.emit('custom:other'); lumitra.resize('320')");
    expect(shell.sent).toEqual([]);
    shell.connect({ reads: [], writes: ['open'], emits: ['custom:done'], sizing: 'content', interactive: true });
    // Writes, then the height, then the emits in the order of their first call.
    expect(shell.sent).toEqual([
      { kind: 'setState', id: 'open', value: true },
      { kind: 'resize', height: 320 },
      { kind: 'emit', name: 'custom:done' },
      { kind: 'emit', name: 'custom:other' },
    ]);
  });

  it('takes the port only from its parent, once, and answers pings', () => {
    const shell = shellWindow();
    const other = { onmessage: null, postMessage: () => { throw new Error('the wrong port'); } };
    shell.connect({ reads: [] }, { postMessage: () => {} }, [other]);
    shell.connect({ reads: [] }, shell.context.parent, []);
    shell.run("lumitra.setState('a', 1)");
    expect(shell.sent).toEqual([]);
    shell.connect({ reads: [] });
    expect(shell.sent).toEqual([{ kind: 'setState', id: 'a', value: 1 }]);
    shell.connect({ reads: [] }, shell.context.parent, [other]);
    shell.toFrame({ kind: 'ping' });
    expect(shell.sent.at(-1)).toEqual({ kind: 'pong' });
  });

  it('reads state, calls watchers with each value, and is ready once every read has one', async () => {
    const shell = shellWindow();
    shell.run("window.seen = []; window.isReady = false; lumitra.ready().then(function(){ window.isReady = true; }); window.stop = lumitra.onState('tab', function(v){ seen.push(v); })");
    shell.connect({ reads: ['tab', 'open'] });
    shell.toFrame({ kind: 'state', id: 'tab', value: 'b' });
    await Promise.resolve();
    expect(shell.run('isReady')).toBe(false);
    shell.toFrame({ kind: 'state', id: 'open', value: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shell.run('isReady')).toBe(true);
    expect(shell.run("lumitra.read('tab')")).toBe('b');
    expect(shell.run("lumitra.read('missing')")).toBeUndefined();
    shell.run('stop()');
    shell.toFrame({ kind: 'state', id: 'tab', value: 'c' });
    expect(shell.run('seen.join()')).toBe('b');
    // A watcher added later hears the value it already has, at once.
    shell.run("lumitra.onState('open', function(v){ seen.push(String(v)); })");
    expect(shell.run('seen.join()')).toBe('b,true');
  });

  it('reports a thrown watcher and an uncaught error to the page, shortened', () => {
    const shell = shellWindow();
    shell.connect({ reads: ['x'] });
    shell.run("lumitra.onState('x', function(){ throw new Error('boom'); })");
    shell.toFrame({ kind: 'state', id: 'x', value: 1 });
    // A second error within the second is not reported: a frame that fails in a loop says so once a second.
    shell.dispatch('error', { error: new Error('again') });
    shell.advance(1000);
    shell.dispatch('error', { error: new Error('y'.repeat(900)) });
    expect(shell.sent).toEqual([
      { kind: 'error', message: 'boom' },
      { kind: 'error', message: 'y'.repeat(500) },
    ]);
  });

  it('coalesces writes and resizes: the latest of each, on the trailing edge, about one message per 50 ms', () => {
    const shell = shellWindow();
    shell.connect({ reads: [] });
    // A write from every animation frame at 120 Hz for two seconds, two states, and a growing height.
    for (let frame = 1; frame <= 240; frame++) {
      shell.run(`lumitra.setState('count', ${frame}); lumitra.setState('n', ${frame % 9}); lumitra.resize(${100 + frame})`);
      shell.advance(1000 / 120);
    }
    shell.run("lumitra.setState('count', 777)");
    shell.advance(1000);
    const sent = shell.sent as { kind: string; id?: string; value?: unknown; height?: number }[];
    // Never more than 20 messages in any second, though 721 calls were made (the page drops past 30).
    const most = Math.max(...shell.times.map((at) => shell.times.filter((t) => t >= at && t < at + 1000).length));
    expect(most).toBeLessThanOrEqual(21);
    expect(sent.length).toBeGreaterThan(30);
    // The last value of each arrives.
    expect(sent.filter((m) => m.id === 'count').at(-1)).toEqual({ kind: 'setState', id: 'count', value: 777 });
    expect(sent.filter((m) => m.id === 'n').at(-1)).toEqual({ kind: 'setState', id: 'n', value: 240 % 9 });
    expect(sent.filter((m) => m.kind === 'resize').at(-1)).toEqual({ kind: 'resize', height: 340 });
  });

  it('sends the first write at once, and pending writes before an emit that follows them, the emit merged by name', () => {
    const shell = shellWindow();
    shell.connect({ reads: [] });
    shell.run("lumitra.setState('a', 1)");
    shell.advance(0);
    expect(shell.sent).toEqual([{ kind: 'setState', id: 'a', value: 1 }]);
    shell.run("lumitra.setState('a', 2); lumitra.emit('done'); lumitra.setState('__proto__', 3); lumitra.emit('custom:done')");
    expect(shell.sent).toHaveLength(1);
    shell.advance(50);
    expect(shell.sent).toEqual([
      { kind: 'setState', id: 'a', value: 1 },
      { kind: 'setState', id: 'a', value: 2 },
      { kind: 'setState', id: '__proto__', value: 3 },
      { kind: 'emit', name: 'custom:done' },
    ]);
    shell.advance(1000);
    expect(shell.sent).toHaveLength(4);
  });

  it('keeps an honest slider under 25 a second: a write and an emit on every input at 120 Hz, ending on the last value', () => {
    const shell = shellWindow();
    shell.connect({ reads: [] });
    for (let input = 1; input <= 240; input++) {
      shell.run(`lumitra.setState('count', ${input}); lumitra.emit('done')`);
      shell.advance(1000 / 120);
    }
    shell.advance(1000);
    const sent = shell.sent as { kind: string; id?: string; value?: unknown; name?: string }[];
    const most = Math.max(...shell.times.map((at) => shell.times.filter((t) => t >= at && t < at + 1000).length));
    expect(most).toBeLessThanOrEqual(25);
    expect(sent.filter((m) => m.kind === 'setState').at(-1)).toEqual({ kind: 'setState', id: 'count', value: 240 });
    expect(sent.at(-1)).toEqual({ kind: 'emit', name: 'custom:done' });
  });

  it('never sends more than 25 in a second, however many states change at once, and every final value arrives', () => {
    const shell = shellWindow();
    shell.connect({ reads: [] });
    // Review 3 of pull request #452, L1: 10 states, then 21 more within the second, then all 31 again.
    shell.run("for (var i = 0; i < 10; i++) lumitra.setState('s' + i, 1)");
    shell.advance(500);
    shell.run("for (var i = 10; i < 31; i++) lumitra.setState('s' + i, 1); lumitra.resize(50); lumitra.emit('done')");
    shell.advance(100);
    shell.run("for (var i = 0; i < 31; i++) lumitra.setState('s' + i, 2)");
    shell.advance(5000);
    const sent = shell.sent as { kind: string; id?: string; value?: unknown }[];
    const most = Math.max(...shell.times.map((at) => shell.times.filter((t) => t >= at && t < at + 1000).length));
    expect(most).toBeLessThanOrEqual(25);
    for (let i = 0; i < 31; i++) expect(sent.filter((m) => m.id === `s${i}`).at(-1)).toEqual({ kind: 'setState', id: `s${i}`, value: 2 });
    expect(sent.filter((m) => m.kind === 'resize')).toEqual([{ kind: 'resize', height: 50 }]);
    expect(sent.filter((m) => m.kind === 'emit')).toEqual([{ kind: 'emit', name: 'custom:done' }]);
  });

  // Review of pull request #452, C3: more writes than one flush has room for must not starve the height and the emits.
  it('delivers the height and an emit while 26 states change on every animation frame', () => {
    const shell = shellWindow();
    shell.connect({ reads: [] });
    shell.run("lumitra.resize(321); lumitra.emit('done')");
    for (let frame = 1; frame <= 600; frame++) {
      shell.run(`for (var i = 0; i < 26; i++) lumitra.setState('s' + i, ${frame})`);
      shell.advance(1000 / 60);
    }
    const sent = shell.sent as { kind: string }[];
    // Both arrived while the writes were still coming (600 frames last 10 seconds), not after they stopped.
    const lastWrite = shell.times.length;
    expect(sent.filter((m) => m.kind === 'resize')).toEqual([{ kind: 'resize', height: 321 }]);
    expect(sent.filter((m) => m.kind === 'emit')).toEqual([{ kind: 'emit', name: 'custom:done' }]);
    expect(lastWrite).toBeGreaterThan(0);
    const most = Math.max(...shell.times.map((at) => shell.times.filter((t) => t >= at && t < at + 1000).length));
    expect(most).toBeLessThanOrEqual(25);
  });

  // Review 4 of pull request #452, L3: a wall clock stepped back an hour does not hold the sends.
  it('keeps sending on time when the wall clock steps back', () => {
    const shell = shellWindow();
    shell.connect({ reads: [] });
    shell.run("lumitra.setState('a', 1)");
    shell.advance(100);
    shell.stepWallClock(-3_600_000);
    shell.run("lumitra.setState('a', 2)");
    shell.advance(200);
    expect(shell.sent).toEqual([{ kind: 'setState', id: 'a', value: 1 }, { kind: 'setState', id: 'a', value: 2 }]);
  });

  it('keeps only the latest values while it waits for the page, however long', () => {
    const shell = shellWindow();
    for (let i = 1; i <= 500; i++) {
      shell.run(`lumitra.setState('count', ${i})`);
      shell.advance(4);
    }
    expect(shell.sent).toEqual([]);
    shell.connect({ reads: [] });
    expect(shell.sent).toEqual([{ kind: 'setState', id: 'count', value: 500 }]);
  });

  it('survives a window without a parent', () => {
    const window: Record<string, unknown> = {};
    window.window = window;
    expect(() => vm.runInContext(BOX_SHELL_SCRIPT, vm.createContext(window))).not.toThrow();
  });
});

describe('the declaration', () => {
  it('returns one canonical form', () => {
    const parsed = parseDeclaration({ reads: ['tab', 'open', 'tab'], emits: ['custom:done'], sizing: 'content', interactive: false });
    expect(parsed).toEqual({ ok: true, declaration: { reads: ['open', 'tab'], writes: [], emits: ['custom:done'], sizing: 'content', interactive: false } });
  });

  it.each([
    ['not an object', 'x'],
    ['null', null],
    ['a list', []],
    ['an unknown key', { ...declaration, network: ['example.com'] }],
    ['a prototype key', JSON.parse('{"__proto__":{"x":1},"sizing":"fixed","interactive":true}')],
    ['a class instance', new (class { sizing = 'fixed'; interactive = true })()],
    ['reads that is not a list', { ...declaration, reads: 'tab' }],
    ['a state id with a space', { ...declaration, reads: ['a b'] }],
    ['an upper case state id', { ...declaration, writes: ['Tab'] }],
    ['a state id that is an object', { ...declaration, reads: [{}] }],
    ['an emit without the prefix', { ...declaration, emits: ['done'] }],
    ['a DOM event as an emit', { ...declaration, emits: ['click'] }],
    ['too many reads', { ...declaration, reads: Array.from({ length: 33 }, (_, i) => `s${i}`) }],
    ['no sizing', { reads: [], interactive: true }],
    ['an unknown sizing', { ...declaration, sizing: 'page' }],
    ['interactive as text', { ...declaration, interactive: 'false' }],
  ])('refuses %s with a reason', (_name, input) => {
    const parsed = parseDeclaration(input);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason.length).toBeGreaterThan(0);
  });
});

describe('the hash', () => {
  const hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

  it('agrees with node:crypto, also for text outside ASCII', async () => {
    expect(await sha256Hex('')).toBe(hex(''));
    expect(await sha256Hex('Grüße 🚚')).toBe(hex('Grüße 🚚'));
  });

  it('is the hash of the canonical manifest', async () => {
    const document = '<canvas id="c"></canvas>';
    const manifest = `{"v":1,"document":"${hex(document)}","declaration":{"emits":[],"interactive":true,"reads":[],"sizing":"fixed","writes":[]}}`;
    expect(await customCodeHash(document, declaration)).toBe(hex(manifest));
  });

  it('changes with the code and with the declaration, and not with the order of a list', async () => {
    const base = await customCodeHash('a', declaration);
    expect(await customCodeHash('b', declaration)).not.toBe(base);
    expect(await customCodeHash('a', { ...declaration, writes: ['open'] })).not.toBe(base);
    expect(await customCodeHash('a', { ...declaration, interactive: false })).not.toBe(base);
    expect(await customCodeHash('a', { ...declaration, reads: ['b', 'a'] })).toBe(await customCodeHash('a', { ...declaration, reads: ['a', 'b', 'a'] }));
    expect(canonicalDeclarationJson({ ...declaration, reads: ['b', 'a'] })).toBe('{"emits":[],"interactive":true,"reads":["a","b"],"sizing":"fixed","writes":[]}');
  });

  it('reads each field of a declaration once, so an accessor cannot change its answer', () => {
    let reads = 0;
    const shifty = { reads: [], writes: [], emits: [], sizing: 'fixed' } as Record<string, unknown>;
    Object.defineProperty(shifty, 'interactive', { enumerable: true, get: () => (reads++ === 0 ? true : 'yes') });
    const parsed = parseDeclaration(shifty);
    expect(parsed).toEqual({ ok: true, declaration: { ...declaration } });
    expect(reads).toBe(1);
  });

  it('refuses a text holding half of a surrogate pair, so two texts never share a hash', async () => {
    expect(isWellFormedText('Grüße 🚚')).toBe(true);
    for (const text of ['a\ud800b', 'a\udc00b', '\ud83d', '\udc00\ud83d']) {
      const broken = JSON.parse(`"${text}"`) as string;
      expect(isWellFormedText(broken)).toBe(false);
      await expect(sha256Hex(broken)).rejects.toThrow();
      await expect(customCodeHash(broken, declaration)).rejects.toThrow();
    }
  });

  it('refuses to hash a declaration that is not allowed', async () => {
    await expect(customCodeHash('a', { ...declaration, reads: ['NOT ALLOWED'] })).rejects.toThrow();
  });
});

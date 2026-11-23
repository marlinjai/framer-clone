// The custom code bridge in real browsers (slice C3 of
// docs/plans/2026-11-02-sandboxed-custom-code.md, "Tests, adversarial ones included",
// bridge tests). A page holding the real behaviour runtime, broker and registry
// (customCodeBridge.entry.ts, bundled here) frames documents from a local stand-in for
// the box: `https://run.box.test` answers through Playwright's routing with the real
// headers (boxDocumentHeaders) and the real shell (composeBoxDocument), or, for a
// hostile block, a document that speaks the protocol by hand with raw access to its
// port. Nothing reaches a real domain.
//
// Every case ends on an expectation about what the page holds (its state, the frame,
// the fallback, the console), read after a bounded wait, so a weakened broker fails on
// an expectation, never on a timeout.
//
// Engines: Chromium and WebKit always (the render gate job installs both), and Firefox
// where it is installed (the job installs it for this file; locally `pnpm exec playwright
// install firefox`). A missing Firefox fails loudly unless CUSTOM_CODE_GATE_NO_FIREFOX=1
// says it may be left out, so no run skips it silently.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { chromium, firefox, webkit, type Browser, type BrowserContext, type BrowserType, type Page } from 'playwright';
import { boxDocumentHeaders, composeBoxDocument } from '@/lib/customCode/contract';
import type { IslandBlock, BlockState } from '@/lib/customCode/registry';
import type { BehaviourProgram } from '@/lib/behaviour/program';

const SITE = '0b9e2f4a-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const PAGE_HOST = 'acme.sites.test';
const PAGE_URL = `https://${PAGE_HOST}/`;
const BOX = 'https://run.box.test';
const EDITOR = 'app.editor.test';
const hashOf = (name: string) => Buffer.from(name.padEnd(32, '.')).toString('hex').slice(0, 64);

// ---------------------------------------------------------------------------
// The documents the stand-in box serves, by name
// ---------------------------------------------------------------------------

/** A hand-written frame: hello, then `onConnect(port)` with raw access to the port. No shell. */
const raw = (onConnect: string, hello = true) => `<!doctype html><meta charset="utf-8"><p>raw block</p><script>
  var probe = function (m) { parent.postMessage(Object.assign({ probe: true }, m), '*'); };
  ${hello ? "parent.postMessage({ fc: 1, kind: 'hello', shell: 2 }, '*');" : ''}
  addEventListener('message', function (e) {
    if (e.source !== parent || !e.data || e.data.kind !== 'connect' || !e.ports[0]) return;
    var port = e.ports[0];
    var states = [];
    port.onmessage = function (m) { if (m.data.kind === 'state') states.push(m.data.id); if (m.data.kind === 'ping') port.postMessage({ kind: 'pong' }); };
    (function (port) { ${onConnect} })(port);
    setTimeout(function () { probe({ states: states }); }, 600);
  });
</script>`;

const DOCUMENTS: Record<string, { body: string; shell: boolean }> = {
  happy: {
    shell: true,
    body: `<p>happy</p><script>
      lumitra.ready().then(function () {
        parent.postMessage({ probe: true, ready: lumitra.read('tab') }, '*');
        lumitra.onState('tab', function (v) { lumitra.setState('n', v === 'b' ? 7 : 1); });
        lumitra.resize(321);
        lumitra.emit('done');
      });
    </script>`,
  },
  reload: { shell: true, body: `<script>lumitra.ready().then(function () { setTimeout(function () { location.reload(); }, 50); });</script>` },
  silent: { shell: false, body: '<!doctype html><meta charset="utf-8"><p>a document without the shell never says hello</p>' },
  mute: { shell: false, body: raw("port.onmessage = function () {}; probe({ connected: 'mute' });") },
  frozen: { shell: true, body: `<script>lumitra.ready().then(function () { setTimeout(function () { for (;;) {} }, 100); });</script>` },
  double: { shell: false, body: raw("parent.postMessage({ fc: 1, kind: 'hello', shell: 2 }, '*');") },
  hostile: {
    shell: false,
    body: raw(`
      // First, since over 64 KB after any earlier wrong message removes the frame (D65).
      port.postMessage({ kind: 'setState', id: 'n', value: 4, pad: 'x'.repeat(70000) });
      port.postMessage({ kind: 'setState', id: 'other', value: 5 });
      port.postMessage({ kind: 'setState', id: 'n', value: '5' });
      port.postMessage({ kind: 'setState', id: 'n', value: 99 });
      port.postMessage({ kind: 'setState', id: 'n', value: -1 });
      port.postMessage({ kind: 'setState', id: 'n', value: NaN });
      port.postMessage({ kind: 'setState', id: 'tab', value: 'c' });
      port.postMessage({ kind: 'setState', id: 'name', value: 'leak' });
      port.postMessage({ kind: 'navigate', href: '/away' });
      port.postMessage({ kind: 'resize', height: 999 });
      port.postMessage({ kind: 'emit', name: 'custom:undeclared' });
      port.postMessage({ kind: 'emit', name: 'done' });
      port.postMessage({ kind: 'setState', id: 'n', value: 3 });
    `),
  },
  flood: {
    shell: false,
    body: raw(`
      for (var i = 1; i <= 40; i++) port.postMessage({ kind: 'setState', id: 'count', value: i });
      setTimeout(function () { port.postMessage({ kind: 'setState', id: 'count', value: 41 }); }, 1300);
    `),
  },
  resizer: {
    shell: false,
    body: raw(`
      for (var i = 1; i <= 15; i++) port.postMessage({ kind: 'resize', height: 100 + i });
      setTimeout(function () { port.postMessage({ kind: 'resize', height: 50000 }); }, 2500);
    `),
  },
  // Says hello, then proves its script ran (`ran`) at once; `connected` would only follow a connect the broker never sends it.
  foreign: {
    shell: false,
    body: `<!doctype html><meta charset="utf-8"><script>
      var probe = function (m) { parent.postMessage(Object.assign({ probe: true }, m), '*'); };
      parent.postMessage({ fc: 1, kind: 'hello', shell: 2 }, '*');
      probe({ ran: 'foreign' });
      addEventListener('message', function (e) { if (e.data && e.data.kind === 'connect' && e.ports[0]) probe({ connected: 'foreign' }); });
    </script>`,
  },
  // Floods for 4 seconds in bursts that leave its own event loop free: on its port, or to the page's window.
  deluge: {
    shell: false,
    body: raw(`
      var stop = Date.now() + 4000;
      (function burst() { for (var i = 0; i < 500; i++) port.postMessage({ kind: 'nothing' }); if (Date.now() < stop) setTimeout(burst, 0); })();
    `),
  },
  windowDeluge: {
    shell: false,
    body: raw(`
      var stop = Date.now() + 4000;
      (function burst() { for (var i = 0; i < 500; i++) parent.postMessage({ kind: 'nothing' }, '*'); if (Date.now() < stop) setTimeout(burst, 0); })();
    `),
  },
  // Data JSON cannot weigh: a 32 MB buffer, then a 4 MB string inside a Map.
  binary: {
    shell: false,
    body: raw(`
      port.postMessage({ kind: 'setState', id: 'n', value: 4, pad: new ArrayBuffer(32 * 1024 * 1024) });
      setTimeout(function () { port.postMessage({ kind: 'setState', id: 'n', value: 5, pad: new Map([['a', 'x'.repeat(4000000)]]) }); }, 200);
    `),
  },
  // Review 2 of pull request #452, M1: plain data that is cheap to send and dear to weigh.
  sparse: {
    shell: false,
    body: raw(`
      var stop = Date.now() + 4000;
      var t = setInterval(function () { if (Date.now() > stop) return clearInterval(t); port.postMessage({ kind: 'setState', id: 'n', value: 1, pad: new Array(10000000) }); }, 40);
    `),
  },
  sparseHuge: {
    shell: false,
    body: raw(`
      // An engine may refuse to clone it in the frame already; either way the next write follows.
      try { port.postMessage({ kind: 'setState', id: 'n', value: 1, pad: new Array(4294967295) }); } catch (e) {}
      setTimeout(function () { port.postMessage({ kind: 'setState', id: 'n', value: 2 }); }, 300);
    `),
  },
  // Within the walk's bounds but over 64 KB as JSON (each quote is escaped): ends the frame at the second.
  bulky: {
    shell: false,
    body: raw("for (var i = 0; i < 3; i++) port.postMessage({ kind: 'setState', id: 'n', value: 1, pad: new Array(40000).join('\"') });"),
  },
  // Review 3, M1: costly window messages, after hello and without one. 300,000 small objects each.
  winHeavy: {
    shell: false,
    body: raw(`
      var pad = []; for (var i = 0; i < 300000; i++) pad.push({ a: i });
      var stop = Date.now() + 6000;
      (function send() { parent.postMessage({ kind: 'nothing', pad: pad }, '*'); if (Date.now() < stop) setTimeout(send, 0); })();
    `),
  },
  // No hello at all: the flood is its first window message, from the document's start.
  preHeavy: {
    shell: false,
    body: `<!doctype html><meta charset="utf-8"><p>no hello</p><script>
      var pad = []; for (var i = 0; i < 300000; i++) pad.push({ a: i });
      var stop = Date.now() + 6000;
      (function send() { parent.postMessage({ kind: 'nothing', pad: pad }, '*'); if (Date.now() < stop) setTimeout(send, 0); })();
    </script>`,
  },
  // Review 3, M2: an honest slider, a write and an emit on every input.
  slider: {
    shell: true,
    body: `<input id="r" type="range" min="0" max="900" value="0" style="position:absolute;left:0;top:50px;width:400px;margin:0">
      <script>document.getElementById('r').addEventListener('input', function (e) { lumitra.setState('count', Number(e.target.value)); lumitra.emit('done'); });</script>`,
  },
  // Review 3, L1: 31 states changed at once, twice; each must end on its last value.
  wide: {
    shell: true,
    body: `<script>lumitra.ready().then(function () {
      for (var i = 0; i < 31; i++) lumitra.setState('w' + i, 5);
      setTimeout(function () { for (var i = 0; i < 31; i++) lumitra.setState('w' + i, 7); }, 300);
    });</script>`,
  },
  // L2: a message that is not an object.
  nulls: { shell: false, body: raw("for (var i = 0; i < 5; i++) port.postMessage(null);") },
  // L1: a nested frame of the block floods the page's window.
  nested: {
    shell: false,
    body: raw(`
      var f = document.createElement('iframe');
      f.srcdoc = '<scr' + 'ipt>var s = Date.now() + 4000; (function b() { for (var i = 0; i < 500; i++) top.postMessage({ kind: "nothing" }, "*"); if (Date.now() < s) setTimeout(b, 0); })();</scr' + 'ipt>';
      document.body.appendChild(f);
    `),
  },
  // L3: 85 messages in each of three seconds stays under the ceiling; 95 in one second does not.
  band: {
    shell: false,
    body: raw(`
      var burst = function (n) { for (var i = 1; i <= 85; i++) port.postMessage({ kind: 'setState', id: 'count', value: n * 100 + i }); };
      burst(1); setTimeout(function () { burst(2); }, 1150); setTimeout(function () { burst(3); }, 2300);
    `),
  },
  ceiling: { shell: false, body: raw("for (var i = 1; i <= 95; i++) port.postMessage({ kind: 'setState', id: 'count', value: i });") },
  // M2 and M3: honest bursts through the shell client, which coalesces them; each ends on a known last value.
  animate: {
    shell: true,
    body: `<script>lumitra.ready().then(function () {
      var stop = performance.now() + 2000, i = 0;
      (function tick() {
        lumitra.setState('count', (i++ % 500) + 1); lumitra.setState('count', (i++ % 500) + 1);
        if (performance.now() < stop) requestAnimationFrame(tick); else lumitra.setState('count', 777);
      })();
      var fast = setInterval(function () { lumitra.setState('n', i % 9); lumitra.setState('n', (i + 1) % 9); }, 4);
      setTimeout(function () { clearInterval(fast); lumitra.setState('n', 6); }, 2000);
    });</script>`,
  },
  growing: {
    shell: true,
    body: `<script>lumitra.ready().then(function () {
      var start = performance.now();
      (function tick() {
        var t = Math.min(1, (performance.now() - start) / 600);
        lumitra.resize(Math.round(100 + 300 * t));
        if (t < 1) requestAnimationFrame(tick);
      })();
    });</script>`,
  },
  // Takes the keyboard only while the pointer moves over it, and reports what it was typed.
  hoverThief: {
    shell: true,
    body: `<input id="i" aria-label="inside" style="width:90%;height:150px"><script>
      var i = document.getElementById('i');
      addEventListener('mousemove', function () { if (document.activeElement !== i) i.focus(); });
      i.addEventListener('input', function () { parent.postMessage({ probe: true, typed: i.value }, '*'); });
    </script>`,
  },
  go: { shell: true, body: `<script>lumitra.ready().then(function () { lumitra.emit('go'); });</script>` },
  steal: { shell: true, body: `<input id="i" aria-label="inside"><script>setInterval(function () { document.getElementById('i').focus(); }, 300);</script>` },
  calm: { shell: true, body: `<input id="i" aria-label="inside" style="width:90%;height:60px">` },
};

/** What each engine did where the tests accept more than one outcome, for the plan's record. */
const RECORD = path.join(os.tmpdir(), 'custom-code-bridge.log');
const record = (line: string): void => fs.appendFileSync(RECORD, `${new Date().toISOString()} ${line}\n`);

const HASHES = Object.fromEntries(Object.keys(DOCUMENTS).map((name) => [hashOf(name), name]));

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

const STATES: Record<string, BlockState | { type: 'text' }> = {
  tab: { type: 'choice', options: ['a', 'b'] },
  n: { type: 'number', min: 0, max: 9 },
  count: { type: 'number', min: 0, max: 1000 },
  // Review 3, L1: 31 states one block writes together.
  ...Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`w${i}`, { type: 'number', min: 0, max: 1000 }])),
  done: { type: 'boolean' },
  went: { type: 'boolean' },
};

const PROGRAM: BehaviourProgram = {
  nodes: {
    page: [{
      state: [
        { id: 'tab', type: 'choice', initial: 'a', options: ['a', 'b'] },
        { id: 'n', type: 'number', initial: 0, min: 0, max: 9 },
        { id: 'count', type: 'number', initial: 0, min: 0, max: 1000 },
        ...Array.from({ length: 31 }, (_, i) => ({ id: `w${i}`, type: 'number', initial: 0, min: 0, max: 1000 })),
        { id: 'done', type: 'boolean', initial: false },
        { id: 'went', type: 'boolean', initial: false },
        { id: 'name', type: 'text', initial: '' },
      ],
      on: [
        { id: 'done', on: 'custom:done', do: [{ set: 'done', value: true }] },
        // Past the parser, which refuses navigate here: the run-time rule must hold alone.
        { id: 'go', on: 'custom:go', do: [{ navigate: '/away' }, { set: 'went', value: true }] },
      ],
    }],
    toB: [{ on: [{ id: 'b', on: 'click', do: [{ set: 'tab', value: 'b' }] }] }],
  },
} as unknown as BehaviourProgram;

interface BlockSpec {
  id: string;
  doc: string;
  block?: Partial<IslandBlock>;
  /** Pixels of space above the box. */
  below?: number;
}

const blockOf = (spec: BlockSpec): IslandBlock => ({
  src: `${BOX}/box/${SITE}/${hashOf(spec.doc)}`,
  title: `Block ${spec.id}`,
  reads: ['tab'],
  writes: ['n', 'count'],
  emits: ['custom:done', 'custom:go'],
  sizing: 'fixed',
  interactive: true,
  states: STATES as Record<string, BlockState>,
  ...spec.block,
});

let bundle = '';

const pageHtml = (blocks: BlockSpec[]) => `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">
<div data-fc-n="page" data-fc-scope data-fcs-tab="a" data-fcs-n="0" data-fcs-count="0" data-fcs-done="false" data-fcs-went="false">
  <input id="outside" aria-label="outside" style="display:block;width:200px;height:40px">
  <button id="toB" data-fc-n="toB" type="button">B</button>
  ${blocks.map((b) => `<div style="height:${b.below ?? 0}px"></div><div id="${b.id}" style="position:relative;width:400px;height:200px"><div data-fallback>Fallback ${b.id}</div></div>`).join('\n')}
</div>
<script>${bundle}</script>
<script>__start(${JSON.stringify(PROGRAM)}, ${JSON.stringify(blocks.map((b) => ({ id: b.id, block: blockOf(b) })))});</script>
</body></html>`;

beforeAll(async () => {
  const result = await build({
    entryPoints: [path.resolve(__dirname, 'customCodeBridge.entry.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    target: 'es2022',
    alias: { '@': path.resolve(__dirname, '../../src') },
  });
  bundle = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
});

interface Opened {
  page: Page;
  context: BrowserContext;
  console: string[];
  requests: string[];
  /** Uncaught errors in the page itself. */
  errors: string[];
}

async function open(browser: Browser, blocks: BlockSpec[], options: { hasTouch?: boolean; quiet?: boolean } = {}): Promise<Opened> {
  const context = await browser.newContext({ hasTouch: options.hasTouch === true, viewport: { width: 900, height: 700 } });
  const page = await context.newPage();
  const consoleLines: string[] = [];
  const requests: string[] = [];
  const errors: string[] = [];
  // From document creation: every write to the page's `n` state, in order, even one made while the page still parses.
  await context.addInitScript(() => {
    const w = window as unknown as { __n: string[] };
    w.__n = [];
    new MutationObserver((records) => {
      for (const record of records) w.__n.push((record.target as Element).getAttribute('data-fcs-n') as string);
    }).observe(document, { subtree: true, attributeFilter: ['data-fcs-n'] });
  });
  // The page's own event loop, ticked every 20 ms from document creation: the longest gap between two ticks is how long
  // the page was unresponsive, however the click that follows it happens to be timed.
  await context.addInitScript(() => {
    const w = window as unknown as { __gap: number };
    let at = performance.now();
    w.__gap = 0;
    setInterval(() => {
      const now = performance.now();
      w.__gap = Math.max(w.__gap, now - at);
      at = now;
    }, 20);
  });
  // When each block's frame was inserted and when it left the page, by block id, on the page's own clock.
  await context.addInitScript(() => {
    const w = window as unknown as { __loadAt: Record<string, number>; __goneAt: Record<string, number> };
    w.__loadAt = {};
    w.__goneAt = {};
    // A frame's load event never reaches the window, so its start is its insertion (the stand-in box answers at once).
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          if ((node as Element).tagName === 'IFRAME' && w.__loadAt[(record.target as Element).id] === undefined) w.__loadAt[(record.target as Element).id] = performance.now();
        }
        for (const node of Array.from(record.removedNodes)) {
          if ((node as Element).tagName === 'IFRAME' && w.__goneAt[(record.target as Element).id] === undefined) w.__goneAt[(record.target as Element).id] = performance.now();
        }
      }
    }).observe(document, { subtree: true, childList: true });
  });
  page.on('console', (message) => consoleLines.push(message.text()));
  page.on('pageerror', (error) => errors.push(error.message));
  await context.route('**/*', (route) => {
    const url = route.request().url();
    requests.push(url);
    if (url === PAGE_URL) {
      const html = pageHtml(blocks);
      return route.fulfill({ status: 200, contentType: 'text/html', headers: { 'content-security-policy': `frame-src ${BOX}/box/` }, body: options.quiet ? html.replace('<script>', '<script>window.__quiet = true;</script><script>') : html });
    }
    const name = url.startsWith(`${BOX}/box/${SITE}/`) ? HASHES[url.slice(-64)] : undefined;
    if (name) {
      const { body, shell } = DOCUMENTS[name];
      return route.fulfill({ status: 200, headers: boxDocumentHeaders([PAGE_HOST], EDITOR), body: shell ? composeBoxDocument(body) : body });
    }
    // The box's violation reports, a navigation away, anything else: answered here, sent nowhere.
    return route.fulfill({ status: 204 });
  });
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  return { page, context, console: consoleLines, requests, errors };
}

const settled = (page: Page) => page.evaluate(() => (window as unknown as { __settled: { id: string; shown: boolean }[] }).__settled);
const probes = (page: Page) => page.evaluate(() => (window as unknown as { __probes: Record<string, unknown>[] }).__probes);
const stateOf = (page: Page, id: string) => page.evaluate((name) => document.querySelector('[data-fc-scope]')?.getAttribute(`data-fcs-${name}`), id);
const frameOf = (page: Page, id: string) => page.evaluate((box) => {
  const frame = document.querySelector(`#${box} iframe`) as HTMLIFrameElement | null;
  return frame ? { attrs: Object.fromEntries([...frame.attributes].map((a) => [a.name, a.value])), height: frame.style.height, visible: frame.style.visibility !== 'hidden' } : null;
}, id);
const fallbackShown = (page: Page, id: string) => page.evaluate((box) => !(document.querySelector(`#${box} [data-fallback]`) as HTMLElement).hidden, id);
/** Waits up to `ms` for a condition in the page, then lets the expectations below decide. */
const until = (page: Page, condition: string, ms: number) => page.waitForFunction(condition, undefined, { timeout: ms }).catch(() => {});
const shownOnce = (id: string) => `window.__settled.some(function (s) { return s.id === ${JSON.stringify(id)} && s.shown; })`;
const removed = (id: string) => `window.__settled.some(function (s) { return s.id === ${JSON.stringify(id)} && !s.shown; })`;

// ---------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------

const firefoxInstalled = fs.existsSync(firefox.executablePath());
if (!firefoxInstalled && process.env.CUSTOM_CODE_GATE_NO_FIREFOX !== '1') {
  throw new Error('Firefox is not installed: run `pnpm exec playwright install firefox`, or set CUSTOM_CODE_GATE_NO_FIREFOX=1 to leave it out on purpose');
}
const ENGINES: [string, BrowserType][] = [['chromium', chromium], ['webkit', webkit], ...(firefoxInstalled ? [['firefox', firefox] as [string, BrowserType]] : [])];

describe.each(ENGINES)('the custom code bridge in %s', (engine, type) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await type.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('frames a block with constant attributes, drops the fallback at hello, and carries reads, writes, emits and resize', async () => {
    const { page, context } = await open(browser, [{ id: 'b1', doc: 'happy', block: { sizing: 'content' } }]);
    try {
      await until(page, `${shownOnce('b1')} && document.querySelector('[data-fc-scope]').getAttribute('data-fcs-done') === 'true'`, 10_000);
      expect(await settled(page)).toEqual([{ id: 'b1', shown: true }]);
      expect(await fallbackShown(page, 'b1')).toBe(false);
      const frame = await frameOf(page, 'b1');
      expect(frame?.attrs).toMatchObject({
        sandbox: 'allow-scripts',
        referrerpolicy: 'no-referrer',
        loading: 'lazy',
        allow: '',
        title: 'Block b1',
        src: `${BOX}/box/${SITE}/${hashOf('happy')}`,
      });
      expect(frame?.visible).toBe(true);
      expect(frame?.height).toBe('321px');
      expect(await stateOf(page, 'done')).toBe('true');
      expect(await stateOf(page, 'n')).toBe('1');
      expect(await probes(page)).toContainEqual({ probe: true, ready: 'a' });
      // A change of a read reaches the frame, whose answer is a declared write.
      await page.click('#toB');
      await until(page, "document.querySelector('[data-fc-scope]').getAttribute('data-fcs-n') === '7'", 5_000);
      expect(await stateOf(page, 'n')).toBe('7');
    } finally {
      await context.close();
    }
  }, 60_000);

  it('ignores a hello from a frame the broker did not create', async () => {
    const { page, context } = await open(browser, [{ id: 'b1', doc: 'happy' }]);
    try {
      await until(page, shownOnce('b1'), 10_000);
      await page.evaluate((src) => {
        const frame = document.createElement('iframe');
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.id = 'foreign';
        frame.src = src;
        // Inside the block's own box, beside its frame: still not a frame the broker made.
        document.getElementById('b1')?.appendChild(frame);
      }, `${BOX}/box/${SITE}/${hashOf('foreign')}`);
      await until(page, "window.__probes.some(function (p) { return Array.isArray(p.states); })", 3_000);
      // Evidence that the foreign frame's script ran and said hello, so the missing `connected` means something.
      await until(page, "window.__probes.some(function (p) { return p.ran === 'foreign'; })", 5_000);
      await page.waitForTimeout(1_000);
      expect(await probes(page)).not.toContainEqual({ probe: true, connected: 'foreign' });
      expect(await settled(page)).toEqual([{ id: 'b1', shown: true }]);
      expect(await frameOf(page, 'b1')).not.toBeNull();
    } finally {
      await context.close();
    }
  }, 60_000);

  // Review 3 of pull request #452, M1: after hello a window message of the frame is only counted, never read, so a
  // second hello is ignored like any other; a reload still ends the frame by its second load.
  it('ignores a second hello, and removes a frame that loads a second time', async () => {
    const { page, context, console: lines } = await open(browser, [{ id: 'twice', doc: 'double' }, { id: 'again', doc: 'reload' }]);
    try {
      await until(page, removed('again'), 10_000);
      await page.waitForTimeout(300);
      expect(await settled(page)).toEqual(expect.arrayContaining([{ id: 'twice', shown: true }, { id: 'again', shown: true }, { id: 'again', shown: false }]));
      expect(await settled(page)).not.toContainEqual({ id: 'twice', shown: false });
      expect(await frameOf(page, 'twice')).not.toBeNull();
      expect(await frameOf(page, 'again')).toBeNull();
      expect(await fallbackShown(page, 'again')).toBe(true);
      expect(lines.filter((line) => line.startsWith('Custom code "Block twice"'))).toEqual([]);
      expect(lines.join('\n')).toContain('Custom code "Block again": loaded twice: removed');
    } finally {
      await context.close();
    }
  }, 60_000);

  it('drops undeclared ids, wrong types, out of range values, text state, oversize and unknown messages, and keeps the declared one', async () => {
    const textState = { name: { type: 'text' } } as unknown as Record<string, BlockState>;
    const { page, context, console: lines } = await open(browser, [{
      id: 'h',
      doc: 'hostile',
      // As if the server had let text state through: the broker refuses it on its own.
      block: { title: 'Hostile', reads: ['tab', 'name'], writes: ['n', 'name', 'tab'], emits: ['custom:go'], states: { ...STATES, ...textState } as Record<string, BlockState> },
    }]);
    try {
      await until(page, "window.__probes.some(function (p) { return Array.isArray(p.states); })", 10_000);
      expect(await page.evaluate(() => (window as unknown as { __n: string[] }).__n)).toEqual(['3']);
      expect(await stateOf(page, 'tab')).toBe('a');
      expect(await stateOf(page, 'done')).toBe('false');
      // The text state the frame tried to write ('leak') was never written to the page.
      expect(await stateOf(page, 'name')).toBeNull();
      // The frame was sent its one allowed read, never the text state.
      expect((await probes(page)).find((p) => Array.isArray(p.states))?.states).toEqual(['tab']);
      expect((await frameOf(page, 'h'))?.height).toBe('100%');
      // Twelve refusals, all but the last message (other, '5', 99, -1, NaN, 'c', the text state, the oversize one,
      // navigate, a resize of a fixed block, an undeclared emit and one without its prefix), shown by the state and
      // the height above, and warned of once: a frame cannot fill the page's console (D65).
      const warnings = lines.filter((line) => line.startsWith('Custom code "Hostile"'));
      expect(warnings).toEqual(['Custom code "Hostile": dropped a message or error, then silent']);
      expect(await frameOf(page, 'h')).not.toBeNull();
    } finally {
      await context.close();
    }
  }, 60_000);

  it('drops what goes past 30 messages, takes every resize within them, and clamps a height to 10,000 pixels', async () => {
    const { page, context, console: lines } = await open(browser, [
      { id: 'f', doc: 'flood' },
      { id: 'r', doc: 'resizer', block: { sizing: 'content' } },
    ]);
    try {
      // All 15 resizes of the first second are taken (review 2, M3: no rule of the first 10), so it ends at the 15th.
      await until(page, "document.querySelector('#r iframe') && document.querySelector('#r iframe').style.height === '115px'", 5_000);
      expect((await frameOf(page, 'r'))?.height).toBe('115px');
      await until(page, "document.querySelector('[data-fc-scope]').getAttribute('data-fcs-count') === '41'", 10_000);
      await until(page, "document.querySelector('#r iframe') && document.querySelector('#r iframe').style.height === '10000px'", 5_000);
      expect(await stateOf(page, 'count')).toBe('41');
      // Past 30 is dropped, and warned of once; 40 in a second is under the ceiling that removes a frame.
      expect(lines.filter((line) => line.startsWith('Custom code "Block f"'))).toEqual(['Custom code "Block f": dropped a message or error, then silent']);
      expect(await frameOf(page, 'f')).not.toBeNull();
      expect((await frameOf(page, 'r'))?.height).toBe('10000px');
      expect(lines.filter((line) => line.startsWith('Custom code "Block r"'))).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  it('removes a frame that floods its port or the window, and the page answers a click meanwhile', async () => {
    const { page, context, console: lines } = await open(browser, [{ id: 'port', doc: 'deluge' }, { id: 'win', doc: 'windowDeluge' }]);
    try {
      // The flood starts at connect: the click goes in while it runs.
      await until(page, `${shownOnce('port')} && ${shownOnce('win')}`, 10_000);
      const started = Date.now();
      await page.click('#toB');
      await until(page, "document.querySelector('[data-fc-scope]').getAttribute('data-fcs-tab') === 'b'", 10_000);
      const click = Date.now() - started;
      await until(page, `${removed('port')} && ${removed('win')}`, 5_000);
      // Whatever the click's timing against the removals: across the whole flood the page's loop was never held for long.
      const gap = await page.evaluate(() => (window as unknown as { __gap: number }).__gap);
      record(`flood in ${engine}: longest gap in the page's loop ${Math.round(gap)} ms`);
      expect(gap).toBeLessThan(1_000);
      record(`flood in ${engine}: click answered in ${click} ms`);
      expect(await stateOf(page, 'tab')).toBe('b');
      expect(click).toBeLessThan(2_000);
      for (const id of ['port', 'win']) {
        expect(await frameOf(page, id)).toBeNull();
        expect(await fallbackShown(page, id)).toBe(true);
        const own = lines.filter((line) => line.startsWith(`Custom code "Block ${id}"`));
        expect(own.at(-1)).toBe(`Custom code "Block ${id}": flooded: removed`);
        // At most the one warning before it.
        expect(own.length).toBeLessThanOrEqual(2);
      }
    } finally {
      await context.close();
    }
  }, 60_000);

  it('refuses a message JSON cannot weigh (a buffer, a Map), and removes the frame at the second', async () => {
    const { page, context, console: lines } = await open(browser, [{ id: 'bin', doc: 'binary' }]);
    try {
      await until(page, removed('bin'), 10_000);
      expect(await stateOf(page, 'n')).toBe('0');
      expect(await frameOf(page, 'bin')).toBeNull();
      expect(lines.filter((line) => line.startsWith('Custom code "Block bin"'))).toEqual([
        'Custom code "Block bin": dropped a message or error, then silent',
        'Custom code "Block bin": not plain data or over 64 KB: removed',
      ]);
    } finally {
      await context.close();
    }
  }, 60_000);

  /** Milliseconds from a click on the page's button to the state it sets, with any frame beside it. */
  const clickToState = async (page: Page): Promise<number> => {
    const started = Date.now();
    await page.click('#toB', { timeout: 30_000 });
    await until(page, "document.querySelector('[data-fc-scope]').getAttribute('data-fcs-tab') === 'b'", 30_000);
    return Date.now() - started;
  };

  it('removes a frame that sends sparse arrays of ten million slots, and the page answers a click meanwhile', async () => {
    const { page, context, console: lines } = await open(browser, [{ id: 'sp', doc: 'sparse' }]);
    try {
      await until(page, shownOnce('sp'), 10_000);
      await page.waitForTimeout(150);
      const click = await clickToState(page);
      await until(page, removed('sp'), 5_000);
      record(`sparse flood in ${engine}: click answered in ${click} ms`);
      expect(click).toBeLessThan(2_000);
      expect(await stateOf(page, 'n')).toBe('0');
      expect(lines.filter((line) => line.startsWith('Custom code "Block sp"'))).toEqual([
        'Custom code "Block sp": dropped a message or error, then silent',
        'Custom code "Block sp": not plain data or over 64 KB: removed',
      ]);
    } finally {
      await context.close();
    }
  }, 60_000);

  it('drops one array of the greatest length there is at the cost of a small message, and takes the next write', async () => {
    const { page, context } = await open(browser, [{ id: 'huge', doc: 'sparseHuge' }]);
    try {
      await until(page, shownOnce('huge'), 10_000);
      const click = await clickToState(page);
      await until(page, "document.querySelector('[data-fc-scope]').getAttribute('data-fcs-n') === '2'", 10_000);
      record(`one huge sparse array in ${engine}: click answered in ${click} ms`);
      expect(click).toBeLessThan(2_000);
      expect(await stateOf(page, 'n')).toBe('2');
      expect(await settled(page)).toEqual([{ id: 'huge', shown: true }]);
    } finally {
      await context.close();
    }
  }, 60_000);

  it('removes a frame at its second message over 64 KB, as with data that is not plain', async () => {
    const { page, context, console: lines } = await open(browser, [{ id: 'bulk', doc: 'bulky' }]);
    try {
      await until(page, removed('bulk'), 10_000);
      expect(await stateOf(page, 'n')).toBe('0');
      expect(lines.filter((line) => line.startsWith('Custom code "Block bulk"'))).toEqual([
        'Custom code "Block bulk": dropped a message or error, then silent',
        'Custom code "Block bulk": not plain data or over 64 KB: removed',
      ]);
    } finally {
      await context.close();
    }
  }, 60_000);

  it('treats a null message as not plain, without an error in the page', async () => {
    const { page, context, console: lines, errors } = await open(browser, [{ id: 'nul', doc: 'nulls' }]);
    try {
      await until(page, removed('nul'), 10_000);
      expect(lines.filter((line) => line.startsWith('Custom code "Block nul"')).at(-1)).toBe('Custom code "Block nul": not plain data or over 64 KB: removed');
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  it("counts a nested frame's messages to the page as the block's, and removes the block for its flood", async () => {
    const { page, context, console: lines } = await open(browser, [{ id: 'nest', doc: 'nested' }]);
    try {
      await until(page, removed('nest'), 10_000);
      expect(await frameOf(page, 'nest')).toBeNull();
      expect(lines.filter((line) => line.startsWith('Custom code "Block nest"')).at(-1)).toBe('Custom code "Block nest": flooded: removed');
    } finally {
      await context.close();
    }
  }, 60_000);

  it('keeps a frame at 85 messages a second, dropping past 30, and removes one at 95 in a second', async () => {
    const { page, context, console: lines } = await open(browser, [{ id: 'band', doc: 'band' }, { id: 'over', doc: 'ceiling' }]);
    try {
      await until(page, removed('over'), 10_000);
      await until(page, "document.querySelector('[data-fc-scope]').getAttribute('data-fcs-count') > 300", 6_000);
      await page.waitForTimeout(500);
      expect(lines.filter((line) => line.startsWith('Custom code "Block over"')).at(-1)).toBe('Custom code "Block over": flooded: removed');
      expect(await settled(page)).not.toContainEqual({ id: 'band', shown: false });
      expect(await frameOf(page, 'band')).not.toBeNull();
      // The third second's writes past its 30th were dropped: the last taken is at most 330.
      const count = Number(await stateOf(page, 'count'));
      expect(count).toBeGreaterThan(300);
      expect(count).toBeLessThanOrEqual(330);
      expect(lines.filter((line) => line.startsWith('Custom code "Block band"'))).toEqual(['Custom code "Block band": dropped a message or error, then silent']);
    } finally {
      await context.close();
    }
  }, 60_000);

  it('keeps an honest block that writes from every animation frame and a 4 ms timer, and takes its last writes', async () => {
    const { page, context, console: lines } = await open(browser, [{ id: 'anim', doc: 'animate' }]);
    try {
      await until(page, `${shownOnce('anim')} && document.querySelector('[data-fc-scope]').getAttribute('data-fcs-count') === '777' && document.querySelector('[data-fc-scope]').getAttribute('data-fcs-n') === '6'`, 15_000);
      expect(await stateOf(page, 'count')).toBe('777');
      expect(await stateOf(page, 'n')).toBe('6');
      expect(await settled(page)).toEqual([{ id: 'anim', shown: true }]);
      expect(lines.filter((line) => line.startsWith('Custom code "Block anim"'))).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  it('ends a growing content block at its last height', async () => {
    const { page, context, console: lines } = await open(browser, [{ id: 'grow', doc: 'growing', block: { sizing: 'content' } }]);
    try {
      await until(page, "document.querySelector('#grow iframe') && document.querySelector('#grow iframe').style.height === '400px'", 10_000);
      await page.waitForTimeout(300);
      expect((await frameOf(page, 'grow'))?.height).toBe('400px');
      expect(await settled(page)).toEqual([{ id: 'grow', shown: true }]);
      expect(lines.filter((line) => line.startsWith('Custom code "Block grow"'))).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  // Review 3 of pull request #452, M2: emits are coalesced with writes, so a dragged slider is not a flood.
  it('keeps an honest slider dragged with the mouse, a write and an emit on every input, and ends on its last value', async () => {
    const { page, context, console: lines } = await open(browser, [{ id: 'sl', doc: 'slider' }]);
    try {
      await until(page, shownOnce('sl'), 10_000);
      const box = await page.locator('#sl iframe').boundingBox();
      if (!box) throw new Error('no frame');
      const input = page.frameLocator('#sl iframe').locator('#r');
      await input.waitFor({ timeout: 10_000 });
      await page.mouse.move(box.x + 2, box.y + 58);
      await page.mouse.down();
      for (let step = 1; step <= 90; step++) {
        await page.mouse.move(box.x + 2 + (396 * step) / 90, box.y + 58);
        await page.waitForTimeout(16);
      }
      await page.mouse.up();
      const last = await input.inputValue();
      await until(page, `document.querySelector('[data-fc-scope]').getAttribute('data-fcs-count') === ${JSON.stringify(last)}`, 5_000);
      await page.waitForTimeout(300);
      record(`slider in ${engine}: ended at ${last}`);
      expect(Number(last)).toBeGreaterThan(800);
      expect(await stateOf(page, 'count')).toBe(last);
      expect(await stateOf(page, 'done')).toBe('true');
      expect(await settled(page)).toEqual([{ id: 'sl', shown: true }]);
      expect(lines.filter((line) => line.startsWith('Custom code "Block sl"'))).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  // Review 3, L1: the shell sends at most 25 a second, so 31 states changed at once all arrive, at their last values.
  it('takes 31 states written in one flush, each at its last value', async () => {
    const ids = Array.from({ length: 31 }, (_, i) => `w${i}`);
    const { page, context, console: lines } = await open(browser, [{ id: 'wd', doc: 'wide', block: { writes: ids } }]);
    try {
      const all = ids.map((id) => `document.querySelector('[data-fc-scope]').getAttribute('data-fcs-${id}') === '7'`).join(' && ');
      await until(page, all, 10_000);
      for (const id of ids) expect(await stateOf(page, id), id).toBe('7');
      expect(await settled(page)).toEqual([{ id: 'wd', shown: true }]);
      expect(lines.filter((line) => line.startsWith('Custom code "Block wd"'))).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60_000);

  it("never lets a frame's event drive navigate", async () => {
    const { page, context, requests } = await open(browser, [{ id: 'g', doc: 'go' }]);
    try {
      await until(page, "document.querySelector('[data-fc-scope]').getAttribute('data-fcs-went') === 'true'", 10_000);
      await page.waitForTimeout(500);
      expect(await stateOf(page, 'went')).toBe('true');
      expect(page.url()).toBe(PAGE_URL);
      expect(requests).not.toContain(`https://${PAGE_HOST}/away`);
    } finally {
      await context.close();
    }
  }, 60_000);

  it('removes a frame with no hello within 5 seconds of its load, and one that stops answering pings, and keeps a healthy one', async () => {
    const blocks: BlockSpec[] = [{ id: 'quiet', doc: 'silent' }, { id: 'mute', doc: 'mute' }, { id: 'well', doc: 'calm' }];
    const { page, context, console: lines } = await open(browser, blocks);
    try {
      await until(page, removed('quiet'), 9_000);
      // Measured from the frame's own load, on the page's clock: the deadline is 5 seconds, so a 7 second one fails.
      const { loaded, gone } = await page.evaluate(() => {
        const w = window as unknown as { __loadAt: Record<string, number>; __goneAt: Record<string, number> };
        return { loaded: w.__loadAt.quiet, gone: w.__goneAt.quiet };
      });
      expect(loaded).toBeDefined();
      expect(gone).toBeDefined();
      expect(gone - loaded).toBeGreaterThanOrEqual(4_500);
      expect(gone - loaded).toBeLessThan(6_000);
      expect(await frameOf(page, 'quiet')).toBeNull();
      expect(await settled(page)).toContainEqual({ id: 'quiet', shown: false });
      expect(await settled(page)).not.toContainEqual({ id: 'quiet', shown: true });
      // Three pings unanswered, removed at the fourth tick: about 20 seconds after hello.
      await until(page, removed('mute'), 30_000);
      for (const id of ['mute']) {
        expect(await frameOf(page, id)).toBeNull();
        expect(await fallbackShown(page, id)).toBe(true);
        expect(lines.join('\n')).toContain(`Custom code "Block ${id}": no pong: removed`);
      }
      expect(lines.join('\n')).toContain('Custom code "Block quiet": no hello: removed');
      expect(await settled(page)).not.toContainEqual({ id: 'well', shown: false });
      expect(await frameOf(page, 'well')).not.toBeNull();
    } finally {
      await context.close();
    }
  }, 90_000);

  // A frame that never returns to its event loop. Its own browser, launched with the isolation the
  // desktop browser ships with (Chromium's site per process, Firefox's Fission), and closed by force, so a
  // frame that holds the page too cannot hold the run: every read below is bounded and ends on an expectation.
  it('removes a frozen frame, where the engine runs it apart from the page', async () => {
    const own = await type.launch(
      engine === 'chromium' ? { args: ['--site-per-process'] } : engine === 'firefox' ? { firefoxUserPrefs: { 'fission.autostart': true } } : {},
    );
    const steps: string[] = [];
    const bounded = <T,>(work: Promise<T>, ms: number, what: string): Promise<T | 'stuck'> =>
      Promise.race([work, new Promise<'stuck'>((resolve) => setTimeout(() => resolve('stuck'), ms))]).then((result) => {
        steps.push(`${what}: ${result === 'stuck' ? 'stuck' : 'answered'}`);
        return result;
      });
    try {
      const opened = await bounded(open(own, [{ id: 'frozen', doc: 'frozen' }, { id: 'well', doc: 'calm' }]), 15_000, 'open');
      if (opened === 'stuck') throw new Error(`the page did not open: ${steps.join('; ')}`);
      const { page, console: lines } = opened;
      await bounded(until(page, removed('frozen'), 35_000), 40_000, 'wait for removal');
      const after = await bounded(settled(page), 5_000, 'read the page');
      const report = { engine, steps, after, removedLine: lines.some((line) => line.includes('"Block frozen": no pong: removed')) };
      record(`frozen frame in ${engine}: ${JSON.stringify(report)}`);
      if (engine !== 'chromium') {
        // WebKit, and Firefox as Playwright runs it (Fission does not start there, even asked), run a frame
        // of another site in the page's own process: a frozen frame holds the page too (a residual of the
        // plan, M7). What is asserted is that, so a change in either engine shows here.
        expect(after === 'stuck' || (Array.isArray(after) && after.some((s) => s.id === 'frozen' && !s.shown))).toBe(true);
      } else {
        // The page answered throughout, and the frozen frame is gone. Every box frame is of one site, so
        // they share a process: the healthy frame beside it stopped with it, and went with it.
        expect(after).toEqual(expect.arrayContaining([{ id: 'frozen', shown: true }, { id: 'frozen', shown: false }]));
        expect(report.steps).toEqual(['open: answered', 'wait for removal: answered', 'read the page: answered']);
        expect(report.removedLine).toBe(true);
      }
    } finally {
      await Promise.race([own.close(), new Promise((resolve) => setTimeout(resolve, 10_000))]);
    }
  }, 90_000);

  it('creates a frame only once its box is within one viewport, so its hello clock starts at its load', async () => {
    const { page, context } = await open(browser, [{ id: 'far', doc: 'happy', below: 3000 }]);
    try {
      await page.waitForTimeout(6_500);
      expect(await frameOf(page, 'far')).toBeNull();
      expect(await settled(page)).toEqual([]);
      await page.evaluate(() => document.getElementById('far')?.scrollIntoView());
      await until(page, shownOnce('far'), 10_000);
      expect(await settled(page)).toEqual([{ id: 'far', shown: true }]);
    } finally {
      await context.close();
    }
  }, 60_000);

  /**
   * Takes the keyboard back to the page until the frame is gone or six attempts counted, and notes after
   * each what holds it: the frame (its script took it again), the page, or nothing because the frame is gone.
   * A theft needs the page to have held the keyboard first: an attempt where the outside input never got
   * focus (Firefox sometimes does not apply `focus()` while a frame in the page's process holds the
   * keyboard) is noted `NOFOCUS`, is not a theft the broker could see, and does not count. Twelve attempts
   * in all bound the loop, so an engine that never gives the page focus fails on the count, not on time.
   */
  async function steal(page: Page, id: string, removingTheft: number): Promise<string[]> {
    const moves: string[] = [];
    // As a visitor's tab is: in front.
    await page.bringToFront();
    await page.evaluate(() => {
      const w = window as unknown as { __pageFocus: number };
      w.__pageFocus = 0;
      document.getElementById('outside')?.addEventListener('focus', () => (w.__pageFocus += 1));
    });
    const counted = () => moves.filter((move) => move !== 'NOFOCUS').length;
    for (let i = 0; i < 12 && counted() < 6 && !(await settled(page)).some((s) => !s.shown); i++) {
      // Blurred first, so focusing it is a change an engine announces even where the page kept the keyboard.
      const before = await page.evaluate(() => {
        (document.activeElement as HTMLElement | null)?.blur();
        return (window as unknown as { __pageFocus: number }).__pageFocus;
      });
      await page.focus('#outside');
      await until(page, `window.__pageFocus > ${before}`, 3_000);
      if ((await page.evaluate(() => (window as unknown as { __pageFocus: number }).__pageFocus)) === before) {
        moves.push('NOFOCUS');
        continue;
      }
      await until(page, `document.activeElement && document.activeElement.tagName === 'IFRAME' || ${removed(id)}`, 3_000);
      // The broker looks a task after the page lost the keyboard, or at its next ping where the engine held
      // the event back: the theft that should remove the frame gets a ping's time, the others a moment.
      if (counted() + 1 === removingTheft) await until(page, removed(id), 6_000);
      else await page.waitForTimeout(200);
      moves.push(await page.evaluate((box) => (window as unknown as { __settled: { id: string; shown: boolean }[] }).__settled.some((s) => s.id === box && !s.shown)
        ? 'removed'
        : document.activeElement?.tagName ?? '', id));
    }
    record(`focus moves in ${engine} for ${id}: ${moves.join(', ')}`);
    return moves.filter((move) => move !== 'NOFOCUS');
  }

  // An engine that does not let a frame of another site take the keyboard from the page by script
  // leaves nothing for the watch to do: that is asserted as such, so a change in the engine shows here.
  it('removes an interactive frame that takes the keyboard three times', async () => {
    const { page, context, console: lines } = await open(browser, [{ id: 'thief', doc: 'steal' }]);
    try {
      await until(page, shownOnce('thief'), 10_000);
      const moves = await steal(page, 'thief', 3);
      if (moves.some((move) => move === 'IFRAME' || move === 'removed')) {
        expect(moves).toEqual(['IFRAME', 'IFRAME', 'removed']);
        expect(lines.join('\n')).toContain('Custom code "Block thief": took the keyboard 3 times: removed');
      } else {
        expect(moves.length).toBeGreaterThanOrEqual(4);
        expect(moves.every((move) => move === 'INPUT')).toBe(true);
        expect(await settled(page)).toEqual([{ id: 'thief', shown: true }]);
      }
    } finally {
      await context.close();
    }
  }, 60_000);

  it('removes a frame that is not interactive the first time it takes the keyboard', async () => {
    const { page, context, console: lines } = await open(browser, [{ id: 'still', doc: 'steal', block: { interactive: false } }]);
    try {
      await until(page, shownOnce('still'), 10_000);
      const moves = await steal(page, 'still', 1);
      if (moves.some((move) => move === 'IFRAME' || move === 'removed')) {
        expect(moves).toEqual(['removed']);
        expect(lines.join('\n')).toContain('Custom code "Block still": took the keyboard: removed');
      } else {
        expect(moves.length).toBeGreaterThanOrEqual(4);
        expect(moves.every((move) => move === 'INPUT')).toBe(true);
      }
    } finally {
      await context.close();
    }
  }, 60_000);

  it('keeps an interactive frame a person clicks and tabs into, again and again', async () => {
    const { page, context } = await open(browser, [{ id: 'calm', doc: 'calm' }]);
    try {
      await until(page, shownOnce('calm'), 10_000);
      const inside = page.frameLocator('#calm iframe').locator('#i');
      for (let i = 0; i < 4; i++) {
        await inside.click();
        await page.click('#outside');
      }
      for (let i = 0; i < 4; i++) {
        await page.focus('#toB');
        await page.keyboard.press('Tab');
        await page.waitForTimeout(150);
        // Tab went into the frame: the page's active element is then the frame itself. Where Shift+Tab lands differs by engine (Firefox keeps it in the frame's own document first), so only the frame's survival is held after it.
        expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('IFRAME');
        await page.keyboard.press('Shift+Tab');
      }
      await page.waitForTimeout(300);
      expect(await settled(page)).toEqual([{ id: 'calm', shown: true }]);
      expect(await frameOf(page, 'calm')).not.toBeNull();
    } finally {
      await context.close();
    }
  }, 60_000);

  // Where an engine holds the page's focus events back, only the next ping sees a person's click into the
  // frame, up to 5 seconds later, by when the pointer may have left: the late look must still excuse it.
  it('keeps an interactive frame a person clicks into and then leaves the pointer elsewhere, past a ping', async () => {
    const { page, context } = await open(browser, [{ id: 'calm', doc: 'calm' }]);
    try {
      await until(page, shownOnce('calm'), 10_000);
      const inside = page.frameLocator('#calm iframe').locator('#i');
      for (let i = 0; i < 3; i++) {
        await inside.click();
        await page.mouse.move(5, 5);
        await page.waitForTimeout(5_500);
        await page.click('#outside');
      }
      expect(await settled(page)).toEqual([{ id: 'calm', shown: true }]);
      expect(await frameOf(page, 'calm')).not.toBeNull();
    } finally {
      await context.close();
    }
  }, 60_000);

  it('keeps an interactive frame a person taps into on a touch screen', async () => {
    const { page, context } = await open(browser, [{ id: 'calm', doc: 'calm' }], { hasTouch: true });
    try {
      await until(page, shownOnce('calm'), 10_000);
      const box = await page.locator('#calm iframe').boundingBox();
      const outside = await page.locator('#outside').boundingBox();
      if (!box || !outside) throw new Error('no box to tap');
      for (let i = 0; i < 4; i++) {
        await page.touchscreen.tap(box.x + 40, box.y + 20);
        await page.waitForTimeout(150);
        await page.touchscreen.tap(outside.x + 10, outside.y + 10);
        await page.waitForTimeout(150);
      }
      expect(await settled(page)).toEqual([{ id: 'calm', shown: true }]);
      expect(await frameOf(page, 'calm')).not.toBeNull();
    } finally {
      await context.close();
    }
  }, 60_000);

  // The review's probe (pull request #452, review 1, M2): a frame that takes the keyboard only while the pointer
  // moves over it, so the pointer excuses every move. Typing in the page just before the move does not.
  it('removes a frame that takes the keyboard under the pointer while the visitor types in the page', async () => {
    const { page, context, console: lines } = await open(browser, [{ id: 'hover', doc: 'hoverThief' }]);
    try {
      await until(page, shownOnce('hover'), 10_000);
      await page.bringToFront();
      const box = await page.locator('#hover iframe').boundingBox();
      if (!box) throw new Error('no frame to move onto');
      for (let n = 0; n < 6 && !(await settled(page)).some((s) => !s.shown); n++) {
        await page.click('#outside');
        await page.keyboard.type('p');
        await page.mouse.move(box.x + 60 + n * 7, box.y + 40, { steps: 4 });
        await page.waitForTimeout(100);
        await page.keyboard.type(`k${n}`);
        await page.waitForTimeout(300);
      }
      const typed = (await probes(page)).filter((p) => typeof p.typed === 'string').map((p) => p.typed as string).at(-1) ?? '';
      const outside = await page.inputValue('#outside');
      record(`hover theft in ${engine}: frame got ${JSON.stringify(typed)}, page field ${JSON.stringify(outside)}`);
      // The rounds whose keys the frame got: each is a move it made under the pointer.
      const rounds = typed.match(/k\d/g)?.length ?? 0;
      const gone = (await settled(page)).some((s) => s.id === 'hover' && !s.shown);
      if (gone) {
        // Removed at its third move, before that round's keys: it never got a third round's keys or later.
        expect(lines.join('\n')).toContain('Custom code "Block hover": took the keyboard 3 times: removed');
        expect(rounds).toBeLessThanOrEqual(2);
        expect(typed).not.toMatch(/k[2-5]/);
      } else if (typed) {
        // The engine let the frame take the keyboard fewer than three times in six rounds (Firefox in this harness
        // stops honouring its focus() after a round or two): nothing to remove yet, and never a third round.
        expect(rounds).toBeLessThan(3);
      } else {
        // An engine that refuses script focus from a frame of another site (WebKit): the page kept every key.
        expect(outside).toBe('pk0pk1pk2pk3pk4pk5');
        expect(await settled(page)).toEqual([{ id: 'hover', shown: true }]);
      }
    } finally {
      await context.close();
    }
  }, 60_000);

  it('keeps an interactive frame a person clicks into after pausing their typing in the page', async () => {
    const { page, context } = await open(browser, [{ id: 'calm', doc: 'calm' }]);
    try {
      await until(page, shownOnce('calm'), 10_000);
      const inside = page.frameLocator('#calm iframe').locator('#i');
      for (let i = 0; i < 4; i++) {
        await page.click('#outside');
        await page.keyboard.type('abc');
        await page.waitForTimeout(700);
        // Short and caught: a frame wrongly removed fails on the expectations below, not on a click's timeout.
        await inside.click({ timeout: 2_000 }).catch(() => {});
        await page.keyboard.type('x');
      }
      await page.waitForTimeout(300);
      expect(await settled(page)).toEqual([{ id: 'calm', shown: true }]);
      expect(await frameOf(page, 'calm')).not.toBeNull();
    } finally {
      await context.close();
    }
  }, 60_000);

  // Review 2, M4: keys that are not typing into a page field (arrows on the page) are not the typing signal.
  it('keeps an interactive frame a person clicks into right after scrolling with the arrow keys', async () => {
    const { page, context } = await open(browser, [{ id: 'calm', doc: 'calm' }]);
    try {
      await until(page, shownOnce('calm'), 10_000);
      const inside = page.frameLocator('#calm iframe').locator('#i');
      for (let i = 0; i < 4; i++) {
        await page.click('body', { position: { x: 2, y: 2 } });
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('ArrowUp');
        await page.waitForTimeout(250);
        await inside.click({ timeout: 2_000 }).catch(() => {});
      }
      await page.waitForTimeout(300);
      expect(await settled(page)).toEqual([{ id: 'calm', shown: true }]);
      expect(await frameOf(page, 'calm')).not.toBeNull();
    } finally {
      await context.close();
    }
  }, 60_000);
});

// Review 3 of pull request #452, M1: under site isolation, as desktop Chrome ships it, the frame runs in its own
// process, so only the broker stands between its window messages and the page. The page reads no message's data
// itself here (`quiet`), so whatever the click costs is the broker's.
describe('the custom code bridge in chromium with site isolation', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ args: ['--site-per-process'] });
  });
  afterAll(async () => {
    await browser?.close();
  });

  // Each message costs the frame itself tens of milliseconds to send, so it stays under 90 a second and is kept:
  // what matters is that the page, which only counts them, does not pay.
  it('answers a click while a frame floods the window with costly messages after hello', async () => {
    const { page, context, console: lines } = await open(browser, [{ id: 'heavy', doc: 'winHeavy' }], { quiet: true });
    try {
      await until(page, shownOnce('heavy'), 10_000);
      await page.waitForTimeout(500);
      const started = Date.now();
      // Caught: a page that cannot answer fails on the time below, not on the click's own timeout.
      await page.click('#toB', { timeout: 30_000 }).catch(() => {});
      await until(page, "document.querySelector('[data-fc-scope]').getAttribute('data-fcs-tab') === 'b'", 30_000);
      const click = Date.now() - started;
      record(`costly window flood after hello, site isolation: click answered in ${click} ms; ${lines.filter((line) => line.startsWith('Custom code "Block heavy"')).join(' | ') || 'no line'}`);
      expect(await stateOf(page, 'tab')).toBe('b');
      expect(click).toBeLessThan(2_000);
      // Never anything but a count's outcome: kept, or removed as a flood.
      expect(lines.filter((line) => line.startsWith('Custom code "Block heavy"')).every((line) => line.endsWith('flooded: removed'))).toBe(true);
    } finally {
      await context.close();
    }
  }, 90_000);

  it('removes a frame whose first window message is not a hello, at that message, and answers a click', async () => {
    const { page, context, console: lines } = await open(browser, [{ id: 'pre', doc: 'preHeavy' }], { quiet: true });
    try {
      // At its first message, sent while the frame's document is still parsing, so before its load starts the 5
      // second clock for a missing hello: removed within 5 seconds of the frame's appearing.
      const appeared = Date.now();
      await until(page, "document.querySelector('#pre iframe')", 10_000);
      await until(page, removed('pre'), 3_000);
      const gone = Date.now() - appeared;
      record(`costly first message without hello, site isolation: removed ${gone} ms after the frame was made`);
      expect(await settled(page)).toEqual([{ id: 'pre', shown: false }]);
      expect(gone).toBeLessThan(3_000);
      const started = Date.now();
      // Caught: a page that cannot answer fails on the time below, not on the click's own timeout.
      await page.click('#toB', { timeout: 30_000 }).catch(() => {});
      await until(page, "document.querySelector('[data-fc-scope]').getAttribute('data-fcs-tab') === 'b'", 30_000);
      const click = Date.now() - started;
      record(`costly window flood without hello, site isolation: click answered in ${click} ms`);
      expect(click).toBeLessThan(2_000);
      expect(await settled(page)).toEqual([{ id: 'pre', shown: false }]);
      expect(lines.filter((line) => line.startsWith('Custom code "Block pre"'))).toEqual(['Custom code "Block pre": no hello: removed']);
    } finally {
      await context.close();
    }
  }, 90_000);
});

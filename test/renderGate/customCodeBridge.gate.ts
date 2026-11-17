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
      port.postMessage({ kind: 'setState', id: 'other', value: 5 });
      port.postMessage({ kind: 'setState', id: 'n', value: '5' });
      port.postMessage({ kind: 'setState', id: 'n', value: 99 });
      port.postMessage({ kind: 'setState', id: 'n', value: -1 });
      port.postMessage({ kind: 'setState', id: 'n', value: NaN });
      port.postMessage({ kind: 'setState', id: 'tab', value: 'c' });
      port.postMessage({ kind: 'setState', id: 'name', value: 'leak' });
      port.postMessage({ kind: 'setState', id: 'n', value: 4, pad: 'x'.repeat(70000) });
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
      setTimeout(function () { port.postMessage({ kind: 'resize', height: 50000 }); }, 1300);
    `),
  },
  foreign: { shell: false, body: raw("probe({ connected: 'foreign' });") },
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
}

async function open(browser: Browser, blocks: BlockSpec[], options: { hasTouch?: boolean } = {}): Promise<Opened> {
  const context = await browser.newContext({ hasTouch: options.hasTouch === true, viewport: { width: 900, height: 700 } });
  const page = await context.newPage();
  const consoleLines: string[] = [];
  const requests: string[] = [];
  page.on('console', (message) => consoleLines.push(message.text()));
  await context.route('**/*', (route) => {
    const url = route.request().url();
    requests.push(url);
    if (url === PAGE_URL) {
      return route.fulfill({ status: 200, contentType: 'text/html', headers: { 'content-security-policy': `frame-src ${BOX}/box/` }, body: pageHtml(blocks) });
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
  return { page, context, console: consoleLines, requests };
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
      await page.waitForTimeout(1_000);
      expect(await probes(page)).not.toContainEqual({ probe: true, connected: 'foreign' });
      expect(await settled(page)).toEqual([{ id: 'b1', shown: true }]);
      expect(await frameOf(page, 'b1')).not.toBeNull();
    } finally {
      await context.close();
    }
  }, 60_000);

  it('removes a frame that says hello twice, and one that loads a second time', async () => {
    const { page, context, console: lines } = await open(browser, [{ id: 'twice', doc: 'double' }, { id: 'again', doc: 'reload' }]);
    try {
      await until(page, `${removed('twice')} && ${removed('again')}`, 10_000);
      expect(await settled(page)).toEqual(expect.arrayContaining([{ id: 'twice', shown: true }, { id: 'twice', shown: false }, { id: 'again', shown: true }, { id: 'again', shown: false }]));
      for (const id of ['twice', 'again']) {
        expect(await frameOf(page, id)).toBeNull();
        expect(await fallbackShown(page, id)).toBe(true);
      }
      expect(lines.join('\n')).toContain('Custom code "Block twice": a second hello: removed');
      // A reloaded frame says hello again, and an engine may deliver that before the second load: either removes it.
      expect(lines.join('\n')).toMatch(/Custom code "Block again": (loaded twice|a second hello): removed/);
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
      await page.evaluate(() => {
        const w = window as unknown as { __n: string[] };
        w.__n = [];
        const scope = document.querySelector('[data-fc-scope]') as Element;
        new MutationObserver(() => w.__n.push(scope.getAttribute('data-fcs-n') as string)).observe(scope, { attributeFilter: ['data-fcs-n'] });
      });
      await until(page, "window.__probes.some(function (p) { return Array.isArray(p.states); })", 10_000);
      expect(await page.evaluate(() => (window as unknown as { __n: string[] }).__n)).toEqual(['3']);
      expect(await stateOf(page, 'tab')).toBe('a');
      expect(await stateOf(page, 'done')).toBe('false');
      // The frame was sent its one allowed read, never the text state.
      expect((await probes(page)).find((p) => Array.isArray(p.states))?.states).toEqual(['tab']);
      expect((await frameOf(page, 'h'))?.height).toBe('100%');
      const warnings = lines.filter((line) => line.startsWith('Custom code "Hostile"'));
      // Twelve refusals, all but the last message: other, '5', 99, -1, NaN, 'c', the text state, the oversize one,
      // navigate, a resize of a fixed block, an undeclared emit and one without its prefix.
      expect(warnings).toHaveLength(12);
      expect(warnings.filter((line) => line.endsWith('dropped a message'))).toHaveLength(11);
      expect(warnings.filter((line) => line.endsWith('over 64 KB'))).toHaveLength(1);
      expect(await frameOf(page, 'h')).not.toBeNull();
    } finally {
      await context.close();
    }
  }, 60_000);

  it('drops what goes past 30 messages and 10 resizes a second, and clamps a height to 10,000 pixels', async () => {
    const { page, context, console: lines } = await open(browser, [
      { id: 'f', doc: 'flood' },
      { id: 'r', doc: 'resizer', block: { sizing: 'content' } },
    ]);
    try {
      await until(page, "document.querySelector('[data-fc-scope]').getAttribute('data-fcs-count') === '41'", 10_000);
      await until(page, "document.querySelector('#r iframe') && document.querySelector('#r iframe').style.height === '10000px'", 5_000);
      expect(await stateOf(page, 'count')).toBe('41');
      expect(lines.filter((line) => line.endsWith('"Block f": dropped a message over 30 a second'))).toHaveLength(10);
      expect((await frameOf(page, 'r'))?.height).toBe('10000px');
      expect(lines.filter((line) => line.endsWith('"Block r": dropped a message'))).toHaveLength(5);
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
      expect(await frameOf(page, 'quiet')).toBeNull();
      expect(await settled(page)).toContainEqual({ id: 'quiet', shown: false });
      expect(await settled(page)).not.toContainEqual({ id: 'quiet', shown: true });
      // Three pings unanswered, removed at the fourth tick: about 20 seconds after hello.
      await until(page, removed('mute'), 30_000);
      for (const id of ['mute']) {
        expect(await frameOf(page, id)).toBeNull();
        expect(await fallbackShown(page, id)).toBe(true);
        expect(lines.join('\n')).toContain(`Custom code "Block ${id}": 3 pings unanswered: removed`);
      }
      expect(lines.join('\n')).toContain('Custom code "Block quiet": no hello within 5 s: removed');
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
      const report = { engine, steps, after, removedLine: lines.some((line) => line.includes('"Block frozen": 3 pings unanswered: removed')) };
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
   * Takes the keyboard back to the page up to six times, and notes after each what holds it: the frame
   * (its script took it again), the page, or nothing because the frame is gone. A theft needs the page to
   * have held the keyboard first: an attempt where the outside input never got focus (Firefox sometimes
   * does not apply `focus()` while a frame in the page's process holds the keyboard) is noted `NOFOCUS`
   * and is not a theft the broker could see.
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
    for (let i = 0; i < 6 && !(await settled(page)).some((s) => !s.shown); i++) {
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
      if (moves.filter((move) => move !== 'NOFOCUS').length + 1 === removingTheft) await until(page, removed(id), 6_000);
      else await page.waitForTimeout(200);
      moves.push(await page.evaluate((box) => (window as unknown as { __settled: { id: string; shown: boolean }[] }).__settled.some((s) => s.id === box && !s.shown)
        ? 'removed'
        : document.activeElement?.tagName ?? '', id));
    }
    record(`focus moves in ${engine} for ${id}: ${moves.join(', ')}`);
    expect(moves.filter((move) => move === 'NOFOCUS').length).toBeLessThanOrEqual(2);
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
});

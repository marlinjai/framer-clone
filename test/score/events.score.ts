// The 100 event handler rows, and the one question they ask: does a stored action bound
// to this event run in Chromium, from a real cause, with no `dispatchEvent` anywhere? A
// stored page goes through the real published path and the real runtime, and a person's
// gesture, a real file or a real navigation causes the event. The cell passes only when
// the stored action changed state. A row with no proof, or whose cause did nothing, stays
// red and says so. See docs/plans/2026-11-02-behaviour-model.md.
//
// The page is the static output of renderPublishedPage with the runtime's chunks bundled
// in, not a Next build: `test/behaviour` proves those two meet. Here it is what each event
// reaches that counts, and a build per row would take an hour.
//
// The canvas column asks the same of the mounted editor: the real EditorApp
// (lib/canvasBundle.ts) with the same stored tree on a page, in the Interact tool, entered
// with its toolbar button, and the same cause. A row that passes published and fails there
// is `canvas-editor-context`, with what stopped it.

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page, type Route } from 'playwright';
import type { BehaviourProgram } from '@/lib/behaviour/program';
import { GATE_GLOBAL } from '@/lib/behaviour/names';
import { EVENT_PROOFS, NOT_PROVEN, n, type EventProof } from './lib/eventProofs';
import { renderThroughPublishedPage } from './lib/published';
import { bundleEditor, droppedOnEditor, enterInteract, openEditor, placeTree } from './lib/canvasBundle';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { bundleRuntime, runtimeScripts } from './lib/runtime';
import { allEntries } from './lib/universe';
import { writeOut } from './lib/io';
import { rowKey, type Cell } from './lib/types';

const ORIGIN = 'http://events.test';
const HIT = 'data-fcs-hit';
/** Long enough for `stalled`, which a browser reports after 3 seconds with no data. */
const PATIENCE_MS = 6000;
const CUES = 'WEBVTT\n\n00:00.100 --> 00:00.400\nA cue\n';
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/** One second of silence, as a real file. */
function silence(seconds = 1): Buffer {
  const samples = 8000 * seconds;
  const wav = Buffer.alloc(44 + samples);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + samples, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(8000, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(samples, 40);
  wav.fill(128, 44);
  return wav;
}

/** A real video with real frames, recorded in the browser, since no fixture is committed. */
async function recordClip(browser: Browser): Promise<Buffer> {
  const page = await browser.newPage();
  await page.setContent('<canvas width="64" height="48"></canvas>');
  const bytes = await page.evaluate(() => new Promise<number[]>((resolve, reject) => {
    const canvas = document.querySelector('canvas') as HTMLCanvasElement;
    const paint = canvas.getContext('2d') as CanvasRenderingContext2D;
    let frame = 0;
    const timer = setInterval(() => {
      frame += 1;
      paint.fillStyle = `hsl(${frame * 40} 80% 50%)`;
      paint.fillRect(0, 0, 64, 48);
    }, 40);
    const recorder = new MediaRecorder(canvas.captureStream(25), { mimeType: 'video/webm' });
    const parts: Blob[] = [];
    recorder.ondataavailable = (event) => parts.push(event.data);
    recorder.onerror = () => reject(new Error('the recorder failed'));
    recorder.onstop = () => {
      clearInterval(timer);
      new Blob(parts).arrayBuffer().then((buffer) => resolve([...new Uint8Array(buffer)]));
    };
    recorder.start();
    setTimeout(() => recorder.stop(), 800);
  }));
  await page.close();
  return Buffer.from(bytes);
}

/** The stored page of a proof: its tree under a root holding the state the action sets. */
function proofTree(event: string, proof: EventProof) {
  const on = { on: [{ id: 'proof', on: event, do: [{ set: 'hit', value: true }] }] };
  const state = [{ id: 'hit', name: 'hit', type: 'boolean', initial: false }, ...(proof.state ?? [])];
  return n('proof-root', 'div', { behaviour: { state } }, ...proof.tree(on));
}

/** What a proof's page fetches, the same for the published page and the editor. Undefined: not one of them. */
function serveFixture(route: Route, pathname: string, fixtures: { wav: Buffer; webm: Buffer }): Promise<void> | 'never' | undefined {
  // A file that never comes: the media element keeps waiting for it.
  if (pathname === '/never.wav') return 'never';
  if (pathname === '/clip.wav') return route.fulfill({ contentType: 'audio/wav', body: fixtures.wav });
  if (pathname === '/clip.webm') return route.fulfill({ contentType: 'video/webm', body: fixtures.webm });
  if (pathname === '/cues.vtt') return route.fulfill({ contentType: 'text/vtt', body: CUES });
  if (pathname === '/pixel.gif') return route.fulfill({ contentType: 'image/gif', body: PIXEL });
  if (pathname === '/sink') return route.fulfill({ contentType: 'text/html', body: 'Sent' });
  return undefined;
}

async function documentFor(event: string, proof: EventProof, runtime: string): Promise<string> {
  const tree = proofTree(event, proof);
  const { html, behaviour } = await renderThroughPublishedPage({ tree, definitions: {} });
  // Held until the proof has its route ready, and started before the cause, so the
  // boot script's buffer has no part in what is proven.
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body>${html}${runtimeScripts(runtime, behaviour as BehaviourProgram)}</body></html>`;
}

const hitOn = (page: Page) => page.evaluate((attribute) => document.querySelector('[data-t="proof-root"]')?.getAttribute(attribute), HIT);

describe('every event row, from a real cause', () => {
  let browser: Browser;
  let runtime: string;
  let wav: Buffer;
  let webm: Buffer;
  let editorBundle: string;

  beforeAll(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
    runtime = await bundleRuntime();
    editorBundle = await bundleEditor();
    wav = silence();
    webm = await recordClip(browser).catch(() => Buffer.alloc(0));
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  const prove = async (event: string, proof: EventProof): Promise<Cell> => {
    const context = await browser.newContext({ viewport: { width: 900, height: 600 }, permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage();
    page.setDefaultTimeout(4000);
    const synthetic: string[] = [];
    await page.exposeFunction('__synthetic', (type: string) => synthetic.push(type));
    await page.addInitScript(() => {
      const { dispatchEvent } = EventTarget.prototype;
      EventTarget.prototype.dispatchEvent = function watched(this: EventTarget, event: Event) {
        (window as unknown as { __synthetic(type: string): void }).__synthetic(event.type);
        return dispatchEvent.call(this, event);
      };
    });
    const html = await documentFor(event, proof, runtime);
    await page.route(`${ORIGIN}/**`, (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
      const served = serveFixture(route, pathname, { wav, webm });
      if (served === 'never') return undefined;
      return served ?? route.fulfill({ status: 404, body: '' });
    });
    try {
      await page.goto(`${ORIGIN}/`);
      await page.waitForFunction((name) => (window as unknown as Record<string, unknown>)[name] !== undefined, GATE_GLOBAL);
      const before = await hitOn(page);
      if (before !== 'false' && before !== 'true') return { status: 'fail', gap: 'blocked-event-handlers', note: 'the state did not reach the page' };
      // Already true means loading the page was the real cause, as for `loadstart`.
      if (before === 'false') await proof.cause({ page });
      await page.waitForFunction(([attribute]) => document.querySelector('[data-t="proof-root"]')?.getAttribute(attribute) === 'true', [HIT], { timeout: PATIENCE_MS });
      if (synthetic.length > 0) return { status: 'fail', gap: 'blocked-event-handlers', note: `dispatched by script: ${synthetic[0]}` };
      return { status: 'pass' };
    } catch (error) {
      return { status: 'fail', gap: 'blocked-event-handlers', note: `no real cause fired it here: ${String((error as Error).message).split('\n')[0].slice(0, 80)}` };
    } finally {
      await context.close();
    }
  };

  /**
   * The same proof on the mounted editor, in the Interact tool. A `dispatchEvent` aimed at
   * anything inside a frame fails it; the editor's own panels may dispatch what they like.
   */
  const proveOnCanvas = async (event: string, proof: EventProof): Promise<Cell> => {
    const synthetic: string[] = [];
    const { page, crashes } = await openEditor(browser, editorBundle, { permissions: ['clipboard-read', 'clipboard-write'] }, async (opened) => {
      await opened.exposeFunction('__synthetic', (type: string) => synthetic.push(type));
      await opened.addInitScript(() => {
        const { dispatchEvent } = EventTarget.prototype;
        EventTarget.prototype.dispatchEvent = function watched(this: EventTarget, event: Event) {
          if (this instanceof Element && this.closest('[data-viewport-content-id]')) {
            (window as unknown as { __synthetic(type: string): void }).__synthetic(event.type);
          }
          return dispatchEvent.call(this, event);
        };
      });
      await opened.route('**/*', (route) => {
        const served = serveFixture(route, new URL(route.request().url()).pathname, { wav, webm });
        if (served === 'never') return undefined;
        return served ?? route.fallback();
      });
    });
    const hit = () => page.evaluate((attribute) => document.querySelector('[data-viewport-content-id] [data-t="proof-root"]')?.getAttribute(attribute), HIT);
    const tree = proofTree(event, proof) as unknown as ComponentNode;
    // What the canvas does on purpose, named beside the timeout it causes.
    const why = droppedOnEditor(tree);
    const reason = why.length > 0 ? `: the editor surfaces drop ${why.join(', ')}` : '';
    try {
      await placeTree(page, crashes, tree);
      await enterInteract(page);
      page.setDefaultTimeout(4000);
      const before = await hit();
      if (before !== 'false' && before !== 'true') return { status: 'fail', gap: 'canvas-editor-context', note: 'the state did not reach the canvas' };
      // Already true means loading was the cause, as published; the canvas draws it in Select at first values.
      if (before === 'false') await proof.cause({ page });
      await page.waitForFunction(([attribute]) => document.querySelector('[data-viewport-content-id] [data-t="proof-root"]')?.getAttribute(attribute) === 'true', [HIT], { timeout: PATIENCE_MS });
      if (synthetic.length > 0) return { status: 'fail', gap: 'canvas-editor-context', note: `dispatched by script: ${synthetic[0]}` };
      if (crashes.length > 0) return { status: 'fail', gap: 'canvas-editor-context', note: `the editor crashed: ${crashes[0].slice(0, 80)}` };
      return { status: 'pass' };
    } catch (error) {
      return { status: 'fail', gap: 'canvas-editor-context', note: `in Interact, ${String((error as Error).message).split('\n')[0].slice(0, 80)}${reason}` };
    } finally {
      await page.context().close();
    }
  };

  it('passes nothing without its cause, which is what makes the rest mean something', async () => {
    const proof = EVENT_PROOFS.click;
    expect((await prove('click', { ...proof, cause: async () => {} })).status).toBe('fail');
    expect((await prove('click', proof)).status).toBe('pass');
    expect((await proveOnCanvas('click', { ...proof, cause: async () => {} })).status).toBe('fail');
    expect((await proveOnCanvas('click', proof)).status).toBe('pass');
  }, 90_000);

  it('proves what it can and names the rest', async () => {
    const rows = allEntries().filter((entry) => entry.kind === 'html-event-handler' && !entry.excluded);
    const cells: Record<string, Cell> = {};
    const canvas: Record<string, Cell> = {};
    for (const { id } of rows) {
      const event = id.slice(2);
      const proof = EVENT_PROOFS[event];
      const key = rowKey('html-event-handler', id);
      if (proof) cells[key] = await prove(event, proof);
      else cells[key] = { status: 'fail', gap: 'blocked-event-handlers', note: NOT_PROVEN[event] ?? 'no proof yet' };
      // The canvas is asked what the published page answers: a row red there stays red here, for the same reason.
      canvas[key] = proof && cells[key].status === 'pass' ? await proveOnCanvas(event, proof) : cells[key];
    }
    writeOut('events', cells);
    writeOut('events-canvas', canvas);
    fs.writeFileSync(path.join(process.env.TMPDIR ?? '/tmp', 'event-proofs.json'), JSON.stringify({ published: cells, canvas }, null, 1));
    expect(Object.keys(cells).length).toBe(rows.length);
    expect(Object.keys(canvas).length).toBe(rows.length);
  }, 1_200_000);
});

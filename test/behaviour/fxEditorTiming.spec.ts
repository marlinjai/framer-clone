// How responsive the editor stays while an FX scene is tuned, measured on a real build in Chromium (the
// engine with long-task timing): Live on in one frame, a burst of edits as a slider sends them, and the
// main thread's long tasks meanwhile and in the seconds after (when the other frames' still frames are
// drawn again, on a branch that has them). Plan docs/plans/2026-11-08-lumitra-fx-in-sites.md, addendum
// of 2026-11-23. Numbers go to a file for the comparison with main; the assertion is only that the scene
// stays live.

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { fxFromPreset, setFxParam, setFxStart, type FxEdit } from '@/lib/fxScene/edit';
import { bundleEditor, openEditor, placeTree } from '../score/lib/canvasBundle';

const OUT = process.env.FX_TIMING_OUT ?? path.join(__dirname, '.out', 'fx-timing.jsonl');
const stored = (edit: FxEdit) => {
  if (!edit.ok) throw new Error(edit.message);
  return edit.stored;
};
const preset = fxFromPreset();
if (!preset.ok) throw new Error(preset.message);
const SCENE = stored(setFxStart(preset.stored, 'immediate'));
const box = (id: string) =>
  ({ id, type: 'div', props: { 'data-fx': 'scene', fx: SCENE, style: { width: '100%', height: '320px', background: '#04090B' } }, children: [{ id: `${id}-t`, type: 'h2', props: { children: 'Tuned' } }] }) as unknown as ComponentNode;

let browser: Browser;
let bundle: string;
beforeAll(async () => {
  bundle = await bundleEditor();
  browser = await chromium.launch();
}, 180_000);
afterAll(async () => browser?.close());

it('tuning a live scene: long tasks during a burst of edits and while the other frames catch up', async () => {
  const { page, crashes } = await openEditor(browser, bundle, { viewport: { width: 4200, height: 1000 } }, async (fresh) => {
    await fresh.addInitScript(() => {
      const tasks: { start: number; duration: number }[] = [];
      (window as unknown as { __tasks: typeof tasks }).__tasks = tasks;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) tasks.push({ start: entry.startTime, duration: entry.duration });
      }).observe({ type: 'longtask', buffered: true });
    });
  });
  page.setDefaultTimeout(30_000);
  await placeTree(page, crashes, { id: 'page', type: 'div', props: {}, children: [box('fxa')] } as unknown as ComponentNode, { allFrames: true });
  const api = <T,>(source: string, arg?: unknown) => page.evaluate(([s, a]) => new Function('api', 'arg', `return (${s})(api, arg)`)((window as unknown as { __editor: unknown }).__editor, a), [source, arg] as const) as Promise<T>;
  await api('(api) => api.startFxLive("fxa", 0)');
  await expect.poll(() => api<string>('(api) => api.fxLiveStatus()'), { timeout: 30_000 }).toBe('live');
  // Whatever the start cost is over: measure from here.
  await page.waitForTimeout(8000);
  const from = await page.evaluate(() => performance.now());
  const burst: unknown[] = [];
  let scene: unknown = SCENE;
  for (let i = 0; i < 20; i++) burst.push((scene = stored(setFxParam(scene, 'bloom', 'intensity', 0.3 + (i % 10) / 10))));
  await api(
    `async (api, arg) => { for (const next of arg) { api.setFx("fxa", next); await new Promise((r) => setTimeout(r, 50)); } }`,
    burst,
  );
  const burstEnd = await page.evaluate(() => performance.now());
  await page.waitForTimeout(8000);
  const result = await page.evaluate(([start, end]) => {
    const tasks = (window as unknown as { __tasks: { start: number; duration: number }[] }).__tasks.filter((t) => t.start >= start);
    const during = tasks.filter((t) => t.start < end);
    const after = tasks.filter((t) => t.start >= end);
    const sum = (list: typeof tasks) => Math.round(list.reduce((s, t) => s + Math.max(0, t.duration - 50), 0));
    return {
      burstMs: Math.round(end - start),
      during: { count: during.length, longest: Math.round(Math.max(0, ...during.map((t) => t.duration))), blocking: sum(during) },
      after: { count: after.length, longest: Math.round(Math.max(0, ...after.map((t) => t.duration))), blocking: sum(after) },
      stills: document.querySelectorAll('[data-fc-fx-still]').length,
    };
  }, [from, burstEnd] as const);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.appendFileSync(OUT, `${JSON.stringify({ editor: result })}\n`);
  expect(await api<string>('(api) => api.fxLiveStatus()')).toBe('live');
  expect(crashes).toEqual([]);
}, 180_000);
// ci-replay touch

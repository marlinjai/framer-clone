// pnpm test:render-gate: whether anything stored can act on a page, in Chromium and
// WebKit, through both renderers. RENDER_GATE_FULL=1 crosses every row with every
// value. While working on it, RENDER_GATE_ONLY=published narrows the surfaces and
// RENDER_GATE_MATCH=<regexp> the probes, by what they are called.

import fs from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, webkit, type BrowserType } from 'playwright';
import { bundleEditor } from '../score/lib/canvasBundle';
import { buildProbes, type Probe } from './probes';
import { readBundle, runBatch, type Finding, type Surface } from './harness';

const FULL = process.env.RENDER_GATE_FULL === '1';
const BATCH_SIZE = 200;
const WORKERS = Number(process.env.RENDER_GATE_WORKERS ?? 4);
const SURFACES: Surface[] = (process.env.RENDER_GATE_ONLY?.split(',') as Surface[] | undefined) ?? ['published', 'island', 'canvas'];
const ONLY_PROBES = process.env.RENDER_GATE_MATCH ? new RegExp(process.env.RENDER_GATE_MATCH) : undefined;
const REPORT = 'test/renderGate/.out/findings.json';

const BROWSERS: [string, BrowserType][] = [['chromium', chromium], ['webkit', webkit]];

function batches(probes: readonly Probe[]): Probe[][] {
  const out: Probe[][] = [];
  for (let i = 0; i < probes.length; i += BATCH_SIZE) out.push(probes.slice(i, i + BATCH_SIZE));
  return out;
}

const summary = (findings: readonly Finding[]) =>
  [...new Map(findings.map((f) => [`${f.browser}/${f.surface}/${f.detector}/${f.what}`, f])).values()]
    .map((f) => `${f.browser} ${f.surface} ${f.detector}: ${f.what} (${f.detail})`);

describe('render gate', () => {
  let bundle = '';

  beforeAll(async () => {
    bundle = readBundle(await bundleEditor('test/renderGate/browserEntry.tsx', 'render-gate-bundle'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it.each(BROWSERS)('nothing stored acts on a page in %s', async (name, type) => {
    let browser = await type.launch();
    // A browser that dies under a long run costs that batch one retry. A second
    // death is reported: unlike a clean run, it says nothing about the probes.
    const withRestart = async (list: Probe[], surface: Surface, tag: string): Promise<Finding[]> => {
      try {
        return await runBatch(browser, name, surface, list, tag, bundle);
      } catch {
        if (!browser.isConnected()) browser = await type.launch();
        return runBatch(browser, name, surface, list, tag, bundle).catch((error) => [
          { browser: name, surface, probe: tag, what: 'a batch', detector: 'blind' as const, detail: String(error).slice(0, 160) },
        ]);
      }
    };
    const probes = buildProbes(FULL).filter((probe) => !ONLY_PROBES || ONLY_PROBES.test(probe.what));
    const findings: Finding[] = [];
    try {
      for (const surface of SURFACES) {
        const queue = batches(probes).map((list, index) => ({ list, tag: `b${index}` }));
        const worker = async () => {
          for (let job = queue.shift(); job; job = queue.shift()) {
            findings.push(...(await withRestart(job.list, surface, job.tag)));
          }
        };
        await Promise.all(Array.from({ length: WORKERS }, worker));
      }
    } finally {
      await browser.close();
    }
    fs.mkdirSync('test/renderGate/.out', { recursive: true });
    fs.writeFileSync(REPORT.replace('findings', `findings-${name}`), JSON.stringify(findings, null, 1));
    process.stdout.write(`${name}: ${probes.length} probes on ${SURFACES.join(', ')}, ${findings.length} findings\n`);
    expect(summary(findings)).toEqual([]);
  });
});

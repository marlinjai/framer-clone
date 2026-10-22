// scripts/bench-template-preview.ts
//
// Measures the server time of the template preview (visual template composer
// plan, decision 12: p95 under 150 ms for one page, under 400 ms for five) on
// the production runtime: the preview route's work from the render model to
// the base64 answer (render model, the preview's "?" for undrawable text, the
// layout engine with the stamp, base64 encoding), without the network and the
// session check. Fictional probe data only.
//
// RUN IT on the production image's Node and platform:
//
//   pnpm bench:preview
//
// which bundles this file with esbuild (as build:boot bundles the migration
// runner) and runs it in the pinned node:22 bookworm-slim image of the
// Dockerfile, NODE_ENV=production, with the fonts mounted where the app reads
// them. `node dist-bench/bench-template-preview.cjs` runs the same bundle on
// the host. Prints one JSON line per case.

import { renderTemplate } from '../src/server/books/render/engine';
import { previewSafe, previewSafeTemplate } from '../src/server/books/render/drawable';
import { fontFiles } from '../src/server/books/render/fonts';
import { buildRenderModel } from '../src/server/books/render/model';
import { preset } from '../src/server/books/template/presets';
import { probe, probeInput, type Probe } from '../src/server/books/template/probes';
import type { TemplateDocumentV2 } from '../src/server/books/template/schema';

const WARMUP = 10;
const RUNS = Number(process.env.BENCH_RUNS ?? 100);

/** The long-invoice probe grown to exactly `pages` pages in a preset. */
async function probeWithPages(doc: TemplateDocumentV2, pages: number): Promise<Probe> {
  const base = probe('longInvoice');
  for (let n = 10; n <= 400; n += 2) {
    const p: Probe = {
      ...base,
      lines: Array.from({ length: n }, (_, i) => ({ ...base.lines[i % base.lines.length], id: `l${i}`, position: i + 1 })),
    };
    const { layout } = await renderTemplate(buildRenderModel(probeInput(p)), doc, fontFiles());
    if (layout.pageCount === pages) return p;
  }
  throw new Error(`no line count gives ${pages} pages`);
}

async function preview(p: Probe, doc: TemplateDocumentV2): Promise<{ ms: number; pages: number; bytes: number }> {
  const started = performance.now();
  const { bytes, layout } = await renderTemplate(previewSafe(buildRenderModel(probeInput(p))), previewSafeTemplate(doc), fontFiles(), {
    preview: true,
  });
  const body = JSON.stringify({ pdf: Buffer.from(bytes).toString('base64'), layout });
  return { ms: performance.now() - started, pages: layout.pageCount, bytes: body.length };
}

const pct = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];

async function main(): Promise<void> {
  const cold = performance.now();
  await preview(probe('regular'), preset('klassisch'));
  const coldMs = performance.now() - cold;
  const cases: Array<{ name: string; probe: Probe; doc: TemplateDocumentV2 }> = [];
  for (const name of ['klassisch', 'modern', 'kompakt'] as const) {
    const doc = preset(name);
    cases.push({ name: `${name} 1 page`, probe: probe('regular'), doc });
    cases.push({ name: `${name} 5 pages`, probe: await probeWithPages(doc, 5), doc });
  }
  console.log(JSON.stringify({ node: process.version, platform: `${process.platform}/${process.arch}`, env: process.env.NODE_ENV ?? null, coldFirstRenderMs: Math.round(coldMs) }));
  for (const c of cases) {
    for (let i = 0; i < WARMUP; i += 1) await preview(c.probe, c.doc);
    const times: number[] = [];
    let pages = 0;
    let bytes = 0;
    for (let i = 0; i < RUNS; i += 1) {
      const r = await preview(c.probe, c.doc);
      times.push(r.ms);
      pages = r.pages;
      bytes = r.bytes;
    }
    times.sort((a, b) => a - b);
    const round = (v: number) => Math.round(v * 10) / 10;
    console.log(
      JSON.stringify({ case: c.name, pages, runs: RUNS, p50: round(pct(times, 0.5)), p95: round(pct(times, 0.95)), max: round(times[times.length - 1]), answerKb: Math.round(bytes / 1024) }),
    );
  }
}

void main();

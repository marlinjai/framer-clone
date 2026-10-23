'use client';

// src/app/dev/books-engine/page.harness.tsx
//
// The browser parity harness (WYSIWYG invoice editor plan, phase 1, parity
// layer (b)): renders every case of /dev/books-engine/cases through the real
// client API (`renderDraftInBrowser`, the worker chunk the bundler built),
// hashes the bytes with Web Crypto and compares them with the server's
// SHA-256; then times the one-page and three-page drafts of each family (50
// runs after 5 warm-up runs, p50 and p95, wall clock in the page and the
// worker's own time). The result is written as JSON into #result and
// `window.__booksEngineHarness`. Run it with `pnpm harness:books-engine` and
// open http://localhost:3917/dev/books-engine with any `lumitra_session`
// cookie (the edge middleware checks only that one is there). Exists only in a build with
// BOOKS_ENGINE_HARNESS=1 (next.config.ts); never shipped.

import { useEffect, useState } from 'react';

import { parseRenderInputPayload, renderDraftInBrowser } from '@/lib/books/engine';

interface Case {
  name: string;
  latency: '1p' | '3p' | null;
  payload: unknown;
  sha256: string;
  pageCount: number;
}

async function hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
const round = (v: number) => Math.round(v * 10) / 10;

async function run() {
  const cases = (await (await fetch('/dev/books-engine/cases')).json()) as Case[];
  const mismatches: Array<{ name: string; expected: string; actual: string }> = [];
  const errors: Array<{ name: string; error: string }> = [];
  for (const c of cases) {
    try {
      const r = await renderDraftInBrowser(parseRenderInputPayload(c.payload));
      const actual = await hex(r.bytes);
      if (actual !== c.sha256 || r.layout.pageCount !== c.pageCount) mismatches.push({ name: c.name, expected: c.sha256, actual });
    } catch (e) {
      errors.push({ name: c.name, error: e instanceof Error ? `${(e as { code?: string }).code ?? ''} ${e.message}` : String(e) });
    }
  }
  const latency: Record<string, unknown> = {};
  for (const c of cases.filter((x) => x.latency)) {
    const payload = parseRenderInputPayload(c.payload);
    for (let i = 0; i < 5; i += 1) await renderDraftInBrowser(payload);
    const wall: number[] = [];
    const worker: number[] = [];
    for (let i = 0; i < 50; i += 1) {
      const t = performance.now();
      const r = await renderDraftInBrowser(payload);
      wall.push(performance.now() - t);
      worker.push(r.renderMs);
    }
    wall.sort((a, b) => a - b);
    worker.sort((a, b) => a - b);
    latency[c.name] = {
      pages: c.pageCount,
      wallP50: round(pct(wall, 50)),
      wallP95: round(pct(wall, 95)),
      workerP50: round(pct(worker, 50)),
      workerP95: round(pct(worker, 95)),
    };
  }
  return { cases: cases.length, matched: cases.length - mismatches.length - errors.length, mismatches, errors, latency, userAgent: navigator.userAgent };
}

export default function BooksEngineHarness() {
  const [result, setResult] = useState<string>('running');
  useEffect(() => {
    run().then(
      (r) => {
        (window as unknown as { __booksEngineHarness: unknown }).__booksEngineHarness = r;
        setResult(JSON.stringify(r, null, 2));
      },
      (e: unknown) => {
        (window as unknown as { __booksEngineHarness: unknown }).__booksEngineHarness = { failed: String(e) };
        setResult(`failed: ${String(e)}`);
      },
    );
  }, []);
  return (
    <main>
      <h1>Books engine parity harness</h1>
      <pre id="result">{result}</pre>
    </main>
  );
}

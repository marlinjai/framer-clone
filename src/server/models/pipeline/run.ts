// src/server/models/pipeline/run.ts
//
// Runs one pipeline task in a worker thread with a hard time and memory cap (plan step 1 of
// "Upload, validation and re-encoding": 20 seconds and 512 megabytes). The worker is terminated
// when the time is up or when it passes its heap limit; the caller gets a refusal either way.
//
// What the memory cap covers, honestly: `resourceLimits` bound the worker's JAVASCRIPT HEAP only.
// Typed arrays (the decoded geometry, the written file, the copies of the input) and sharp's native
// image buffers are outside it: a worker given a 64 MB heap allocated gigabytes of Uint8Arrays in
// testing. What actually bounds them is the engine capping decoded bytes, texture pixels and counts
// BEFORE decoding (engine.mjs), one task per worker, and at most WORKER_LIMITS.concurrent workers
// at once. A container memory limit is the real backstop and is a deployment step that stays gated
// before any route is wired; this file does not replace it.

import { Worker } from 'node:worker_threads';
import { ModelRefusalError } from '../ports';

export const WORKER_LIMITS = { timeoutMs: 20_000, heapMb: 512, concurrent: 2 } as const;

// A process-wide queue: uploads wait for a slot instead of each starting a worker of their own.
let running = 0;
const waiting: (() => void)[] = [];
async function slot(): Promise<() => void> {
  if (running >= WORKER_LIMITS.concurrent) await new Promise<void>((resolve) => waiting.push(resolve));
  else running++;
  return () => { const next = waiting.shift(); if (next) next(); else running--; };
}

export interface RunOptions {
  /** The worker script; defaults to this directory's worker.mjs. A test points it at a misbehaving one. */
  script?: URL;
  timeoutMs?: number;
  heapMb?: number;
}

interface Message { ok: boolean; result?: unknown; error?: { code: string; message: string; status: 413 | 422 | 500 } }

export async function runInWorker<T>(task: 'validate' | 'reencode', bytes: Uint8Array, limits: unknown, options: RunOptions = {}): Promise<T> {
  const release = await slot();
  try { return await runWorker<T>(task, bytes, limits, options); } finally { release(); }
}

function runWorker<T>(task: 'validate' | 'reencode', bytes: Uint8Array, limits: unknown, options: RunOptions): Promise<T> {
  const timeoutMs = options.timeoutMs ?? WORKER_LIMITS.timeoutMs;
  const heapMb = options.heapMb ?? WORKER_LIMITS.heapMb;
  return new Promise<T>((resolve, reject) => {
    // The bytes are copied, never transferred: the caller keeps its own buffer (it still stores the original).
    const copy = new Uint8Array(bytes).buffer;
    const worker = new Worker(options.script ?? new URL('./worker.mjs', import.meta.url), {
      workerData: { task, bytes: copy, limits },
      resourceLimits: { maxOldGenerationSizeMb: heapMb, maxYoungGenerationSizeMb: Math.min(64, Math.ceil(heapMb / 8)), stackSizeMb: 4 },
    });
    let settled = false;
    const settle = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); void worker.terminate(); fn(); };
    const timer = setTimeout(() => settle(() => reject(new ModelRefusalError('timeout', `processing took longer than ${timeoutMs / 1000} seconds`, 413))), timeoutMs);
    worker.once('message', (m: Message) => settle(() => {
      if (m.ok) resolve(m.result as T);
      else reject(new ModelRefusalError(m.error?.code ?? 'worker-failed', m.error?.message ?? 'the model could not be processed', m.error?.status ?? 500));
    }));
    worker.once('error', (err: Error & { code?: string }) => settle(() => {
      if (err.code === 'ERR_WORKER_OUT_OF_MEMORY') reject(new ModelRefusalError('out-of-memory', `processing needed more than ${heapMb} MB`, 413));
      else reject(new Error('the model worker failed'));
    }));
    worker.once('exit', (code) => settle(() => reject(new Error(`the model worker exited with code ${code} without an answer`))));
  });
}

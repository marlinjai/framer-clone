// src/lib/books/engine/client.ts
//
// The page side of the browser's draft render (WYSIWYG invoice editor plan,
// phase 1): what the in-place editor calls to redraw a draft after a
// keystroke. Two calls:
//
//   fetchRenderInput(documentId)       the draft's render input from the
//                                      server (GET .../render-input), dates
//                                      revived;
//   renderDraftInBrowser(payload)      the PDF bytes and layout map, drawn in
//                                      a Web Worker by the same engine and the
//                                      same draft path as the server's draft
//                                      PDF route, byte for byte.
//
// One worker per page, started on the first render and kept (it keeps the
// fonts and logos it fetched). Renders run in order; `signal` cancels one (a
// newer keystroke): a render not yet started is skipped in the worker, one
// already running finishes there and its answer is dropped, and the promise
// rejects with `aborted` at once. A worker that dies rejects everything it was
// asked with `worker_failed`, and the next render starts a fresh one. A
// browser without Web Workers rejects with `worker_unsupported`. Every
// failure is a BrowserRenderError with a code (errors.ts), never a page drawn
// differently.

import type { LayoutMap } from '@/server/books/render/engine';

import { BrowserRenderError, deserializeRenderError } from './errors';
import { parseRenderInputPayload, type RenderInputPayload } from './payload';
import type { WorkerRequest, WorkerResponse } from './protocol';

export interface BrowserRender {
  /** The PDF, byte-identical to the server's draft PDF route for the same input. */
  bytes: Uint8Array;
  /** Every block's page and rectangle, the table columns and the layout issues. */
  layout: LayoutMap;
  /** Time the worker spent on this render (input to bytes, fetches included), in milliseconds. */
  renderMs: number;
}

export interface RenderDraftOptions {
  /** Cancels the render (rejects with `aborted`). */
  signal?: AbortSignal;
}

/** The part of a Worker the renderer uses (a test passes a fake). */
export interface WorkerLike {
  postMessage(message: WorkerRequest): void;
  terminate(): void;
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
  onmessageerror: ((e: MessageEvent) => void) | null;
}

interface Pending {
  resolve(r: BrowserRender): void;
  reject(e: BrowserRenderError): void;
  cleanup(): void;
}

function abortedError(): BrowserRenderError {
  return new BrowserRenderError('aborted', 'The render was cancelled.');
}

/** Renders drafts in one worker; `renderDraftInBrowser` uses one per page. */
export class DraftRenderer {
  private worker: WorkerLike | null = null;
  private readonly pending = new Map<number, Pending>();
  private next = 1;

  constructor(private readonly createWorker: () => WorkerLike) {}

  render(payload: RenderInputPayload, options: RenderDraftOptions = {}): Promise<BrowserRender> {
    const { signal } = options;
    if (signal?.aborted) return Promise.reject(abortedError());
    let worker: WorkerLike;
    try {
      worker = this.ensureWorker();
    } catch (err) {
      return Promise.reject(err instanceof BrowserRenderError ? err : new BrowserRenderError('worker_failed', `The render worker could not be started (${String(err)}).`));
    }
    const id = this.next++;
    return new Promise<BrowserRender>((resolve, reject) => {
      const onAbort = () => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        worker.postMessage({ type: 'cancel', id });
        reject(abortedError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, { resolve, reject, cleanup: () => signal?.removeEventListener('abort', onAbort) });
      try {
        worker.postMessage({ type: 'render', id, payload });
      } catch (err) {
        // A payload that cannot be cloned (a function, a DOM node) never reaches the worker.
        this.settle(id)?.reject(new BrowserRenderError('invalid_input', `The render input cannot be sent to the worker (${String(err)}).`));
      }
    });
  }

  /** Stop the worker; renders in flight reject with `worker_failed`. */
  dispose(): void {
    this.fail('The render worker was stopped.');
  }

  private ensureWorker(): WorkerLike {
    if (this.worker) return this.worker;
    const w = this.createWorker();
    w.onmessage = (e) => this.onMessage(e.data);
    w.onerror = (e) => {
      e.preventDefault?.();
      this.fail(`The render worker failed (${e.message || 'no message'}).`);
    };
    w.onmessageerror = () => this.fail('The render worker sent a message that could not be read.');
    this.worker = w;
    return w;
  }

  private settle(id: number): Pending | undefined {
    const p = this.pending.get(id);
    if (!p) return undefined;
    this.pending.delete(id);
    p.cleanup();
    return p;
  }

  private onMessage(msg: WorkerResponse): void {
    const p = this.settle(msg.id);
    if (!p) return; // cancelled meanwhile: the answer is dropped
    if (msg.type === 'rendered') p.resolve({ bytes: new Uint8Array(msg.bytes), layout: msg.layout, renderMs: msg.renderMs });
    else p.reject(deserializeRenderError(msg.error));
  }

  private fail(message: string): void {
    const w = this.worker;
    this.worker = null;
    w?.terminate();
    for (const id of [...this.pending.keys()]) this.settle(id)?.reject(new BrowserRenderError('worker_failed', message));
  }
}

/** Whether this browser can render drafts (Web Workers and Web Crypto). */
export function browserRenderSupported(): boolean {
  return typeof Worker !== 'undefined' && typeof crypto !== 'undefined' && typeof crypto.subtle !== 'undefined';
}

function startWorker(): WorkerLike {
  if (!browserRenderSupported()) {
    throw new BrowserRenderError('worker_unsupported', 'This browser cannot draw the invoice itself (no Web Worker or Web Crypto); the server preview still works.');
  }
  // The bundler emits the worker and its imports as their own chunk.
  return new Worker(new URL('./render.worker.ts', import.meta.url), { name: 'books-draft-render' }) as unknown as WorkerLike;
}

let shared: DraftRenderer | null = null;

/** Draw a draft in this page's render worker: the bytes the server's draft PDF route would answer, and the layout map. */
export function renderDraftInBrowser(payload: RenderInputPayload, options: RenderDraftOptions = {}): Promise<BrowserRender> {
  shared ??= new DraftRenderer(startWorker);
  return shared.render(payload, options);
}

/** Stop this page's render worker (it starts again on the next render). */
export function disposeBrowserRenderer(): void {
  shared?.dispose();
  shared = null;
}

/** The draft's render input (GET /api/books/documents/<id>/render-input), dates revived. */
export async function fetchRenderInput(documentId: string, options: RenderDraftOptions = {}): Promise<RenderInputPayload> {
  let res: Response;
  try {
    res = await fetch(`/api/books/documents/${encodeURIComponent(documentId)}/render-input`, {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: options.signal,
    });
  } catch (err) {
    if (options.signal?.aborted) throw abortedError();
    throw new BrowserRenderError('render_input_failed', `The draft could not be loaded (${err instanceof Error ? err.message : String(err)}).`);
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // An abort while the body is read is a cancel, never a malformed answer.
    if (options.signal?.aborted) throw abortedError();
  }
  if (!res.ok) {
    const error = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    throw new BrowserRenderError(
      'render_input_failed',
      typeof error?.message === 'string' ? error.message : `The draft could not be loaded (HTTP ${res.status}).`,
      { status: res.status, code: typeof error?.code === 'string' ? error.code : null },
    );
  }
  const payload = parseRenderInputPayload(body);
  if (payload.documentId !== documentId) {
    throw new BrowserRenderError('invalid_input', 'The render input belongs to another document.', { path: 'documentId' });
  }
  return payload;
}

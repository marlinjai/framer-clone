// src/lib/books/engine/render.worker.ts
//
// The Web Worker that draws drafts in the browser (WYSIWYG invoice editor
// plan, phase 1), so a page comes back within a fraction of a second of a
// keystroke without blocking typing. Message plumbing only: the drawing is
// render.ts. Requests run one at a time in the order they came; a request
// cancelled before it starts is skipped (the editor cancels the render a newer
// keystroke made obsolete). Fonts and logos are fetched from this worker's
// origin with the page's cookies (same origin) and kept for its life
// (resources.ts). The PDF bytes are transferred back, not copied.

import { serializeRenderError } from './errors';
import { renderDraftPayload } from './render';
import type { WorkerRequest, WorkerResponse } from './protocol';

const scope = self as unknown as {
  location: { origin: string };
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
};

const fetcher = (path: string) => fetch(new URL(path, scope.location.origin), { credentials: 'same-origin' });

const cancelled = new Set<number>();
let queue: Promise<void> = Promise.resolve();

async function run(id: number, payload: Extract<WorkerRequest, { type: 'render' }>['payload']): Promise<void> {
  if (cancelled.delete(id)) return;
  const started = performance.now();
  try {
    const { bytes, layout } = await renderDraftPayload(fetcher, payload);
    // A buffer of exactly the PDF, so the transfer hands over nothing else.
    const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
    const renderMs = Math.round((performance.now() - started) * 10) / 10;
    scope.postMessage({ type: 'rendered', id, bytes: buffer as ArrayBuffer, layout, renderMs }, [buffer as ArrayBuffer]);
  } catch (err) {
    scope.postMessage({ type: 'failed', id, error: serializeRenderError(err) });
  }
}

scope.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'cancel') {
    cancelled.add(msg.id);
    return;
  }
  if (msg.type === 'render') queue = queue.then(() => run(msg.id, msg.payload));
};

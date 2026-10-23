// src/lib/books/engine/protocol.ts
//
// The messages between the editor's page and the draft render worker
// (render.worker.ts). Types only.

import type { LayoutMap } from '@/server/books/render/engine';

import type { SerializedRenderError } from './errors';
import type { RenderInputPayload } from './payload';

export type WorkerRequest = { type: 'render'; id: number; payload: RenderInputPayload } | { type: 'cancel'; id: number };

export type WorkerResponse =
  | { type: 'rendered'; id: number; bytes: ArrayBuffer; layout: LayoutMap; renderMs: number }
  | { type: 'failed'; id: number; error: SerializedRenderError };

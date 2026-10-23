// src/lib/books/engine/index.ts
//
// The browser's draft render (WYSIWYG invoice editor plan, phase 1), as the
// in-place editor imports it. The page bundle gets only the client side; the
// engine itself is loaded in the worker's own chunk (client.ts).

export {
  browserRenderSupported,
  disposeBrowserRenderer,
  DraftRenderer,
  fetchRenderInput,
  renderDraftInBrowser,
  type BrowserRender,
  type RenderDraftOptions,
  type WorkerLike,
} from './client';
export { BrowserRenderError, type BrowserRenderErrorCode } from './errors';
export { parseRenderInputPayload, RENDER_INPUT_FORMAT, type LogoRef, type RenderInputPayload } from './payload';
export type { LayoutIssue, LayoutMap, LayoutRect } from '@/server/books/render/engine';

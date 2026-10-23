// src/lib/books/engine/render.ts
//
// The browser's draft render (WYSIWYG invoice editor plan, decision 2 and
// phase 1): the render input of a draft plus the fonts and logos it names
// give the same PDF bytes and layout map the server's draft PDF route gives,
// because both go through the one draft path (render/draftRender.ts: the
// render model, "?" for what the family cannot draw, the layout engine,
// "ENTWURF" on every page). The worker (render.worker.ts) runs this; the
// parity tests import it directly. Nothing here, nor anything it imports, may
// import Node (engineImportGraph.test.ts walks the graph and fails on a
// `node:` import, on the server's fonts.ts or on logoImage.ts).

import { assertRenderableTemplate, type EngineResult } from '@/server/books/render/engine';
import { renderDraft } from '@/server/books/render/draftRender';

import { BrowserRenderError } from './errors';
import type { RenderInputPayload } from './payload';
import { loadDraftResources, type Fetcher } from './resources';

/** Draw a draft from its render input, loading what it needs through `fetcher`. */
export async function renderDraftPayload(fetcher: Fetcher, payload: RenderInputPayload): Promise<EngineResult> {
  if (payload.input.draft !== true) throw new BrowserRenderError('invalid_input', 'Only a draft is drawn in the browser.', { path: 'input.draft' });
  try {
    assertRenderableTemplate(payload.template);
  } catch (err) {
    throw new BrowserRenderError('invalid_input', err instanceof Error ? err.message : String(err), { path: 'template' });
  }
  const resources = await loadDraftResources(fetcher, payload);
  try {
    return await renderDraft(payload.input, payload.template, resources);
  } catch (err) {
    throw new BrowserRenderError('render_failed', `The draft could not be drawn (${err instanceof Error ? err.message : String(err)}).`);
  }
}

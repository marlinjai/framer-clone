// src/server/books/render/draftRender.ts
//
// How a DRAFT is drawn, in one place for both of its renderers (WYSIWYG
// invoice editor plan, decision 2 and phase 1): the server's draft PDF route
// (store.ts `documentPdf`) and the browser's worker (src/lib/books/engine).
// The draft's render input becomes the render model, every character the
// template's font family cannot draw becomes "?" in the model and in the
// template's own texts, and the layout engine draws it with the current
// version of the draft's template, "ENTWURF" on every page (the model is a
// draft) and no preview stamp. Only the resources differ between the two
// callers: the font files (from disk on the server, fetched and checked
// against the same pins in the browser), the coverage built from them, and the
// company's logos the template names. Pure, no Node imports.
//
// Never a document of record: a draft is not checked for completeness, and its
// layout issues (a logo the company does not have, LOGO_ASSET_MISSING) come
// back in the layout map instead of refusing the render.

import type { TemplateDocumentV2 } from '../template/schema';
import { renderTemplate, type EngineFonts, type EngineImage, type EngineResult } from './engine';
import { buildRenderModel, type RenderInput } from './model';
import { previewSafeTemplateWith, previewSafeWith, type CanDraw } from './previewSafe';

export interface DraftResources {
  /** The two faces of the template's font family. */
  fonts: EngineFonts;
  /** The coverage of the two upright faces. */
  canDraw: CanDraw;
  /** The coverage of the two italic faces; needed only when a formatted text has an italic run. */
  canDrawItalic?: CanDraw;
  /** The company's logos the template names, by SHA-256 (a missing one draws nothing and is a layout issue). */
  assets: ReadonlyMap<string, EngineImage>;
}

/** Draw a draft: the PDF bytes (marked "ENTWURF") and the layout map. */
export async function renderDraft(input: RenderInput, template: TemplateDocumentV2, resources: DraftResources): Promise<EngineResult> {
  if (input.draft !== true) throw new Error('renderDraft: the render input is not a draft');
  return renderTemplate(
    previewSafeWith(buildRenderModel(input), resources.canDraw, resources.canDrawItalic),
    previewSafeTemplateWith(template, resources.canDraw),
    resources.fonts,
    { assets: resources.assets },
  );
}

// src/server/books/render/pdf.ts
//
// The PDF writers of the Books. Until the layout engine (render/engine) is
// wired in, every document is drawn by the frozen version 1 renderer.

export {
  A4,
  CONTENT_BOTTOM,
  FOOTER_TOP,
  LEGACY_V1_RENDERER_ID as RENDERER_ID,
  renderLegacyV1 as renderPdf,
  wrapText,
} from './legacyV1';

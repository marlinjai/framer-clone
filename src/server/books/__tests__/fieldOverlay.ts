// src/server/books/__tests__/fieldOverlay.ts
//
// A test-only picture of the field map (invoice editor plan, phase 2): the
// rendered PDF with every field's rectangle outlined (editable fields blue,
// read-only grey, empty slots orange), every line's row green and the
// add-line slot red, split into one PDF per page so each can be rasterized
// (`sips -s format png page.pdf --out page.png` converts only a PDF's first
// page). Never part of the product: the map is only ever drawn by the editor.

import { PDFDocument, rgb } from 'pdf-lib';

import type { FieldRect, LayoutMap } from '../render/engine';

const BLUE = rgb(0.1, 0.35, 0.95);
const GREY = rgb(0.55, 0.55, 0.55);
const ORANGE = rgb(0.95, 0.55, 0.05);
const GREEN = rgb(0.1, 0.65, 0.25);
const RED = rgb(0.9, 0.1, 0.1);

/** The PDF with the map's rectangles outlined, one PDF per page. */
export async function overlayPages(bytes: Uint8Array, layout: LayoutMap): Promise<Uint8Array[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages = doc.getPages();
  const outline = (r: FieldRect, color: ReturnType<typeof rgb>, thickness: number) =>
    pages[r.page - 1].drawRectangle({
      x: r.x,
      y: layout.page.height - r.y - r.height,
      width: r.width,
      height: r.height,
      borderColor: color,
      borderWidth: thickness,
      opacity: 0,
      borderOpacity: 0.9,
    });
  for (const row of layout.anchors.rows) for (const r of row.rects) outline(r, GREEN, 0.4);
  for (const a of layout.anchors.addLine) outline(a.rect, RED, 0.8);
  for (const f of layout.fields) for (const r of f.rects) outline(r, f.empty ? ORANGE : f.kind === 'readonly' ? GREY : BLUE, 0.6);
  const out: Uint8Array[] = [];
  for (let i = 0; i < pages.length; i += 1) {
    const single = await PDFDocument.create();
    const [page] = await single.copyPages(doc, [i]);
    single.addPage(page);
    out.push(await single.save());
  }
  return out;
}

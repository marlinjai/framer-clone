'use client';

// src/app/projects/books/composer/PdfCanvas.tsx
//
// The composer's canvas (visual template composer plan, decision 11): the
// preview PDF drawn page by page with pdf.js (Mozilla's PDF renderer, loaded
// only on this page) into canvases, with a transparent overlay per page built
// from the engine's layout map. What is on screen is the real PDF the engine
// produced, so screen and paper cannot differ.
//
// The overlay: hovering a block outlines it, a click selects it, dragging a
// block onto another of the same region moves it before or after that block
// (pointer only; the outline offers the same by keyboard), and the line
// table's column borders are handles that resize the column next to them
// (committed on release, so one drag is one undo step; the inspector has the
// same widths as numbers).
//
// New pages are drawn into fresh canvases and swapped in only when all of them
// are ready, so a refresh never flashes an empty page; while a newer preview is
// on its way the current pages are dimmed.

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { LayoutMapView, LayoutRectView } from '@/lib/books/api';

import { COLUMN_LABELS } from './doc';

/** CSS pixels per PDF point at 100 % (96 dpi screen, 72 points per inch). */
const PX_PER_PT = 96 / 72;
/** The order of the line table's columns, left to right (schema.ts TABLE_COLUMNS). */
const TABLE_ORDER = ['pos', 'title', 'quantity', 'unit', 'unitPrice', 'rate', 'amount'] as const;
type TableColumn = (typeof TABLE_ORDER)[number];

export interface ColumnResize {
  blockId: string;
  column: TableColumn;
  /** The new width in points. */
  widthPt: number;
}

export interface PdfCanvasProps {
  /** The PDF, base64 (the preview route's answer). */
  pdf: string | null;
  /** Identifies the answer the PDF belongs to (the preview's change counter). */
  counter: number | null;
  layout: LayoutMapView | null;
  zoom: number;
  dimmed: boolean;
  selectedId: string | null;
  /** The label of a block for its overlay button ("Select Totals"). */
  labelOf: (blockId: string) => string;
  /** Only top-level blocks can be dragged; a block in a `columns` cell is selected, not moved, here. */
  isMovable: (blockId: string) => boolean;
  onSelect: (blockId: string | null) => void;
  /** A block dropped onto another block of its region: before or after it. */
  onDrop: (blockId: string, targetId: string, after: boolean) => void;
  onColumnResize: (resize: ColumnResize) => void;
  /** All pages of the answer `counter` are on screen. */
  onDrawn: (counter: number) => void;
  /** Drawing failed (a broken PDF or pdf.js could not load). */
  onError: (message: string) => void;
}

type PdfJs = typeof import('pdfjs-dist');
let pdfjsPromise: Promise<PdfJs> | null = null;

/** pdf.js, loaded once and only in the browser, with its worker from the same bundle. */
function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= import('pdfjs-dist').then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
    return pdfjs;
  });
  return pdfjsPromise;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export default function PdfCanvas(props: PdfCanvasProps) {
  const { pdf, counter, layout, zoom, dimmed, selectedId, labelOf, isMovable, onSelect, onDrop, onColumnResize, onDrawn, onError } = props;
  const [pages, setPages] = useState<HTMLCanvasElement[]>([]);
  const [drawnLayout, setDrawnLayout] = useState<LayoutMapView | null>(null);
  const scale = zoom * PX_PER_PT;
  const callbacks = useRef({ onDrawn, onError });
  callbacks.current = { onDrawn, onError };

  // Draw a new answer (or the same one at a new zoom) into fresh canvases, then swap.
  useEffect(() => {
    if (!pdf || counter === null || !layout) return;
    let cancelled = false;
    const ratio = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
    (async () => {
      const pdfjs = await loadPdfJs();
      const doc = await pdfjs.getDocument({ data: base64ToBytes(pdf), isEvalSupported: false }).promise;
      try {
        const fresh: HTMLCanvasElement[] = [];
        for (let n = 1; n <= doc.numPages; n++) {
          const page = await doc.getPage(n);
          const viewport = page.getViewport({ scale: scale * ratio });
          const canvas = window.document.createElement('canvas');
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.style.width = `${Math.floor(viewport.width / ratio)}px`;
          canvas.style.height = `${Math.floor(viewport.height / ratio)}px`;
          canvas.setAttribute('aria-hidden', 'true');
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('This browser cannot draw the preview (no canvas).');
          await page.render({ canvasContext: ctx, viewport }).promise;
          if (cancelled) return;
          fresh.push(canvas);
        }
        if (cancelled) return;
        setPages(fresh);
        setDrawnLayout(layout);
        callbacks.current.onDrawn(counter);
      } finally {
        void doc.destroy();
      }
    })().catch((err: unknown) => {
      if (!cancelled) callbacks.current.onError(err instanceof Error ? err.message : 'The preview could not be drawn.');
    });
    return () => {
      cancelled = true;
    };
  }, [pdf, counter, layout, scale]);

  const shown = drawnLayout;
  if (!shown || pages.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-muted-foreground" role="status">
        {pdf ? 'Drawing the preview…' : 'Loading the preview…'}
      </div>
    );
  }

  return (
    <div className={`flex flex-col items-center gap-6 transition-opacity ${dimmed ? 'opacity-60' : 'opacity-100'}`}>
      {pages.map((canvas, i) => (
        <PageView
          key={i}
          canvas={canvas}
          page={i + 1}
          pageCount={pages.length}
          layout={shown}
          scale={scale}
          selectedId={selectedId}
          labelOf={labelOf}
          isMovable={isMovable}
          onSelect={onSelect}
          onDrop={onDrop}
          onColumnResize={onColumnResize}
        />
      ))}
    </div>
  );
}

interface PageViewProps {
  canvas: HTMLCanvasElement;
  page: number;
  pageCount: number;
  layout: LayoutMapView;
  scale: number;
  selectedId: string | null;
  labelOf: (blockId: string) => string;
  isMovable: (blockId: string) => boolean;
  onSelect: (blockId: string | null) => void;
  onDrop: (blockId: string, targetId: string, after: boolean) => void;
  onColumnResize: (resize: ColumnResize) => void;
}

interface DragState {
  blockId: string;
  region: string;
  startX: number;
  startY: number;
  active: boolean;
  /** The block under the pointer and which half of it. */
  target: { id: string; after: boolean } | null;
}

function PageView({ canvas, page, pageCount, layout, scale, selectedId, labelOf, isMovable, onSelect, onDrop, onColumnResize }: PageViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [resize, setResize] = useState<{ blockId: string; column: TableColumn; x: number; fromX: number; pointerStart: number; widthPt: number } | null>(null);

  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    el.replaceChildren(canvas);
  }, [canvas]);

  const rects = layout.blocks.filter((r) => r.page === page);
  const width = layout.page.width * scale;
  const height = layout.page.height * scale;

  /** The block of the dragged block's region under a point, and which half. */
  function targetAt(clientX: number, clientY: number, region: string, self: string, box: DOMRect): DragState['target'] {
    const x = (clientX - box.left) / scale;
    const y = (clientY - box.top) / scale;
    const hit = rects.find((r) => r.region === region && r.blockId !== self && isMovable(r.blockId) && x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height);
    return hit ? { id: hit.blockId, after: y > hit.y + hit.height / 2 } : null;
  }

  function onPointerDown(e: React.PointerEvent, r: LayoutRectView) {
    if (e.button !== 0) return;
    onSelect(r.blockId);
    if (!isMovable(r.blockId)) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ blockId: r.blockId, region: r.region, startX: e.clientX, startY: e.clientY, active: false, target: null });
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!drag) return;
    const moved = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 5;
    const box = (e.currentTarget as HTMLElement).closest('[data-page-overlay]')!.getBoundingClientRect();
    setDrag({ ...drag, active: drag.active || moved, target: drag.active || moved ? targetAt(e.clientX, e.clientY, drag.region, drag.blockId, box) : null });
  }

  function onPointerUp() {
    if (drag?.active && drag.target) onDrop(drag.blockId, drag.target.id, drag.target.after);
    setDrag(null);
  }

  // The line table's column borders on this page.
  const handles: Array<{ blockId: string; column: TableColumn; x: number; left: number; top: number; bottom: number; widthPt: number; resizesLeft: boolean }> = [];
  for (const table of layout.tables) {
    const rect = rects.find((r) => r.blockId === table.blockId);
    if (!rect) continue;
    const cols = TABLE_ORDER.filter((c) => table.columns[c]).map((c) => ({ c, ...table.columns[c]! }));
    for (let i = 0; i < cols.length - 1; i++) {
      const left = cols[i];
      const right = cols[i + 1];
      // The title column takes what is left, so the border resizes the column that is not the title.
      const resizesLeft = left.c !== 'title';
      const col = resizesLeft ? left : right;
      handles.push({
        blockId: table.blockId,
        column: col.c,
        x: right.x,
        left: left.x,
        top: rect.y,
        bottom: rect.y + rect.height,
        widthPt: col.width,
        resizesLeft,
      });
    }
  }

  function startResize(e: React.PointerEvent, h: (typeof handles)[number]) {
    e.stopPropagation();
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setResize({ blockId: h.blockId, column: h.column, x: h.x, fromX: h.x, pointerStart: e.clientX, widthPt: h.widthPt });
  }

  function moveResize(e: React.PointerEvent, h: (typeof handles)[number]) {
    if (!resize || resize.blockId !== h.blockId || resize.column !== h.column) return;
    const dx = (e.clientX - resize.pointerStart) / scale;
    setResize({ ...resize, x: resize.fromX + dx });
  }

  function endResize(h: (typeof handles)[number]) {
    if (!resize || resize.blockId !== h.blockId || resize.column !== h.column) return;
    const dx = resize.x - resize.fromX;
    const widthPt = h.resizesLeft ? resize.widthPt + dx : resize.widthPt - dx;
    setResize(null);
    if (Math.abs(dx) >= 1) onColumnResize({ blockId: h.blockId, column: h.column, widthPt: Math.max(1, widthPt) });
  }

  return (
    <div className="relative shadow-md ring-1 ring-black/10" style={{ width, height }}>
      <div ref={host} className="absolute inset-0" />
      <div
        data-page-overlay
        role="group"
        aria-label={`Page ${page} of ${pageCount}`}
        className="absolute inset-0"
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) onSelect(null);
        }}
      >
        {rects.map((r) => {
          const selected = r.blockId === selectedId;
          const isTarget = drag?.active && drag.target?.id === r.blockId;
          return (
            <button
              key={`${r.blockId}-${r.y}`}
              type="button"
              tabIndex={-1}
              aria-label={`Select ${labelOf(r.blockId)}`}
              aria-pressed={selected}
              data-block-id={r.blockId}
              className={`absolute cursor-pointer rounded-[2px] outline-none ${
                selected ? 'ring-2 ring-blue-600' : 'hover:ring-1 hover:ring-blue-400'
              } ${drag?.active && drag.blockId === r.blockId ? 'bg-blue-500/10' : ''}`}
              style={{ left: r.x * scale, top: r.y * scale, width: Math.max(r.width * scale, 4), height: Math.max(r.height * scale, 4) }}
              onPointerDown={(e) => onPointerDown(e, r)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={() => setDrag(null)}
            >
              {isTarget ? (
                <span
                  aria-hidden
                  className="pointer-events-none absolute left-0 right-0 h-0.5 bg-blue-600"
                  style={drag!.target!.after ? { bottom: -2 } : { top: -2 }}
                />
              ) : null}
            </button>
          );
        })}
        {handles.map((h) => {
          const live = resize && resize.blockId === h.blockId && resize.column === h.column;
          const x = live ? resize.x : h.x;
          return (
            <div
              key={`${h.blockId}-${h.column}-${h.x}`}
              role="separator"
              aria-orientation="vertical"
              aria-label={`Width of the ${COLUMN_LABELS[h.column].toLowerCase()} column`}
              title="Drag to change the column width"
              className={`absolute z-10 w-2 -translate-x-1 cursor-col-resize ${live ? 'bg-blue-600/60' : 'hover:bg-blue-500/40'}`}
              style={{ left: x * scale, top: h.top * scale, height: (h.bottom - h.top) * scale }}
              onPointerDown={(e) => startResize(e, h)}
              onPointerMove={(e) => moveResize(e, h)}
              onPointerUp={() => endResize(h)}
              onPointerCancel={() => setResize(null)}
            />
          );
        })}
      </div>
    </div>
  );
}

'use client';

// src/app/projects/books/invoice/StoredPdf.tsx
//
// An issued (or imported) document shown as its stored PDF, read-only
// (WYSIWYG invoice editor plan, test strategy: re-entry). It is the document
// of record, exactly the bytes the download serves, never drawn again in the
// browser: the engine renders drafts only (phase 1 decision 1). Correcting or
// cancelling stays with the editor's buttons below.

import React, { useEffect, useState } from 'react';

import { Lock, Minus, Plus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { pdfUrl } from '@/lib/books/api';

import PdfCanvas from '../composer/PdfCanvas';
import { FloatingToolbar, ToolButton, ToolbarDivider } from './chrome';

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2];

export default function StoredPdf({ id, version, imported }: { id: string; version: number; imported: boolean }) {
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  // Goes up with every PDF read, so the canvas draws new bytes (a new version) instead of keeping the open document.
  const [loads, setLoads] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    const ctrl = new AbortController();
    setError(null);
    fetch(pdfUrl(id), { signal: ctrl.signal, cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        setBytes(new Uint8Array(await res.arrayBuffer()));
        setLoads((n) => n + 1);
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setError('The PDF could not be loaded. Try again, or use the download.');
      });
    return () => ctrl.abort();
  }, [id, version, attempt]);

  return (
    <section aria-label={imported ? 'The original PDF' : 'The issued PDF'} className="relative flex-1">
      {error ? (
        <div role="alert" className="glass mx-auto mt-5 flex w-fit max-w-[calc(100%-2rem)] items-center gap-3 rounded-xl px-4 py-2.5 text-sm text-destructive">
          {error}
          <Button size="sm" variant="outline" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </Button>
        </div>
      ) : null}
      <FloatingToolbar label="Viewing tools">
        <ToolButton label="Zoom out" disabled={zoom <= ZOOMS[0]} disabledReason="Smallest size" onClick={() => setZoom(ZOOMS[Math.max(0, ZOOMS.indexOf(zoom) - 1)])}>
          <Minus size={18} aria-hidden />
        </ToolButton>
        <span className="min-w-[3.5rem] text-center text-xs font-medium tabular-nums text-foreground/70">{Math.round(zoom * 100)}%</span>
        <ToolButton label="Zoom in" disabled={zoom >= ZOOMS[ZOOMS.length - 1]} disabledReason="Largest size" onClick={() => setZoom(ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(zoom) + 1)])}>
          <Plus size={18} aria-hidden />
        </ToolButton>
        <ToolbarDivider />
        <span className="flex items-center gap-1.5 px-2 text-xs text-muted-foreground">
          <Lock size={13} aria-hidden />
          {imported ? 'The original, the document of record' : 'As issued, it cannot be changed'}
        </span>
      </FloatingToolbar>
      <div className="overflow-x-auto px-6 pb-12 pt-8">
        <PdfCanvas
          pdf={bytes}
          counter={bytes ? loads : null}
          layout={null}
          zoom={zoom}
          dimmed={false}
          selectedId={null}
          labelOf={() => ''}
          isMovable={() => false}
          onSelect={() => {}}
          onDrop={() => {}}
          onColumnResize={() => {}}
          onDrawn={() => {}}
          onError={setError}
          overlay={() => null}
        />
      </div>
    </section>
  );
}

'use client';

// src/app/projects/books/invoice/StoredPdf.tsx
//
// An issued (or imported) document shown as its stored PDF, read-only
// (WYSIWYG invoice editor plan, test strategy: re-entry). It is the document
// of record, exactly the bytes the download serves, never drawn again in the
// browser: the engine renders drafts only (phase 1 decision 1). Correcting or
// cancelling stays with the editor's buttons below.

import React, { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { pdfUrl } from '@/lib/books/api';

import PdfCanvas from '../composer/PdfCanvas';

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
    <section aria-label={imported ? 'The original PDF' : 'The issued PDF'} className="mb-6">
      <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2">
          <span>Zoom</span>
          <select className="rounded-md border border-gray-500 px-2 py-1" value={String(zoom)} onChange={(e) => setZoom(Number(e.target.value))}>
            {[0.75, 1, 1.25, 1.5].map((z) => (
              <option key={z} value={String(z)}>
                {Math.round(z * 100)} %
              </option>
            ))}
          </select>
        </label>
        <span className="text-muted-foreground">
          {imported ? 'The original PDF, the document of record.' : 'As issued: this is the stored PDF, it cannot be changed.'}
        </span>
        {error ? (
          <span role="alert" className="flex items-center gap-2 text-red-800">
            {error}
            <Button size="sm" variant="outline" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          </span>
        ) : null}
      </div>
      <div className="overflow-auto rounded-lg bg-muted/40 p-6">
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

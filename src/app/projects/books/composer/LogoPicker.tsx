'use client';

// src/app/projects/books/composer/LogoPicker.tsx
//
// The logo block's image (visual template composer plan, decision 15 and
// phase 5): upload a PNG or JPEG, or an SVG that is turned into a PNG here in
// the browser (pdf-lib embeds only PNG and JPEG), and see the stored image.
// The server checks the file again (type by its bytes, at most 1 MB and 2000
// pixels on the longer side, decodable, sRGB) and stores it once per company:
// uploading the same image again reuses it. A template prints one logo, so
// the chosen image goes to every logo block of the template.

import React, { useId, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { booksApi } from '@/lib/books/api';

import { errorText } from '../ui';
import { locate, logoBlockIds, type TemplateDocumentV2 } from './doc';
import type { Update } from './Inspector';

const MAX_BYTES = 1024 * 1024;
const MAX_SIDE = 2000;
/** An SVG without its own size is drawn this wide. */
const SVG_DEFAULT_WIDTH = 1200;

/** An SVG drawn into a PNG, the longer side at most 2000 pixels. */
async function svgToPng(file: Blob): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('The SVG could not be read.'));
      i.src = url;
    });
    const w0 = img.naturalWidth || SVG_DEFAULT_WIDTH;
    const h0 = img.naturalHeight || Math.round(SVG_DEFAULT_WIDTH / 2);
    const scale = Math.min(MAX_SIDE / Math.max(w0, h0), Math.max(1, SVG_DEFAULT_WIDTH / w0));
    const canvas = window.document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w0 * scale));
    canvas.height = Math.max(1, Math.round(h0 * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser cannot convert the SVG.');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!png) throw new Error('The SVG could not be converted.');
    return png;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function LogoPicker({ doc, assetSha256, update }: { doc: TemplateDocumentV2; assetSha256: string | null; update: Update }) {
  const inputId = useId();
  const hintId = `${inputId}-hint`;
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const blocks = logoBlockIds(doc);

  function choose(sha256: string | null) {
    update((d) => {
      for (const id of logoBlockIds(d)) {
        const b = findLogo(d, id);
        if (b) b.assetSha256 = sha256;
      }
    });
  }

  async function upload(file: File) {
    setStatus(null);
    setBusy(true);
    try {
      const isSvg = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name);
      if (!isSvg && file.type !== 'image/png' && file.type !== 'image/jpeg') {
        throw new Error('Choose a PNG, JPEG or SVG file.');
      }
      const blob = isSvg ? await svgToPng(file) : file;
      if (blob.size > MAX_BYTES) throw new Error(`The file is ${(blob.size / 1024 / 1024).toFixed(1).replace('.', ',')} MB; a logo may have at most 1 MB.`);
      const stored = await booksApi.uploadAsset(blob);
      choose(stored.sha256);
      setStatus({ kind: 'ok', text: `Logo set (${stored.widthPx} × ${stored.heightPx} pixels).` });
    } catch (err) {
      setStatus({ kind: 'error', text: err instanceof Error && !('code' in err) ? err.message : errorText(err) });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-gray-600">Image</span>
      {assetSha256 ? (
        // eslint-disable-next-line @next/next/no-img-element -- a private, authenticated asset; the image optimiser cannot fetch it
        <img src={booksApi.assetUrl(assetSha256)} alt="The current logo" className="max-h-24 max-w-full self-start rounded border border-gray-500 bg-white object-contain p-1" />
      ) : (
        <p className="text-xs text-muted-foreground">No image yet: the block prints nothing until one is chosen.</p>
      )}
      <label htmlFor={inputId} className="text-xs font-medium text-gray-600">
        {assetSha256 ? 'Replace the logo' : 'Upload a logo'}
      </label>
      <input
        ref={input}
        id={inputId}
        type="file"
        accept="image/png,image/jpeg,image/svg+xml,.svg"
        disabled={busy}
        aria-describedby={hintId}
        className="text-sm file:mr-2 file:rounded-md file:border file:border-gray-500 file:bg-white file:px-2 file:py-1"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
        }}
      />
      <span id={hintId} className="text-xs text-muted-foreground">
        PNG, JPEG or SVG, at most 1 MB and 2000 pixels on the longer side.
        {blocks.length > 1 ? ' A template prints one logo: every logo block shows it.' : ''}
      </span>
      {assetSha256 ? (
        <Button size="sm" variant="ghost" className="self-start" onClick={() => choose(null)}>
          Remove the image
        </Button>
      ) : null}
      <p role="status" className={`text-xs ${status?.kind === 'error' ? 'text-red-800' : 'text-muted-foreground'}`}>
        {busy ? 'Uploading…' : (status?.text ?? '')}
      </p>
    </div>
  );
}

function findLogo(d: TemplateDocumentV2, id: string) {
  const at = locate(d, id);
  const b = at?.cell?.block ?? at?.block;
  return b && b.type === 'logo' ? b : null;
}

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
//
// "Your logos" (phase 4 decision 9, migration 014) lists the company's stored
// logos, newest first: choosing one sets it exactly as an upload does. A logo
// nothing uses can be deleted after a confirmation (it cannot be undone); one
// printed on an issued document or used by a template shows "In use" and
// offers no delete (the server refuses it anyway, 409 asset_in_use), and the
// one this template has chosen is not offered either, because the unsaved
// working copy names it. After a delete the focus moves to the first logo left,
// or to the upload when none is; every result is announced in the status line.

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { booksApi, type LogoAssetView } from '@/lib/books/api';

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

/** How a stored logo is named to a screen reader and in the dialog. */
function logoName(a: LogoAssetView): string {
  const day = new Date(a.createdAt);
  const uploaded = Number.isNaN(day.getTime()) ? '' : `, uploaded ${day.toLocaleDateString('de-DE')}`;
  return `${a.widthPx} × ${a.heightPx} pixels${uploaded}`;
}

export default function LogoPicker({ doc, assetSha256, update }: { doc: TemplateDocumentV2; assetSha256: string | null; update: Update }) {
  const inputId = useId();
  const hintId = `${inputId}-hint`;
  const listId = `${inputId}-logos`;
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  /** What runs now: an upload or a delete (the controls wait meanwhile). */
  const [working, setWorking] = useState<'upload' | 'delete' | null>(null);
  const busy = working !== null;
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [logos, setLogos] = useState<LogoAssetView[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  /** The logo the delete dialog asks about (null: closed). */
  const [pending, setPending] = useState<LogoAssetView | null>(null);
  /** Where the focus goes once a delete has settled: the list's first logo, or the upload. */
  const focusAfterDelete = useRef(false);
  /** The Delete button that opened the dialog (a cancel returns the focus to it). */
  const opener = useRef<HTMLElement | null>(null);
  const blocks = logoBlockIds(doc);

  const reload = useCallback(async (): Promise<LogoAssetView[] | null> => {
    try {
      const { items } = await booksApi.listAssets();
      setLogos(items);
      setListError(null);
      return items;
    } catch (err) {
      setListError(`Your logos could not be loaded. ${errorText(err)}`);
      return null;
    }
  }, []);

  useEffect(() => {
    let live = true;
    booksApi.listAssets().then(
      ({ items }) => {
        if (!live) return;
        setLogos(items);
        setListError(null);
      },
      (err: unknown) => {
        if (live) setListError(`Your logos could not be loaded. ${errorText(err)}`);
      },
    );
    return () => {
      live = false;
    };
  }, []);

  // After a delete settles and the list is drawn again: focus the first logo left, or the upload.
  useEffect(() => {
    if (!focusAfterDelete.current || logos === null) return;
    focusAfterDelete.current = false;
    const first = list.current?.querySelector<HTMLButtonElement>('button[data-logo-choose]');
    (first ?? input.current)?.focus();
  }, [logos]);

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
    setWorking('upload');
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
      void reload();
    } catch (err) {
      setStatus({ kind: 'error', text: err instanceof Error && !('code' in err) ? err.message : errorText(err) });
    } finally {
      setWorking(null);
      if (input.current) input.current.value = '';
    }
  }

  function chooseStored(a: LogoAssetView) {
    choose(a.sha256);
    setStatus({ kind: 'ok', text: `Logo set (${a.widthPx} × ${a.heightPx} pixels).` });
  }

  async function remove(a: LogoAssetView) {
    setStatus(null);
    setWorking('delete');
    focusAfterDelete.current = true;
    try {
      await booksApi.deleteAsset(a.sha256);
      setStatus({ kind: 'ok', text: 'Logo deleted.' });
    } catch (err) {
      // asset_in_use (it came into use meanwhile) or asset_not_found (deleted elsewhere): say so, show the list as it is now.
      setStatus({ kind: 'error', text: errorText(err) });
    } finally {
      setWorking(null);
      const items = await reload();
      // The list could not be read again: nothing will be drawn, so move the focus now.
      if (items === null && focusAfterDelete.current) {
        focusAfterDelete.current = false;
        input.current?.focus();
      }
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
        {working === 'upload' ? 'Uploading…' : working === 'delete' ? 'Deleting…' : (status?.text ?? '')}
      </p>

      <span id={listId} className="mt-1 text-xs font-medium text-gray-600">
        Your logos
      </span>
      {listError ? (
        <p className="text-xs text-red-800">{listError}</p>
      ) : logos === null ? (
        <p className="text-xs text-muted-foreground">Loading your logos…</p>
      ) : logos.length === 0 ? (
        <p className="text-xs text-muted-foreground">No logos stored yet. An uploaded logo appears here.</p>
      ) : (
        <ul ref={list} aria-labelledby={listId} className="flex flex-col gap-2">
          {logos.map((a) => {
            const chosen = a.sha256 === assetSha256;
            const name = logoName(a);
            return (
              <li key={a.sha256} className="flex items-center gap-2">
                <button
                  type="button"
                  data-logo-choose={a.sha256}
                  aria-pressed={chosen}
                  aria-label={`Choose the logo ${name}`}
                  disabled={busy}
                  onClick={() => chooseStored(a)}
                  className={`flex h-12 w-24 shrink-0 items-center justify-center rounded border bg-white p-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground ${
                    chosen ? 'border-foreground ring-2 ring-foreground' : 'border-gray-500'
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- a private, authenticated asset; the image optimiser cannot fetch it */}
                  <img src={booksApi.assetUrl(a.sha256)} alt="" className="max-h-full max-w-full object-contain" />
                </button>
                <span className="min-w-0 flex-1 text-xs text-muted-foreground">
                  {a.widthPx} × {a.heightPx}
                  {chosen ? <span className="block text-foreground">Chosen</span> : null}
                </span>
                {a.inUse ? (
                  <span className="shrink-0 rounded-full border border-gray-500 px-2 py-0.5 text-xs" title="Printed on an issued document or used by a template">
                    In use
                  </span>
                ) : chosen ? null : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="shrink-0 border-gray-500"
                    disabled={busy}
                    aria-label={`Delete the logo ${name}`}
                    onClick={(e) => {
                      opener.current = e.currentTarget;
                      setPending(a);
                    }}
                  >
                    Delete
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <AlertDialog
        open={pending !== null}
        onOpenChange={(next) => {
          if (!next) setPending(null);
        }}
      >
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            // A confirmed delete moves the focus itself once it has settled (the row is gone);
            // a cancelled one goes back to the Delete button that opened the dialog.
            event.preventDefault();
            if (!focusAfterDelete.current) opener.current?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this logo?</AlertDialogTitle>
            <AlertDialogDescription>
              {pending ? `The logo (${logoName(pending)}) is removed from this company's logos. This cannot be undone.` : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const target = pending;
                if (target) void remove(target);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function findLogo(d: TemplateDocumentV2, id: string) {
  const at = locate(d, id);
  const b = at?.cell?.block ?? at?.block;
  return b && b.type === 'logo' ? b : null;
}

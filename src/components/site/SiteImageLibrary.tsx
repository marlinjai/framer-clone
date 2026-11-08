'use client';

// src/components/site/SiteImageLibrary.tsx
//
// "Uploaded images" in Site settings: every image uploaded to the site, newest
// first, with its size and whether it is in use, and the site's totals against
// its limits (100 images, 50 MB). An image nothing names can be deleted, after
// a confirmation, through DELETE /api/projects/<id>/images/<sha256>; this is
// the way forward when an upload meets the limit.
//
// "In use" is the server's answer (the saved settings, a saved page or a kept
// published version names it, src/server/sites/siteImages.ts) joined with what
// this editor holds but has not saved yet (`namedHere`: the dialog's draft and
// every page's sharing image), so an image chosen a moment ago is never offered
// for deletion. The server checks again on delete.

import React from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { editorSiteImageUrl, formatBytes } from '@/lib/site/siteImages';
import { uploadFailureMessage } from './SiteImageField';

interface ListedImage {
  sha256: string;
  path: string;
  contentType: string;
  byteSize: number;
  width: number;
  height: number;
  inUse: boolean;
}

interface Listing {
  items: ListedImage[];
  totalBytes: number;
  maxImages: number;
  maxBytes: number;
}

export interface SiteImageLibraryProps {
  projectId: string;
  /** Hashes this editor names but may not have saved yet (never offered for deletion). */
  namedHere: ReadonlySet<string>;
  /** Changes whenever an upload finished, so the list reloads. */
  version: number;
}

export function SiteImageLibrary({ projectId, namedHere, version }: SiteImageLibraryProps) {
  const [listing, setListing] = React.useState<Listing | null>(null);
  const [loadError, setLoadError] = React.useState('');
  const [confirming, setConfirming] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState('');
  const [status, setStatus] = React.useState('');
  const [reload, setReload] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    setLoadError('');
    fetch(`/api/projects/${encodeURIComponent(projectId)}/images`, { cache: 'no-store' })
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok) {
          setLoadError(uploadFailureMessage(res.status, body?.error?.message, 'open Site settings'));
          return;
        }
        setListing(body as Listing);
      })
      .catch(() => {
        if (!cancelled) setLoadError('The uploaded images could not be loaded. Check your connection, then open Site settings again.');
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, version, reload]);

  const remove = async (image: ListedImage) => {
    setDeleting(image.sha256);
    setActionError('');
    setStatus('');
    let res: Response;
    try {
      res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/images/${image.sha256}`, { method: 'DELETE' });
    } catch {
      setDeleting(null);
      setActionError('The delete did not reach the server. Check your connection and try again.');
      return;
    }
    setDeleting(null);
    setConfirming(null);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setActionError(uploadFailureMessage(res.status, body?.error?.message, 'delete the image'));
      setReload((n) => n + 1);
      return;
    }
    setStatus('Image deleted.');
    setReload((n) => n + 1);
  };

  if (loadError) return <p className="text-[11px] text-destructive" role="alert">{loadError}</p>;
  if (!listing) {
    return (
      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Loader2 size={12} className="animate-spin" aria-hidden /> Loading uploaded images
      </p>
    );
  }
  if (listing.items.length === 0) {
    return <p className="text-[11px] text-muted-foreground">No images uploaded yet.</p>;
  }

  return (
    <div className="flex flex-col gap-2" data-testid="site-image-library">
      <p className="text-[11px] text-muted-foreground">
        {listing.items.length} of {listing.maxImages} images, {formatBytes(listing.totalBytes)} of {formatBytes(listing.maxBytes)}.
        An image in use by the settings, a page or a published version kept for rollback cannot be deleted.
      </p>
      <div className="sr-only" role="status" aria-live="polite">{status}</div>
      {actionError && <p className="text-[11px] text-destructive" role="alert">{actionError}</p>}
      <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
        {listing.items.map((image) => {
          const inUse = image.inUse || namedHere.has(image.sha256);
          const preview = editorSiteImageUrl(projectId, image.path);
          return (
            <li key={image.sha256} className="flex items-center gap-3 p-2 text-[11px]" data-testid={`site-image-row-${image.sha256}`}>
              {preview && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={preview} alt="" className="h-8 w-12 shrink-0 rounded border border-border bg-background object-contain" />
              )}
              <span className="min-w-0 flex-1 text-muted-foreground">
                {image.width} by {image.height} pixels, {formatBytes(image.byteSize)}
              </span>
              {inUse ? (
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-medium text-foreground">In use</span>
              ) : confirming === image.sha256 ? (
                <span className="flex shrink-0 items-center gap-1">
                  <span className="text-foreground">Delete for good?</span>
                  <Button type="button" size="sm" variant="destructive" disabled={deleting !== null} onClick={() => void remove(image)}>
                    {deleting === image.sha256 ? <Loader2 size={12} className="animate-spin" aria-hidden /> : null}
                    Delete
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(null)}>Keep</Button>
                </span>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="shrink-0"
                  onClick={() => setConfirming(image.sha256)}
                  aria-label={`Delete the unused image of ${image.width} by ${image.height} pixels`}
                >
                  <Trash2 size={13} aria-hidden />
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

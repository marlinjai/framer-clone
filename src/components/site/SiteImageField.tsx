'use client';

// src/components/site/SiteImageField.tsx
//
// One image setting of a site: the favicon or a sharing image (Site settings),
// or a page's own sharing image (Page settings). The owner either uploads a
// file or types the https address of an image hosted elsewhere; the field
// holds one value either way (src/lib/site/siteImages.ts):
//
//   - Upload: the file is checked here first with the same rules as the server
//     (type from the bytes, size, pixels), so a wrong file is named at once
//     without a round trip, then sent to POST /api/projects/<id>/images. The
//     answer's path becomes the value. The preview, the file name, its size
//     and pixel size, and any warning (a non-square icon, a sharing image far
//     from 1200 by 630) show under the field.
//   - Address: typing replaces an upload; the preview loads the address.
//   - Remove clears the value.
//
// Every failure says what happened and what to do next: a refused file, a
// file over 2 MB, the network, a signed-out session, a missing permission.
// Nothing changes the settings until the dialog's own Save.

import React from 'react';
import { ImageUp, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  checkSiteImage,
  editorSiteImageUrl,
  formatBytes,
  isSiteImagePath,
  siteImageWarnings,
  type SiteImageKind,
} from '@/lib/site/siteImages';
import { isHttpsUrl } from '@/lib/site/siteSettings';

const fieldLabel = 'text-[11px] font-semibold uppercase tracking-wide text-muted-foreground';
const inputBase =
  'h-9 w-full rounded-md border bg-background px-3 text-sm outline-none transition-shadow focus-visible:ring-[3px]';
const inputOk = 'border-input focus-visible:border-ring focus-visible:ring-ring/40';
const inputBad = 'border-destructive focus-visible:border-destructive focus-visible:ring-destructive/30';
const hint = 'text-[11px] text-muted-foreground';

/** What the file picker offers per kind (the server decides from the bytes either way). */
const ACCEPT: Record<SiteImageKind, string> = {
  favicon: 'image/png,image/x-icon,image/vnd.microsoft.icon,.png,.ico',
  sharing: 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp',
};

const TYPE_NAMES: Record<string, string> = {
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/webp': 'WebP',
  'image/x-icon': 'ICO',
};

/** What the field knows about the image it shows. */
interface ImageFacts {
  fileName?: string;
  byteSize?: number;
  contentType?: string;
  width?: number;
  height?: number;
}

/** The upload answer (src/app/api/projects/[projectId]/images/route.ts). */
interface UploadAnswer {
  path: string;
  byteSize: number;
  contentType: string;
  width: number;
  height: number;
}

/** A failed upload's message, by status, with the next step. */
export function uploadFailureMessage(status: number, serverMessage: string | undefined): string {
  switch (status) {
    case 401:
      return 'You are signed out. Sign in again (for example in a new tab), then upload the file again.';
    case 403:
      return 'You are not allowed to change this site. Ask an admin of the company for edit rights, or switch to the company that owns this site.';
    case 404:
      return 'This site was not found on the server. Reload the editor and try again.';
    case 503:
      return 'The sign-in service is not answering right now. Wait a moment and upload the file again.';
    default:
      // 409, 413, 415 and 422 carry their own message with the next step.
      return serverMessage || `The upload failed (status ${status}). Nothing was stored; try again in a moment.`;
  }
}

export interface SiteImageFieldProps {
  projectId: string;
  kind: SiteImageKind;
  /** The DOM id of the address input (the dialogs focus it for an error). */
  inputId: string;
  inputRef?: React.Ref<HTMLInputElement>;
  label: string;
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  /** The dialog's validation message for the value, if shown. */
  error?: string;
  hintText: string;
  /** Show the preview as a small square (the favicon). */
  square?: boolean;
}

export function SiteImageField({ projectId, kind, inputId, inputRef, label, value, onChange, onBlur, error, hintText, square }: SiteImageFieldProps) {
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = React.useState(false);
  const [uploadError, setUploadError] = React.useState('');
  const [status, setStatus] = React.useState('');
  const [facts, setFacts] = React.useState<ImageFacts>({});
  const [previewFailed, setPreviewFailed] = React.useState(false);

  const uploaded = isSiteImagePath(value);
  const previewUrl = uploaded ? editorSiteImageUrl(projectId, value) : isHttpsUrl(value) ? value : null;
  React.useEffect(() => setPreviewFailed(false), [previewUrl]);

  const warnings = facts.width && facts.height ? siteImageWarnings(kind, { width: facts.width, height: facts.height }) : [];
  const shownError = uploadError || error;
  const describedBy = [shownError ? `${inputId}-error` : `${inputId}-hint`, warnings.length > 0 ? `${inputId}-warnings` : '']
    .filter(Boolean)
    .join(' ');

  const upload = async (file: File) => {
    setUploadError('');
    setStatus('');
    const bytes = new Uint8Array(await file.arrayBuffer());
    // The server's own rules, run here first: a wrong file is named without a round trip.
    const check = checkSiteImage(bytes, kind);
    if (!check.ok) {
      setUploadError(check.problem.message);
      return;
    }
    setUploading(true);
    setStatus(`Uploading ${file.name}`);
    let res: Response;
    try {
      res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/images?kind=${kind}`, {
        method: 'POST',
        headers: { 'content-type': file.type || 'application/octet-stream' },
        body: bytes,
      });
    } catch {
      setUploading(false);
      setStatus('');
      setUploadError('The upload did not reach the server. Check your connection and upload the file again.');
      return;
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    setUploading(false);
    if (!res.ok) {
      const message = (body as { error?: { message?: string } } | null)?.error?.message;
      setStatus('');
      setUploadError(uploadFailureMessage(res.status, message));
      return;
    }
    const answer = body as UploadAnswer;
    setFacts({ fileName: file.name, byteSize: answer.byteSize, contentType: answer.contentType, width: answer.width, height: answer.height });
    setStatus(`${file.name} uploaded. Save the settings to use it.`);
    onChange(answer.path);
  };

  const onFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // The same file may be picked again after a failure.
    event.target.value = '';
    if (file) void upload(file);
  };

  const describe = (): string => {
    const parts: string[] = [];
    if (facts.contentType) parts.push(TYPE_NAMES[facts.contentType] ?? facts.contentType);
    if (facts.width && facts.height) parts.push(`${facts.width} by ${facts.height} pixels`);
    if (facts.byteSize !== undefined) parts.push(formatBytes(facts.byteSize));
    return parts.join(', ');
  };

  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid={`site-image-field-${kind}`}>
      <label htmlFor={inputId} className={fieldLabel}>
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={inputId}
          ref={inputRef}
          type="url"
          value={uploaded ? '' : value}
          placeholder={uploaded ? 'Uploaded file in use (type an address to replace it)' : 'https://'}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setUploadError('');
            setStatus('');
            setFacts({});
            onChange(e.target.value.trim());
          }}
          onBlur={onBlur}
          aria-invalid={shownError ? true : undefined}
          aria-describedby={describedBy}
          className={`${inputBase} ${shownError ? inputBad : inputOk}`}
        />
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPT[kind]}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={onFile}
          data-testid={`site-image-file-${kind}`}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          disabled={uploading}
          onClick={() => fileRef.current?.click()}
          aria-label={`Upload ${label.toLowerCase()}`}
        >
          {uploading ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <ImageUp size={14} aria-hidden />}
          {uploading ? 'Uploading' : 'Upload'}
        </Button>
      </div>
      <div className="sr-only" role="status" aria-live="polite">
        {status}
      </div>
      {shownError ? (
        <p id={`${inputId}-error`} className="text-[11px] text-destructive" role="alert">
          {shownError}
        </p>
      ) : (
        <p id={`${inputId}-hint`} className={hint}>
          {hintText} {kind === 'favicon' ? 'Upload a PNG or ICO file' : 'Upload a PNG, JPEG or WebP file'} of up to 2 MB, or enter an address.
        </p>
      )}
      {previewUrl && (
        <div className="flex items-center gap-3 rounded-md border border-border bg-muted/40 p-2" data-testid={`site-image-preview-${kind}`}>
          {previewFailed ? (
            <p className="flex-1 text-[11px] text-destructive">
              {uploaded
                ? 'The uploaded image could not be loaded. Check your connection, or upload the file again.'
                : 'This image could not be loaded. Check that the address opens the image itself.'}
            </p>
          ) : (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={previewUrl}
                alt={`${label} preview`}
                onError={() => setPreviewFailed(true)}
                onLoad={(e) => {
                  const img = e.currentTarget;
                  // An image chosen before this dialog opened: its pixel size still drives the warnings.
                  if (!facts.width && img.naturalWidth > 0) setFacts((f) => ({ ...f, width: img.naturalWidth, height: img.naturalHeight }));
                }}
                className={`shrink-0 rounded border border-border bg-background object-contain ${square ? 'h-8 w-8' : 'h-16 w-28'}`}
              />
              <div className="min-w-0 flex-1 text-[11px]">
                <p className="truncate font-medium text-foreground">{facts.fileName ?? (uploaded ? 'Uploaded image' : 'Image from address')}</p>
                {describe() && <p className="text-muted-foreground">{describe()}</p>}
              </div>
            </>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="shrink-0"
            onClick={() => {
              setFacts({});
              setUploadError('');
              setStatus(`${label} removed. Save the settings to apply.`);
              onChange('');
            }}
            aria-label={`Remove ${label.toLowerCase()}`}
          >
            <X size={14} aria-hidden />
          </Button>
        </div>
      )}
      {warnings.length > 0 && (
        <ul id={`${inputId}-warnings`} className="flex flex-col gap-0.5 text-[11px] text-amber-700 dark:text-amber-400" data-testid={`site-image-warnings-${kind}`}>
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

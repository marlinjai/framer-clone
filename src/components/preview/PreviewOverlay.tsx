'use client';

// src/components/preview/PreviewOverlay.tsx
//
// The preview shown over the editor, like Framer's: the Play button opens it
// at once from the store the editor already holds (no navigation, no server
// round trip, unsaved work included), filling the window. "Editor", Escape
// and the browser's Back close it, and the editor underneath is exactly as it
// was. The preview routes (/projects/<id>/preview, /preview) stay for direct
// links.
//
// Address: opening pushes `?preview=1` onto the editor's address, so Back
// closes the preview and a reload comes back to it (EditorApp opens it when
// the parameter is there). Closing from the preview steps back over that
// entry when this overlay pushed it, and otherwise just drops the parameter.

import React from 'react';
import { createPortal } from 'react-dom';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';
import PreviewShell from './PreviewShell';

/** The address parameter that marks the preview as open over the editor. */
export const PREVIEW_PARAM = 'preview';

/** Whether the current address asks for the preview over the editor. */
export function previewRequestedInLocation(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get(PREVIEW_PARAM) === '1';
}

function addressWithPreview(open: boolean): string {
  const url = new URL(window.location.href);
  if (open) url.searchParams.set(PREVIEW_PARAM, '1');
  else url.searchParams.delete(PREVIEW_PARAM);
  return url.toString();
}

const PreviewOverlay = observer(() => {
  const { editorUI } = useStore();
  const open = editorUI.previewOpen;
  // True while the history entry for this opening is ours to step back over.
  const pushedRef = React.useRef(false);
  const rootRef = React.useRef<HTMLDivElement>(null);
  // Where focus was when the preview opened, to give it back on close.
  const returnFocusRef = React.useRef<HTMLElement | null>(null);

  // Keep the address in step with the open state.
  React.useEffect(() => {
    if (open) {
      if (!previewRequestedInLocation()) {
        window.history.pushState(window.history.state, '', addressWithPreview(true));
        pushedRef.current = true;
      }
      return;
    }
    pushedRef.current = false;
    if (previewRequestedInLocation()) {
      window.history.replaceState(window.history.state, '', addressWithPreview(false));
    }
  }, [open]);

  // Back (or Forward) moves between "preview" and "editor": follow it.
  React.useEffect(() => {
    const onPop = () => {
      const wanted = previewRequestedInLocation();
      if (!wanted) pushedRef.current = false;
      if (wanted !== editorUI.previewOpen) editorUI.setPreviewOpen(wanted);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [editorUI]);

  // Focus moves into the preview, and back to where it was on close.
  React.useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = rootRef.current;
    // The portal root is a direct child of <body>; everything else is the editor
    // behind it. Inert keeps Tab and assistive technology inside the preview.
    const background = Array.from(document.body.children).filter(
      (el): el is HTMLElement => el instanceof HTMLElement && el !== root && !el.hasAttribute('inert'),
    );
    background.forEach((el) => el.setAttribute('inert', ''));
    // The page itself, so Space and the arrows scroll it; the dialog when the
    // page has no frame (no viewports).
    const frame = root?.querySelector<HTMLElement>('[data-preview-frame]');
    (frame ?? root)?.focus({ preventScroll: true });
    return () => {
      // Before focus returns: an inert element cannot take focus.
      background.forEach((el) => el.removeAttribute('inert'));
      const back = returnFocusRef.current;
      returnFocusRef.current = null;
      if (back && back.isConnected) back.focus({ preventScroll: true });
    };
  }, [open]);

  const close = React.useCallback(() => {
    if (pushedRef.current) {
      // Our entry: step back over it, so Forward does not reopen a stale one.
      // The popstate that follows closes the preview.
      pushedRef.current = false;
      window.history.back();
      return;
    }
    editorUI.setPreviewOpen(false);
  }, [editorUI]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={rootRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Preview"
      data-testid="preview-overlay"
      className="fixed inset-0 z-[1000] outline-none"
    >
      <PreviewShell onClose={close} />
    </div>,
    document.body,
  );
});

PreviewOverlay.displayName = 'PreviewOverlay';
export default PreviewOverlay;

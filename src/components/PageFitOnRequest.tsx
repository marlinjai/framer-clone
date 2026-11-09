// src/components/PageFitOnRequest.tsx
//
// Brings the open page's breakpoint frames into view when something asks for it
// (editorUI.requestPageFit): "Open it" on the notice for an agent's new page
// (src/components/EditorNotice.tsx), opened while the camera may look at an
// empty part of the canvas. The frames render a frame or two after the page is
// set, so the fit retries for a short while until there is something to measure.
// Mounted inside the canvas (it needs the camera's context); renders nothing.
'use client';

import React from 'react';
import { reaction } from 'mobx';
import { useStore } from '@/hooks/useStore';
import { useCameraControls } from '@/lib/canvas/cameraControls';

/** Room around the frames, and never zoomed in past 100% (the page's own size). */
const FIT = { mode: 'contain' as const, padding: 48, maxZoom: 1 };
/** About half a second of animation frames to wait for the frames to render. */
const FIT_TRIES = 30;

export default function PageFitOnRequest() {
  const { editorUI } = useStore();
  const { fit } = useCameraControls();
  React.useEffect(() => {
    let raf = 0;
    const fitWhenReady = (triesLeft: number) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (!fit(FIT) && triesLeft > 0) fitWhenReady(triesLeft - 1);
      });
    };
    const stop = reaction(
      () => editorUI.pageFitRequest,
      () => fitWhenReady(FIT_TRIES),
    );
    return () => {
      stop();
      cancelAnimationFrame(raf);
    };
  }, [editorUI, fit]);
  return null;
}

// src/components/PageFitOnRequest.tsx
//
// Brings the open page's breakpoint frames into view when something asks for it
// (editorUI.requestPageFit): "Open it" on the notice for an agent's new page
// (src/components/EditorNotice.tsx), opened while the camera may look at an
// empty part of the canvas. The frames are fitted into the part of the canvas
// the person sees (less the top bar, the docked sidebars and the toolbar, which
// cover it: visibleCanvasRect), with room for the frame labels above them. The
// frames render a frame or two after the page is set, so the fit retries for a
// short while until there is something to measure. On a phone the phone layout
// already fits the page whenever it changes (PhoneEditorChrome), so nothing is
// done there. Mounted inside the canvas (it needs the camera's context);
// renders nothing.
'use client';

import React from 'react';
import { reaction } from 'mobx';
import { useStore } from '@/hooks/useStore';
import { useIsPhone } from '@/hooks/use-mobile';
import { useCameraControls, type CanvasInsets } from '@/lib/canvas/cameraControls';
import { visibleCanvasRect } from '@/components/live/AgentPresenceLayer';

/** Room around the frames, and never zoomed in past 100% (the page's own size). */
const FIT = { mode: 'contain' as const, padding: 32, maxZoom: 1 };
/** The frame labels sit this far above each frame: kept clear of the top bar. */
const FRAME_LABEL_SPACE = 28;
/** About half a second of animation frames to wait for the frames to render. */
const FIT_TRIES = 30;

/** The canvas edges the editor chrome covers, as insets of the canvas element. */
export function chromeInsets(): CanvasInsets {
  const ground = document.querySelector<HTMLElement>('[data-ground]');
  if (!ground) return {};
  const g = ground.getBoundingClientRect();
  const v = visibleCanvasRect();
  return {
    top: Math.max(0, v.top - g.top) + FRAME_LABEL_SPACE,
    left: Math.max(0, v.left - g.left),
    right: Math.max(0, g.right - v.right),
    bottom: Math.max(0, g.bottom - v.bottom),
  };
}

export default function PageFitOnRequest() {
  const { editorUI } = useStore();
  const { fit } = useCameraControls();
  const isPhone = useIsPhone();
  React.useEffect(() => {
    if (isPhone) return;
    let raf = 0;
    const fitWhenReady = (triesLeft: number) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (!fit({ ...FIT, insets: chromeInsets() }) && triesLeft > 0) fitWhenReady(triesLeft - 1);
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
  }, [editorUI, fit, isPhone]);
  return null;
}

'use client';
// src/components/fx/FxLayer.tsx
//
// The layer an FX scene (src/lib/fxScene) is drawn in, in the editor: on the canvas
// while "Live" is on for a box, and in the preview as on the published page.
//
// The layer is rendered by React as a child of the box, never put there by hand.
// The canvas re-renders a box on every edit, and React replaces the content of a
// box that holds only text: a layer inserted behind React's back would be wiped,
// with its WebGL context left running. The engine draws INTO the layer through a
// React root of its own (src/lib/fxScene/mount.tsx, `renderFxScene`), fetched by a
// dynamic import only when a scene will really be drawn. This file imports no
// engine code.
//
// One WebGL context per surface. A node can be drawn many times on one surface (a
// repeated child, a component placed twice), so which element draws is decided by
// a claim (src/lib/fxScene/claim.ts): the first element to ask holds it, the others
// stay calm, and when the holder goes away one of them takes over.
//
//  - Canvas (`FxCanvasLayer`): drawn at once (the person asked for it), sized from
//    the layout so the zoom does not scale it twice, and every change of the scene
//    updates the same context. What it is doing is reported to the store, for the
//    FX section of the panel. Under reduced motion the engine holds one still frame.
//  - Preview (`FxPreviewLayer`): the published island's own steps, from the shared
//    src/lib/fxScene/start.ts: reduced motion, the WebGL probe, the start
//    (`settled`, `visible`, `immediate`), then the engine. Only inside a preview
//    frame (FxPreviewContext); anywhere else it renders nothing.
//
// Both run on the editor's origin, where a stored picture (`/site-images/...`) is
// served from the editor's own address behind sign-in (editorSiteImageUrl).
//
// What the layer is doing is written on the layer as `data-fc-fx-state`, with the
// published page's own state names (src/lib/fxScene/marker.ts).

import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';
import { FX_LAYER_STYLE, holdFxBox } from '@/lib/fxScene/box';
import { FxClaim } from '@/lib/fxScene/claim';
import { parseFxProp } from '@/lib/fxScene/fxScene';
import { FX_LAYER_ATTR, FX_STATE_ATTR, type FxState } from '@/lib/fxScene/marker';
import { FX_REDUCED_MOTION_QUERY, FX_WARNING, fxStartDecision, whenStarted, type FxStartSettings } from '@/lib/fxScene/start';
import { editorSiteImageUrl } from '@/lib/site/siteImages';

/** A preview frame's one-context claim. Without it (any other use of the headless renderer) no scene is drawn. */
export const FxPreviewContext = React.createContext<FxClaim | null>(null);

// useLayoutEffect warns during server rendering; nothing here draws on a server.
const useBeforePaint = typeof window === 'undefined' ? useEffect : useLayoutEffect;

const LAYER_STYLE: React.CSSProperties = {
  position: FX_LAYER_STYLE.position,
  inset: FX_LAYER_STYLE.inset,
  zIndex: Number(FX_LAYER_STYLE.zIndex),
  overflow: FX_LAYER_STYLE.overflow,
  pointerEvents: FX_LAYER_STYLE.pointerEvents,
  transition: FX_LAYER_STYLE.transition,
  borderRadius: FX_LAYER_STYLE.borderRadius,
};

/** Whether this element holds the surface's one context; it asks whenever the claim is free. */
function useFxClaim(claim: FxClaim, wanted: boolean): boolean {
  const who = useRef<object>({}).current;
  const holder = useSyncExternalStore(claim.subscribe, claim.snapshot, () => undefined);
  useEffect(() => {
    if (wanted && holder === undefined) claim.claim(who);
  }, [claim, wanted, holder, who]);
  useEffect(() => {
    if (!wanted) claim.release(who);
  }, [claim, wanted, who]);
  useEffect(() => () => claim.release(who), [claim, who]);
  return wanted && holder === who;
}

type LayerStatus = { state: FxState; reason?: string };

interface DrawnLayerProps {
  /** The box's stored `fx` prop. */
  stored: unknown;
  /** Whether this element draws. False: the layer is there and calm. */
  draws: boolean;
  /** The state to show while it does not draw. */
  idle: FxState;
  /** When to start, as on the published page. Left out: at once. */
  start?: FxStartSettings['start'];
  /** Size the canvas from the layout (a surface scaled by a CSS transform). */
  layoutSize?: boolean;
  projectId: string | undefined;
  /** The box's own inline position, when it has one: the layer leaves it alone. */
  ownPosition: unknown;
  onStatus?: (status: LayerStatus) => void;
}

/** The layer itself, and the engine in it while `draws`. */
function DrawnLayer({ stored, draws, idle, start, layoutSize = false, projectId, ownPosition, onStatus }: DrawnLayerProps) {
  const layerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<LayerStatus>({ state: idle });
  const handle = useRef<{ update: (stored: unknown) => void; teardown: () => void } | null>(null);
  const latest = useRef({ stored, projectId, onStatus, ownPosition });
  latest.current = { stored, projectId, onStatus, ownPosition };

  // The box holds the layer: a stacking context, and a position when it has none
  // (src/lib/fxScene/box.ts). Again whenever the box's own position changes, so a
  // position the author sets or takes away while the scene is live is respected.
  const hasOwnPosition = ownPosition != null && ownPosition !== '';
  useBeforePaint(() => {
    const box = layerRef.current?.parentElement;
    if (!draws || !box) return;
    const release = holdFxBox(box);
    return () => release(latest.current.ownPosition != null && latest.current.ownPosition !== '');
  }, [draws, hasOwnPosition]);

  useEffect(() => {
    const layer = layerRef.current;
    const box = layer?.parentElement;
    const say = (next: LayerStatus) => {
      setStatus(next);
      latest.current.onStatus?.(next);
    };
    if (!draws || !layer || !box) {
      say({ state: idle });
      return;
    }
    let stopped = false;
    say({ state: start ? 'waiting' : 'loading' });
    const go = () => {
      if (stopped) return;
      say({ state: 'loading' });
      import('@/lib/fxScene/mount').then(
        ({ renderFxScene }) => {
          if (stopped) return;
          handle.current = renderFxScene(layer, latest.current.stored, {
            layoutSize,
            resolveImage: (src) => {
              const id = latest.current.projectId;
              return id ? editorSiteImageUrl(id, src) : null;
            },
            onLive: () => {
              if (stopped) return;
              layer.style.opacity = '1';
              say({ state: 'live' });
            },
            onOff: (reason) => {
              if (stopped) return;
              layer.style.opacity = '0';
              say({ state: 'off', reason });
              if (reason !== 'refused') console.warn(FX_WARNING, `Reason: ${reason}.`);
            },
          });
        },
        (error: unknown) => {
          if (stopped) return;
          say({ state: 'off', reason: 'engine' });
          console.warn(FX_WARNING, 'The engine did not load.', error);
        },
      );
    };
    const cancelStart = start ? whenStarted(box, start, go) : (go(), () => {});
    return () => {
      stopped = true;
      cancelStart();
      // The old context is released here, before another element starts one.
      handle.current?.teardown();
      handle.current = null;
      layer.style.opacity = '0';
    };
  }, [draws, idle, start, layoutSize]);

  // A changed scene is drawn in the same context.
  useEffect(() => {
    handle.current?.update(stored);
  }, [stored]);

  return <div ref={layerRef} aria-hidden="true" {...{ [FX_LAYER_ATTR]: '', [FX_STATE_ATTR]: status.state }} style={{ ...LAYER_STYLE, opacity: 0 }} />;
}

export interface FxLayerProps {
  /** The box's stored `fx` prop. */
  stored: unknown;
  /** The box's own inline position, when it has one. */
  ownPosition?: unknown;
}

/** On the canvas, for the box and the frame "Live" is on for (ComponentRenderer decides that). */
export const FxCanvasLayer = observer(function FxCanvasLayer({ stored, ownPosition }: FxLayerProps) {
  const { editorUI } = useStore();
  const draws = useFxClaim(editorUI.fxLiveClaim, true);
  return (
    <DrawnLayer
      stored={stored}
      draws={draws}
      idle="calm"
      layoutSize
      projectId={editorUI.currentProject?.id}
      ownPosition={ownPosition}
      onStatus={
        draws
          ? (status) =>
              editorUI.reportFxLive(
                status.state === 'live' ? { state: 'live' } : status.state === 'off' ? { state: 'off', reason: status.reason ?? 'renderer-error' } : { state: 'loading' },
              )
          : undefined
      }
    />
  );
});

/** Whether the person asks for reduced motion, followed while the page is open. */
function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (listener) => {
      const query = window.matchMedia(FX_REDUCED_MOTION_QUERY);
      query.addEventListener('change', listener);
      return () => query.removeEventListener('change', listener);
    },
    () => window.matchMedia(FX_REDUCED_MOTION_QUERY).matches,
    () => false,
  );
}

/** In a preview frame: one scene per frame, started as the published page starts it. */
function PreviewLayer({ stored, ownPosition, claim, settings }: FxLayerProps & { claim: FxClaim; settings: FxStartSettings }) {
  const { editorUI } = useStore();
  // Read again when the preference changes: a background scene is dropped, a frame scene is drawn again.
  const reduced = useReducedMotion();
  const [decision, setDecision] = useState<'calm' | 'off' | 'go' | null>(null);
  useEffect(() => {
    const next = fxStartDecision(settings);
    setDecision(next);
    if (next === 'off') console.warn(FX_WARNING, 'WebGL is not available.');
  }, [settings.calm, settings.start, reduced]); // eslint-disable-line react-hooks/exhaustive-deps
  const holds = useFxClaim(claim, decision === 'go');
  return (
    <DrawnLayer
      // A new element for a new preference: the scene starts over, as the island runs its program again.
      key={reduced ? 'reduced' : 'motion'}
      stored={stored}
      draws={holds}
      idle={decision === 'off' ? 'off' : 'calm'}
      start={settings.start}
      projectId={editorUI.currentProject?.id}
      ownPosition={ownPosition}
    />
  );
}

/** In the preview. Renders nothing outside a preview frame, and for a scene the reader refuses (a plain box, as published). */
export function FxPreviewLayer({ stored, ownPosition }: FxLayerProps) {
  const claim = React.useContext(FxPreviewContext);
  if (!claim) return null;
  const read = parseFxProp(stored);
  if (!read.ok) return null;
  return <PreviewLayer stored={stored} ownPosition={ownPosition} claim={claim} settings={{ start: read.fx.start, calm: read.fx.calm }} />;
}

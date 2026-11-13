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
//    On the canvas the layer also takes clicks that pick one layer of the scene, outlines the
//    picked one and drags a picked text box (./useCanvasPick, ./FxPickOutline). That code is the
//    editor-only `@/lib/fx/pick`, which this file loads by an import of its own, only here: the
//    published island never reaches it.
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

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';
import { FX_LAYER_STYLE, holdFxBox } from '@/lib/fxScene/box';
import { FxClaim } from '@/lib/fxScene/claim';
import { parseFxProp } from '@/lib/fxScene/fxScene';
import { FX_LAYER_ATTR, FX_STATE_ATTR, type FxState } from '@/lib/fxScene/marker';
import { FX_REDUCED_MOTION_QUERY, FX_WARNING, fxStartDecision, whenStarted, type FxStartSettings } from '@/lib/fxScene/start';
import { editorSiteImageUrl } from '@/lib/site/siteImages';
import { FxPickOutline } from './FxPickOutline';
import { useCanvasPick, type CanvasPickTools } from './useCanvasPick';

/** What the live scene hands out for picking (a type: the editor-only pick entry is loaded by a dynamic import below). */
const loadPick = () => import('@/lib/fx/pick');
type PickModule = Awaited<ReturnType<typeof loadPick>>;
type SceneProbe = Parameters<PickModule['createPicker']>[0];

/** A preview frame's one-context claim. Without it (any other use of the headless renderer) no scene is drawn. */
export const FxPreviewContext = React.createContext<FxClaim | null>(null);

// useLayoutEffect warns during server rendering; nothing here draws on a server.
/** Whether the box's inline position is the author's own. An authored `static` is not: the hold changes it, and gives it back. */
const isOwn = (position: unknown) => position != null && position !== '' && position !== 'static';

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
  /** The canvas's: what picking a layer needs from the live scene. Fixed for the life of the layer. */
  onProbe?: (probe: SceneProbe | null) => void;
  /** The scene layer's element, for a caller that works on it (the canvas's picking). */
  elementRef?: React.RefObject<HTMLDivElement | null>;
}

/** The layer itself, and the engine in it while `draws`. */
function DrawnLayer({ stored, draws, idle, start, layoutSize = false, projectId, ownPosition, onStatus, onProbe, elementRef }: DrawnLayerProps) {
  const ownRef = useRef<HTMLDivElement>(null);
  const layerRef = elementRef ?? ownRef;
  const [status, setStatus] = useState<LayerStatus>({ state: idle });
  const handle = useRef<{ update: (stored: unknown) => void; teardown: () => void } | null>(null);
  const latest = useRef({ stored, projectId, onStatus, ownPosition });
  // What asynchronous callbacks read: the last COMMITTED values, never those of a render React may still discard.
  // Declared first, so it runs before the effects below in the same commit.
  useBeforePaint(() => {
    latest.current = { stored, projectId, onStatus, ownPosition };
  });

  // The box holds the layer: a stacking context, and a position when it has none
  // (src/lib/fxScene/box.ts). Again whenever the box's own position changes, so a
  // position the author sets or takes away while the scene is live is respected.
  const hasOwnPosition = isOwn(ownPosition);
  const held = useRef<((positionIsOwned?: boolean) => void) | null>(null);
  const heldFor = useRef({ draws, hasOwnPosition });
  useBeforePaint(() => {
    const box = layerRef.current?.parentElement;
    if (!draws || !box) return;
    held.current = holdFxBox(box);
    return () => {
      held.current?.(isOwn(latest.current.ownPosition));
      held.current = null;
    };
  }, [draws]);
  // The box's own position set or taken away while the scene is live: hold the box again on the new footing.
  // The old hold leaves the position alone, because the renderer has already set the new one.
  useBeforePaint(() => {
    const before = heldFor.current;
    heldFor.current = { draws, hasOwnPosition };
    const box = layerRef.current?.parentElement;
    if (!draws || !box || before.draws !== draws || before.hasOwnPosition === hasOwnPosition) return;
    held.current?.(true);
    held.current = holdFxBox(box);
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
      // One handler for a chunk that does not arrive and for a set-up that throws: either
      // way the layer is off and says so, never left "loading".
      import('@/lib/fxScene/mount')
        .then(({ renderFxScene }) => {
          if (stopped) return;
          handle.current = renderFxScene(layer, latest.current.stored, {
            layoutSize,
            onProbe,
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
        })
        .catch((error: unknown) => {
          if (stopped) return;
          handle.current?.teardown();
          handle.current = null;
          say({ state: 'off', reason: 'engine' });
          console.warn(FX_WARNING, 'The engine did not load.', error);
        });
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
  const layerRef = useRef<HTMLDivElement>(null);
  const [probe, setProbe] = useState<SceneProbe | null>(null);
  const [pick, setPick] = useState<PickModule | null>(null);
  // The editor-only pick code, by an import of its own: a chunk that does not arrive costs the
  // picking and nothing else (the scene itself is the engine's import, in DrawnLayer).
  useEffect(() => {
    if (!draws) return;
    let stopped = false;
    loadPick()
      .then((module) => {
        if (!stopped) setPick(module);
      })
      .catch((error: unknown) => console.warn(FX_WARNING, 'Picking a layer on the canvas is not available.', error));
    return () => {
      stopped = true;
    };
  }, [draws]);
  // Only while the scene really draws: a refused scene or a lost context leaves nothing to pick.
  const live = draws && editorUI.fxLiveStatus.state === 'live';
  const picker = useMemo(() => (live && probe && pick ? pick.createPicker(probe) : null), [live, probe, pick]);
  const tools = useMemo<CanvasPickTools | null>(
    () => (picker && pick ? { picker, pointerToNdc: pick.pointerToNdc, positionAfterDrag: pick.positionAfterDrag } : null),
    [picker, pick],
  );
  useCanvasPick({ editorUI, layerRef, tools });
  return (
    <>
      <DrawnLayer
        stored={stored}
        draws={draws}
        idle="calm"
        layoutSize
        projectId={editorUI.currentProject?.id}
        ownPosition={ownPosition}
        elementRef={layerRef}
        onProbe={setProbe}
        onStatus={
          draws
            ? (status) =>
                editorUI.reportFxLive(
                  status.state === 'live' ? { state: 'live' } : status.state === 'off' ? { state: 'off', reason: status.reason ?? 'renderer-error' } : { state: 'loading' },
                )
            : undefined
        }
      />
      {picker && <FxPickOutline editorUI={editorUI} layerRef={layerRef} boundsOf={picker.boundsOf} />}
    </>
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
    setDecision(fxStartDecision(settings));
  }, [settings.calm, settings.start, reduced]); // eslint-disable-line react-hooks/exhaustive-deps
  // The frame's one scene is its first, whether or not that one ends up drawn: as on the
  // published page, where the first box holds the page's slot even when it stays calm (reduced
  // motion) or off (no WebGL), and every later scene is calm. So the claim is asked for
  // whatever the decision, and only its holder may draw.
  const holds = useFxClaim(claim, decision !== null);
  useEffect(() => {
    if (holds && decision === 'off') console.warn(FX_WARNING, 'WebGL is not available.');
  }, [holds, decision]);
  return (
    <DrawnLayer
      // A new element for a new preference: the scene starts over, as the island runs its program again.
      key={reduced ? 'reduced' : 'motion'}
      stored={stored}
      draws={holds && decision === 'go'}
      idle={holds && decision === 'off' ? 'off' : 'calm'}
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

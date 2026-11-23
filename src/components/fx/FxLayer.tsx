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
import { FX_FADE_MS, FX_LAYER_STYLE, holdFxBox, reholdFxBox } from '@/lib/fxScene/box';
import { FxClaim } from '@/lib/fxScene/claim';
import { parseFxProp } from '@/lib/fxScene/fxScene';
import { FX_LAYER_ATTR, FX_PLACEHOLDER_ATTR, FX_STATE_ATTR, FX_STILL_ATTR, type FxState } from '@/lib/fxScene/marker';
import { breathe, FX_PLACEHOLDER_DELAY_MS, FX_PLACEHOLDER_STYLE } from '@/lib/fxScene/placeholder';
import { createStillQueue, LASTING_FAILURES, stillPixelRatio, whenBrowserIdle, type StillQueue } from '@/lib/fxScene/stillQueue';
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

/**
 * While `active`, the box holds the layer: a stacking context, and a position when it has none
 * (src/lib/fxScene/box.ts). Again whenever the box's own position changes, so a position the author sets
 * or takes away while the layer is there is respected. Shared by the live layer and the still frame; a
 * box shows one of them at a time, so two holds never overlap.
 */
function useFxBoxHold(layerRef: React.RefObject<HTMLDivElement | null>, active: boolean, ownPosition: unknown): void {
  const hasOwnPosition = isOwn(ownPosition);
  const latestPosition = useRef(ownPosition);
  useBeforePaint(() => {
    latestPosition.current = ownPosition;
  });
  const held = useRef<((positionIsOwned?: boolean) => void) | null>(null);
  const heldFor = useRef({ active, hasOwnPosition });
  useBeforePaint(() => {
    const box = layerRef.current?.parentElement;
    if (!active || !box) return;
    held.current = holdFxBox(box);
    return () => {
      held.current?.(isOwn(latestPosition.current));
      held.current = null;
    };
  }, [active]);
  // The box's own position set or taken away while the layer is there: the box's footing is taken again on
  // the new one (the renderer has already written it), for every hold on it.
  useBeforePaint(() => {
    const before = heldFor.current;
    heldFor.current = { active, hasOwnPosition };
    const box = layerRef.current?.parentElement;
    if (!active || !box || before.active !== active || before.hasOwnPosition === hasOwnPosition) return;
    reholdFxBox(box);
  }, [active, hasOwnPosition]);
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

  useFxBoxHold(layerRef, draws, ownPosition);

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
  }, [draws, idle, start, layoutSize, layerRef, onProbe]);

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
    let loaded: PickModule | null = null;
    loadPick()
      .then((module) => {
        loaded = module;
        if (!stopped) setPick(module);
      })
      .catch((error: unknown) => console.warn(FX_WARNING, 'Picking a layer on the canvas is not available.', error));
    return () => {
      stopped = true;
      // Picking ends with this layer (Live off, another frame, the editor closed): the scratch canvas the text
      // read-back keeps is not held for the rest of the tab. A later read makes a new one.
      loaded?.releaseScratch();
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

/** How long a changed scene or size waits before its still frame is drawn again: edits come in bursts. */
export const FX_STILL_DEBOUNCE_MS = 300;
/** A still frame that failed for a reason that may pass is tried again this often, this long after. */
const FX_STILL_RETRIES = 2;
/** How long a first size must hold before its picture is asked for. */
const FX_STILL_FIRST_MS = 120;
const FX_STILL_RETRY_MS = 1500;

/** One queue of still frames per editor (its store): one still context at a time, shared by every frame. */
const stillQueues = new WeakMap<object, StillQueue>();
function stillQueueOf(owner: object): StillQueue {
  let queue = stillQueues.get(owner);
  if (!queue) {
    queue = createStillQueue({
      // The engine by a dynamic import only, as for the live scene: fetched once the first still frame is wanted.
      render: (target, signal) =>
        import('@/lib/fxScene/mount')
          .then(({ renderFxStill }) => renderFxStill(target.host, target.stored, { pixelRatio: target.pixelRatio, signal, resolveImage: target.resolveImage }))
          .catch((reason: unknown) => {
            // Once per picture (a job is shared by every frame that asks for it). A refused scene is the panel's to
            // explain, and an aborted one was given up on purpose.
            if (reason !== 'aborted' && reason !== 'refused') console.warn(FX_WARNING, `A still frame of the scene could not be drawn. Reason: ${typeof reason === 'string' ? reason : 'engine'}.`);
            throw typeof reason === 'string' ? reason : 'engine';
          }),
      whenIdle: (run) => whenBrowserIdle(run),
    });
    stillQueues.set(owner, queue);
  }
  return queue;
}

/** A value that follows `value` once it has stayed the same for `ms`; the first value at once. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (Object.is(value, settled)) return;
    const timer = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, settled, ms]);
  return settled;
}

type StillState = 'waiting' | 'loading' | 'live' | 'off';

/**
 * On the canvas, in every breakpoint frame an FX scene box is NOT drawn live in: one still frame of its
 * scene at this frame's own size (the frame a visitor who asks for reduced motion sees), so every breakpoint
 * shows the scene at once while only one of them runs a live WebGL context. The pictures are made one at a
 * time in idle time by the editor's still queue (src/lib/fxScene/stillQueue.ts), and only for a box that is
 * on or near the screen: a box that is never shown costs nothing. Made again when the scene or the box's
 * size has settled after a change; the old picture stays until the new one is there. When it cannot be
 * made (no WebGL, a refused scene), the box shows its own background, as on the published page.
 */
export const FxStillLayer = observer(function FxStillLayer({ stored, ownPosition, covered = false }: FxLayerProps & { covered?: boolean }) {
  const { editorUI } = useStore();
  const layerRef = useRef<HTMLDivElement>(null);
  const pictureRef = useRef<HTMLCanvasElement>(null);
  const placeholderRef = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [state, setState] = useState<StillState>('waiting');
  const [hasPicture, setHasPicture] = useState(false);
  const [slow, setSlow] = useState(false);
  const reduce = useReducedMotion();
  const projectId = editorUI.currentProject?.id;

  // Under the live scene of this frame: kept until the live one has faded in over it (no dip in between),
  // then hidden and no longer asked for. Shown again at once when the live scene goes.
  const [hiddenUnder, setHiddenUnder] = useState(covered);
  useEffect(() => {
    if (!covered) {
      setHiddenUnder(false);
      return;
    }
    const timer = window.setTimeout(() => setHiddenUnder(true), FX_FADE_MS);
    return () => window.clearTimeout(timer);
  }, [covered]);


  // Only for a box on or near the screen (half a screen around it), and from then on while it is mounted.
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer || near) return;
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setNear(true);
    }, { rootMargin: '50%' });
    observer.observe(layer);
    return () => observer.disconnect();
  }, [near]);

  // The layer's layout size (the box's, untouched by the canvas zoom), followed.
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const measure = () => {
      const width = layer.offsetWidth;
      const height = layer.offsetHeight;
      setSize((prev) => (prev && prev.width === width && prev.height === height ? prev : { width, height }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(layer);
    return () => observer.disconnect();
  }, []);

  const read = parseFxProp(stored);
  const scene = read.ok ? read.fx.scene : null;
  // Once per change of the stored scene, not on every render of every frame.
  const sceneJson = useMemo(() => (scene ? JSON.stringify(scene) : ''), [stored]); // eslint-disable-line react-hooks/exhaustive-deps
  // A failure that may pass (a lost context, a box out of the page for a moment) is tried again, twice, a moment later.
  const [attempt, setAttempt] = useState(0);
  const wanted = !hiddenUnder && near && size && size.width > 0 && size.height > 0 && scene ? `${size.width}x${size.height}|${projectId ?? ''}|${sceneJson}` : '';
  // The first picture waits a moment for the layout to settle (a frame measured before its breakpoint is laid
  // out has another size a moment later, measured: 1280 x 800 then 1280 x 240); a change waits until the edits settle.
  const settledWanted = useSettled(wanted, hasPicture ? FX_STILL_DEBOUNCE_MS : FX_STILL_FIRST_MS);
  const latestStored = useRef(stored);
  useBeforePaint(() => {
    latestStored.current = stored;
  });

  const clearPicture = () => {
    const picture = pictureRef.current;
    if (picture) picture.width = picture.height = 0;
    setHasPicture(false);
  };

  useEffect(() => {
    if (!read.ok && stored !== undefined) {
      // A scene the reader refuses is drawn nowhere: the box's own background.
      setState('off');
      clearPicture();
      return;
    }
    if (!settledWanted || !size || !scene) return;
    const pixelRatio = stillPixelRatio(size.width, size.height, scene.dpr[1], window.devicePixelRatio || 1);
    const key = `${pixelRatio}|${settledWanted}`;
    // The old picture stays shown until the new one is there.
    setState((prev) => (prev === 'live' ? prev : 'loading'));
    const leave = stillQueueOf(editorUI).request(
      key,
      () => {
        const layer = layerRef.current;
        if (!layer || !layer.isConnected) return null;
        return {
          host: layer,
          stored: latestStored.current,
          pixelRatio,
          resolveImage: (src: string) => (projectId ? editorSiteImageUrl(projectId, src) : null),
        };
      },
      (outcome) => {
        const picture = pictureRef.current;
        if (!picture) return;
        if (!outcome.ok) {
          // The box's own background, as on the published page (warned once per picture, above).
          clearPicture();
          setState('off');
          if (!LASTING_FAILURES.has(outcome.reason) && attempt < FX_STILL_RETRIES) window.setTimeout(() => setAttempt((n) => n + 1), FX_STILL_RETRY_MS);
          return;
        }
        picture.width = outcome.picture.width;
        picture.height = outcome.picture.height;
        picture.getContext('2d')?.drawImage(outcome.picture, 0, 0);
        setHasPicture(true);
        setState('live');
      },
    );
    return leave;
    // `read`, `scene` and `size` are captured through `settledWanted`, which is keyed on all of them.
  }, [settledWanted, editorUI, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  // A new scene or size starts the retries over.
  useEffect(() => setAttempt(0), [settledWanted]);

  // The box holds the layer only while it shows something here (a picture, or the placeholder on the way to
  // one): a frame that is off screen, covered by the live scene or has nothing to show leaves the box as it is.
  useFxBoxHold(layerRef, near && !hiddenUnder && state !== 'off', ownPosition);

  // A first picture that takes a noticeable moment shows the loading placeholder meanwhile (src/lib/fxScene/placeholder.ts).
  // Only for a box on or near the screen, which is the only one asking: an off-screen frame shows nothing at all.
  const waiting = near && state !== 'off' && !hasPicture && !hiddenUnder;
  useEffect(() => {
    if (!waiting) {
      setSlow(false);
      return;
    }
    const timer = window.setTimeout(() => setSlow(true), FX_PLACEHOLDER_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [waiting]);
  const placeholderShown = waiting && slow;
  useEffect(() => {
    const element = placeholderRef.current;
    if (!placeholderShown || !element) return;
    return breathe(element, reduce);
  }, [placeholderShown, reduce]);

  return (
    <div ref={layerRef} aria-hidden="true" {...{ [FX_STILL_ATTR]: state }} style={{ ...LAYER_STYLE, opacity: hiddenUnder ? 0 : 1 }}>
      <div ref={placeholderRef} {...{ [FX_PLACEHOLDER_ATTR]: placeholderShown ? 'shown' : 'hidden' }} style={{ ...FX_PLACEHOLDER_STYLE, zIndex: 0, opacity: placeholderShown ? 1 : 0 }} />
      <canvas
        ref={pictureRef}
        width={0}
        height={0}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', opacity: hasPicture ? 1 : 0, transition: `opacity ${FX_FADE_MS}ms ease-out` }}
      />
    </div>
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

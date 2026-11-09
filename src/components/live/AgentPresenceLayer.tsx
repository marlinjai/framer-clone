// src/components/live/AgentPresenceLayer.tsx
//
// Where an agent works, on the canvas (plan docs/plans/2026-11-08-live-agent-canvas.md,
// section 2): for each agent of the presence store (src/lib/live/presenceStore.ts)
// a 2px frame in the agent presence blue (`--agent-presence`), 2px outside the
// SECTION it works on (src/lib/live/presenceTarget.ts), or around the page's
// frames when the call names a page and no node, with a label pill at the
// frame's top left ("Claude · Editing"), moved into the visible canvas when that
// corner is under a docked sidebar or the top bar (pillPlacement). Drawn in
// every breakpoint frame the section shows in; the pill on the first.
//
// Positioned like the selection (HudSurface): a fixed layer under the
// selection's, updated by direct DOM writes on every camera move, so pan and
// zoom re-render nothing and the frame never lags the canvas. Motion (Emil
// Kowalski's rules): the frame moves to a new section with a 200ms ease-out,
// and only then (during pan and zoom it follows at once); it fades out with a
// 200ms ease-out when the store hides it (4s after the agent's last call, at
// once after a refusal or failure). Under reduced motion it jumps and
// disappears without fading.
//
// Purely visual: pointer events off, hidden from assistive technology (the
// activity feed and the top bar's note speak for it). The pill's text is plain
// text (labels are server-written and capped).
//
// AgentCameraFollow (mounted beside it) keeps the lead agent's frame in view
// while the person has not moved the camera since the agent's activity began;
// the feed's Follow toggle turns it back on.
'use client';

import React from 'react';
import { autorun } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';
import { useInteracting } from '@/hooks/useInteracting';
import { onPersonTookOver } from '@/lib/live/editingInProgress';
import { useTransformContext } from '@/contexts/TransformContext';
import { revealOffset, useCameraControls, type CameraTransform } from '@/lib/canvas/cameraControls';
import { presencePagesOf, presenceTarget, type PresenceProject, type PresenceTarget } from '@/lib/live/presenceTarget';
import { presenceLabel } from '@/lib/live/activityText';
import type { AgentPresence, LivePresenceStore } from '@/lib/live/presenceStore';
import type { LivePlansStore } from '@/lib/live/plansStore';
import { SKELETON_ATTR, skeletonKey } from '@/components/live/SkeletonLayer';
import { REVEAL_KEYFRAMES } from '@/lib/live/reveal';

/** The frame's border width and its gap to the element, in screen pixels. */
export const PRESENCE_FRAME_WIDTH = 2;
export const PRESENCE_FRAME_GAP = 2;
/** The move to a new section and the fade, in milliseconds (under 300, ease-out). */
export const PRESENCE_MOVE_MS = 200;
export const PRESENCE_FADE_MS = 200;

export const PRESENCE_FRAME_ATTR = 'data-agent-presence-frame';
export const PRESENCE_LABEL_ATTR = 'data-agent-presence-label';

/** Whether the person asked for reduced motion. */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** A stable key of a target (the move animates only when it changes). */
export function targetKey(target: PresenceTarget | undefined): string {
  if (!target) return '';
  if (target.kind === 'skeleton') return `skeleton:${target.pageId}:${target.skeleton}`;
  return target.kind === 'section' ? `section:${target.pageId}:${target.sectionId}` : `page:${target.pageId}`;
}

/** The canvas elements a target is drawn around, in document order. */
export function targetElements(target: PresenceTarget, root: ParentNode = document): HTMLElement[] {
  if (target.kind === 'page') return Array.from(root.querySelectorAll<HTMLElement>('[data-camera-transform] [data-viewport-id]'));
  const id = target.kind === 'skeleton' ? target.skeleton : target.sectionId;
  const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(id) : id.replace(/"/g, '\\"');
  const attr = target.kind === 'skeleton' ? SKELETON_ATTR : 'data-inner-component-id';
  return Array.from(root.querySelectorAll<HTMLElement>(`[data-camera-transform] [${attr}="${escaped}"]`));
}

/** The frame's box around an element's screen rect: PRESENCE_FRAME_GAP outside it, border included. */
export function frameBox(rect: { left: number; top: number; width: number; height: number }): { x: number; y: number; width: number; height: number } {
  const out = PRESENCE_FRAME_GAP + PRESENCE_FRAME_WIDTH;
  return { x: rect.left - out, y: rect.top - out, width: rect.width + 2 * out, height: rect.height + 2 * out };
}

/** The pill's default place: just above the frame's top left corner, in pixels from the frame's box. */
export const PRESENCE_PILL_OFFSET = { left: -2, top: -22 };
/** The least space between the pill and the edge of the visible canvas. */
export const PRESENCE_PILL_INSET = 8;
/** Marks the editor chrome that covers the canvas at an edge: `left` and `right` (the docked sidebars), `bottom` (the toolbar). */
export const EDITOR_CHROME_ATTR = 'data-editor-chrome';

export interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * The part of the canvas the person sees: the window, less the top bar, the
 * docked sidebars and the bottom toolbar, which cover the canvas (it runs under
 * them). On a phone there is no docked chrome, so only the top bar counts.
 */
export function visibleCanvasRect(root: ParentNode = document): ScreenRect {
  const view: ScreenRect = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  const ground = root.querySelector<HTMLElement>('[data-ground]');
  if (ground) {
    const g = ground.getBoundingClientRect();
    if (g.width > 0 && g.height > 0) Object.assign(view, { left: g.left, top: g.top, right: g.right, bottom: g.bottom });
  }
  const topbar = root.querySelector<HTMLElement>('[data-editor-topbar]')?.getBoundingClientRect();
  if (topbar && topbar.height > 0) view.top = Math.max(view.top, topbar.bottom);
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(`[${EDITOR_CHROME_ATTR}]`))) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const edge = el.getAttribute(EDITOR_CHROME_ATTR);
    if (edge === 'right') view.right = Math.min(view.right, r.left);
    else if (edge === 'bottom') view.bottom = Math.min(view.bottom, r.top);
    else if (edge === 'left') view.left = Math.max(view.left, r.right);
  }
  return view;
}

/**
 * Where the label pill goes, in pixels from the frame's box: above its top left
 * corner, moved into the visible canvas when that corner is under a sidebar or
 * the top bar (or off screen), so the pill stays readable while any part of the
 * frame shows. Inside the frame's top edge when there is no room above it.
 * Undefined when no part of the frame is visible: the pill is then hidden with it.
 */
export function pillPlacement(
  box: { x: number; y: number; width: number; height: number },
  visible: ScreenRect,
  pill: { width: number; height: number },
): { left: number; top: number } | undefined {
  const right = box.x + box.width;
  const bottom = box.y + box.height;
  if (right <= visible.left || box.x >= visible.right || bottom <= visible.top || box.y >= visible.bottom) return undefined;
  const minX = visible.left + PRESENCE_PILL_INSET;
  // Never further right than where the pill still ends inside the frame (a thin sliver of a frame keeps its pill at its edge).
  const maxX = Math.max(minX, Math.min(visible.right - PRESENCE_PILL_INSET - pill.width, right - pill.width));
  const minY = visible.top + PRESENCE_PILL_INSET;
  const maxY = Math.max(minY, visible.bottom - PRESENCE_PILL_INSET - pill.height);
  let x = box.x + PRESENCE_PILL_OFFSET.left;
  let y = box.y + PRESENCE_PILL_OFFSET.top;
  // No room above the frame (its top under the top bar, or scrolled past): just inside it.
  if (y < minY) y = Math.max(box.y + PRESENCE_FRAME_WIDTH + 4, minY);
  x = Math.min(Math.max(x, minX), maxX);
  y = Math.min(Math.max(y, minY), maxY);
  return { left: Math.round(x - box.x), top: Math.round(y - box.y) };
}

/** Each framed agent's target on the page on screen; agents working elsewhere (or on nodes that are gone) have none. */
export function useAgentTargets(): Array<{ agent: AgentPresence; target: PresenceTarget | undefined }> {
  const { editorUI } = useStore();
  const presence = editorUI.livePresence as LivePresenceStore | undefined;
  const plans = editorUI.livePlans as LivePlansStore | undefined;
  const project = editorUI.currentProject;
  const pageId = editorUI.currentPage?.id;
  if (!presence) return [];
  const pages = presencePagesOf(project as unknown as PresenceProject | undefined);
  return presence.active.map((agent) => {
    // Writing an announced section whose skeleton is still drawn here: the frame goes on that skeleton.
    const filling = plans?.skeletonOf(agent.agentId, agent.focus.sectionRef);
    if (filling && pageId && (filling.plan.pageId === pageId || plans?.inGhostFrame(filling.plan))) {
      const target: PresenceTarget = { kind: 'skeleton', pageId, skeleton: skeletonKey(filling.plan.agentId, filling.section.ref), title: filling.section.title };
      return { agent, target };
    }
    const target = presenceTarget(pages, agent.focus);
    return { agent, target: target && target.pageId === pageId ? target : undefined };
  });
}

interface DrawnAgent {
  agentId: string;
  key: string;
  shown: boolean;
  label: string;
  target: PresenceTarget | undefined;
}

const AgentPresenceLayer = observer(function AgentPresenceLayer() {
  const { subscribe } = useTransformContext();
  const targets = useAgentTargets();
  const containerRef = React.useRef<HTMLDivElement>(null);
  // What is drawn now, read by the imperative updates.
  const drawn = React.useRef<DrawnAgent[]>([]);
  // Per agent: the target key last drawn, and until when the move animates.
  const moves = React.useRef(new Map<string, { key: string; until: number }>());
  // Watches the size of the elements drawn around (an adoption may replace them with new ones).
  const resizes = React.useRef<{ observer: ResizeObserver; watched: Set<Element> } | null>(null);
  // Watches the canvas for layout changes the elements' own sizes do not show (a section above grew,
  // a framed element was replaced), and the canvas root it watches.
  const layout = React.useRef<{ observer: MutationObserver; root: Element | null } | null>(null);

  const next: DrawnAgent[] = targets.map(({ agent, target }) => ({
    agentId: agent.agentId,
    key: targetKey(target),
    shown: agent.frameShown,
    label: presenceLabel(agent.label, agent.focus.tool, target?.kind === 'skeleton' ? target.title : undefined),
    target,
  }));
  const signature = next.map((d) => `${d.agentId}|${d.key}|${d.shown ? 1 : 0}|${d.label}`).join('\n');

  // `immediate`: a camera move or resize. The frame tracks the canvas at once, whatever section move is under way.
  const update = React.useCallback((immediate = false) => {
    const container = containerRef.current;
    if (!container) return;
    const reduced = prefersReducedMotion();
    const now = Date.now();
    const visible = visibleCanvasRect();
    const keep = new Set<Element>();
    const measured = new Set<Element>();
    for (const agent of drawn.current) {
      if (!agent.target) continue;
      const elements = targetElements(agent.target);
      for (const element of elements) measured.add(element);
      const move = moves.current.get(agent.agentId);
      // The pill goes on the first frame that shows in the visible canvas (the
      // first breakpoint may be scrolled out of it), else on the first.
      const pillIndex = Math.max(
        0,
        elements.findIndex((el) => {
          const r = el.getBoundingClientRect();
          return (r.width > 0 || r.height > 0) && !!pillPlacement(frameBox(r), visible, { width: 0, height: 0 });
        }),
      );
      const moving = !immediate && !reduced && !!move && move.until > now;
      elements.forEach((element, index) => {
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;
        const id = `${agent.agentId}:${index}`;
        let frame = container.querySelector<HTMLDivElement>(`[${PRESENCE_FRAME_ATTR}="${CSS.escape(id)}"]`);
        if (!frame) {
          frame = document.createElement('div');
          frame.setAttribute(PRESENCE_FRAME_ATTR, id);
          frame.className = 'absolute left-0 top-0 rounded-[3px] border-2 border-agent-presence';
          frame.style.pointerEvents = 'none';
          frame.style.opacity = '0';
          container.appendChild(frame);
        }
        keep.add(frame);
        const box = frameBox(rect);
        const transitions = [] as string[];
        if (moving) transitions.push(`transform ${PRESENCE_MOVE_MS}ms ease-out`, `width ${PRESENCE_MOVE_MS}ms ease-out`, `height ${PRESENCE_MOVE_MS}ms ease-out`);
        if (!reduced) transitions.push(`opacity ${PRESENCE_FADE_MS}ms ease-out`);
        frame.style.transition = transitions.join(', ');
        frame.style.transform = `translate(${box.x}px, ${box.y}px)`;
        frame.style.width = `${box.width}px`;
        frame.style.height = `${box.height}px`;
        frame.style.opacity = agent.shown ? '1' : '0';
        let pill = frame.querySelector<HTMLDivElement>(`[${PRESENCE_LABEL_ATTR}]`);
        if (index === pillIndex) {
          if (!pill) {
            pill = document.createElement('div');
            pill.setAttribute(PRESENCE_LABEL_ATTR, '');
            pill.className =
              'absolute left-0 top-0 max-w-[240px] truncate whitespace-nowrap rounded-[4px] bg-agent-presence px-1.5 py-0.5 text-[11px] font-medium leading-4 text-agent-presence-foreground shadow-sm';
            frame.appendChild(pill);
          }
          // Plain text only.
          if (pill.textContent !== agent.label) pill.textContent = agent.label;
          // Never wider than the visible canvas (it would run under a sidebar).
          pill.style.maxWidth = `${Math.max(0, Math.min(240, visible.right - visible.left - 2 * PRESENCE_PILL_INSET))}px`;
          // Inside the visible canvas, never under a sidebar or the top bar.
          const size = pill.getBoundingClientRect();
          const place = pillPlacement(box, visible, { width: size.width, height: size.height || 20 });
          pill.style.visibility = place ? '' : 'hidden';
          pill.style.transform = place ? `translate(${place.left}px, ${place.top}px)` : '';
        } else if (pill) {
          pill.remove();
        }
      });
    }
    for (const child of Array.from(container.children)) if (!keep.has(child)) child.remove();
    // A sidebar resized or collapsed (or the toolbar) changes the visible canvas: the pill moves with it.
    if (keep.size > 0) for (const el of Array.from(document.querySelectorAll(`[${EDITOR_CHROME_ATTR}]`))) measured.add(el);
    // The canvas may have mounted after the layer: watch whichever root is there now.
    const watch = layout.current;
    const root = document.querySelector('[data-camera-transform]');
    if (watch && root !== watch.root) {
      watch.observer.disconnect();
      watch.root = root;
      if (root) watch.observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
    }
    // Follow the elements drawn now: watch new ones, let go of ones that left the page.
    const resize = resizes.current;
    if (resize) {
      for (const element of measured) if (!resize.watched.has(element)) resize.observer.observe(element);
      for (const element of resize.watched) if (!measured.has(element)) resize.observer.unobserve(element);
      resize.watched = measured;
    }
  }, []);

  // A new picture from the store: note which agents moved, then draw.
  React.useLayoutEffect(() => {
    const now = Date.now();
    for (const agent of next) {
      const prev = moves.current.get(agent.agentId);
      if (!agent.key) {
        moves.current.delete(agent.agentId);
        continue;
      }
      if (!prev) moves.current.set(agent.agentId, { key: agent.key, until: 0 });
      else if (prev.key !== agent.key) moves.current.set(agent.agentId, { key: agent.key, until: now + PRESENCE_MOVE_MS });
    }
    for (const id of [...moves.current.keys()]) if (!next.some((a) => a.agentId === id)) moves.current.delete(id);
    drawn.current = next;
    update();
    // The adopted copy may still be laying out: measure once more on the next frame.
    const raf = requestAnimationFrame(() => update());
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, update]);

  // A node that just revealed (src/lib/live/reveal.ts) rose 4px into place: the
  // frame was measured at its start position, so it measures again.
  React.useEffect(() => {
    const onEnd = (e: AnimationEvent) => {
      if (e.animationName === REVEAL_KEYFRAMES) update(true);
    };
    document.addEventListener('animationend', onEnd);
    document.addEventListener('animationcancel', onEnd);
    return () => {
      document.removeEventListener('animationend', onEnd);
      document.removeEventListener('animationcancel', onEnd);
    };
  }, [update]);

  // Camera moves (pan, zoom) and window resizes: redraw at once, without the move transition.
  React.useEffect(() => subscribe(() => update(true)), [subscribe, update]);
  React.useEffect(() => {
    const onResize = () => update(true);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [update]);
  // The section's own size changes (an adoption, the person's edit): redraw. The
  // elements watched are kept current by every draw.
  React.useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => update());
    resizes.current = { observer, watched: new Set() };
    update();
    return () => {
      observer.disconnect();
      resizes.current = null;
    };
  }, [update]);

  // Any change inside the canvas (a section above the framed one grows, the framed element is replaced)
  // redraws, once per frame. The layer's own writes are outside the canvas and never trigger it.
  React.useEffect(() => {
    if (typeof MutationObserver === 'undefined') return;
    let raf = 0;
    const observer = new MutationObserver(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        update();
      });
    });
    layout.current = { observer, root: null };
    update();
    return () => {
      if (raf) cancelAnimationFrame(raf);
      observer.disconnect();
      layout.current = null;
    };
  }, [update]);

  // Chrome that mounts or unmounts (the phone bar appears, the toolbar leaves) changes the visible canvas.
  React.useEffect(() => {
    if (typeof MutationObserver === 'undefined') return;
    const isChrome = (node: Node) =>
      node instanceof Element && (node.hasAttribute(EDITOR_CHROME_ATTR) || !!node.querySelector(`[${EDITOR_CHROME_ATTR}]`));
    const observer = new MutationObserver((mutations) => {
      if (mutations.some((m) => Array.from(m.addedNodes).some(isChrome) || Array.from(m.removedNodes).some(isChrome))) update(true);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [update]);

  return <div ref={containerRef} aria-hidden="true" className="pointer-events-none fixed inset-0" style={{ zIndex: 9 }} data-agent-presence-layer="" />;
});

AgentPresenceLayer.displayName = 'AgentPresenceLayer';
export default AgentPresenceLayer;

/** Whether two camera positions are the same (a pan or zoom by the person changes one). */
function sameCamera(a: CameraTransform, b: CameraTransform): boolean {
  return Math.abs(a.zoom - b.zoom) < 1e-6 && Math.abs(a.panX - b.panX) < 0.5 && Math.abs(a.panY - b.panY) < 0.5;
}

/**
 * Brings the lead agent's frame into view when it moves, while the person has
 * not moved the camera since the agent's activity began (or since they turned
 * Follow back on). Waits while the person drags, resizes, draws a marquee, edits
 * text or has the focus in a field, and catches up once they stop; selecting
 * something else or starting a text edit turns Follow off, as moving the camera
 * does (src/lib/live/editingInProgress.ts). Renders nothing.
 */
export const AgentCameraFollow = observer(function AgentCameraFollow() {
  const rootStore = useStore();
  const { editorUI } = rootStore;
  const interacting = useInteracting(rootStore);
  const presence = editorUI.livePresence as LivePresenceStore | undefined;
  const { read, panBy } = useCameraControls();
  const { subscribe } = useTransformContext();
  const targets = useAgentTargets();
  const lead = targets.find((t) => t.agent.agentId === presence?.leadAgentId);
  const key = lead?.agent.frameShown ? targetKey(lead.target) : '';
  // Where this follower last left the camera, or where the camera stood when the run began (or
  // Follow came back on): the baseline the person's moves are measured against, even before the
  // agent's first target resolves (it may start on another page).
  const last = React.useRef<CameraTransform | undefined>(undefined);
  const readRef = React.useRef(read);
  readRef.current = read;

  // A new run, or Follow turned back on: from here on the person's moves count.
  React.useEffect(
    () =>
      autorun(() => {
        // Read both, so either change starts over.
        const run = presence?.run;
        if (presence?.follow && run !== undefined) last.current = readRef.current();
      }),
    [presence],
  );

  // The person took over (another selection, a text edit): the camera is theirs.
  React.useEffect(() => {
    if (!presence) return;
    return onPersonTookOver(rootStore, () => {
      if (presence.follow) presence.setFollow(false);
    });
  }, [presence, rootStore]);

  // Before any target resolves, a move by the person is still noticed.
  React.useEffect(() => {
    if (!presence?.follow || lead?.target) return;
    const watch = () => {
      if (last.current && presence.follow && !sameCamera(last.current, readRef.current())) presence.setFollow(false);
    };
    return subscribe(watch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presence, presence?.follow, !!lead?.target, subscribe]);

  React.useEffect(() => {
    // While the person works, the camera stays put; this runs again once they stop.
    if (!presence || !key || !lead?.target || !presence.follow || interacting) return;
    const now = read();
    if (last.current && !sameCamera(last.current, now)) {
      // The person moved the camera since the frame last moved: leave it to them.
      presence.setFollow(false);
      return;
    }
    const raf = requestAnimationFrame(() => {
      const element = targetElements(lead.target!)[0];
      const ground = document.querySelector<HTMLElement>('[data-ground]');
      if (!element || !ground) return;
      const box = element.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) return;
      const visible = ground.getBoundingClientRect();
      // A section taller than the screen: its top is what matters.
      const top = { left: box.left, right: box.right, top: box.top, bottom: Math.min(box.bottom, box.top + visible.height - 96) };
      const { dx, dy } = revealOffset(top, visible, 48);
      if (dx !== 0 || dy !== 0) panBy(dx, dy);
      last.current = read();
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, presence?.follow, interacting]);

  return null;
});

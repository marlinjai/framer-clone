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
  // Reads and writes are batched (perf review P5): every rect is read first, then the frames are written,
  // then the pills are measured in one go and placed. Two layouts per draw, not one per element.
  const update = React.useCallback((immediate = false) => {
    const container = containerRef.current;
    if (!container) return;
    const reduced = prefersReducedMotion();
    const now = Date.now();

    // 1. Read: the visible canvas and every element's rect.
    const visible = visibleCanvasRect();
    const measured = new Set<Element>();
    const plan: Array<{ agent: DrawnAgent; id: string; box: ReturnType<typeof frameBox>; pill: boolean; moving: boolean }> = [];
    for (const agent of drawn.current) {
      if (!agent.target) continue;
      const elements = targetElements(agent.target);
      const rects = elements.map((element) => {
        measured.add(element);
        return element.getBoundingClientRect();
      });
      // The pill goes on the first frame that shows in the visible canvas (the
      // first breakpoint may be scrolled out of it), else on the first.
      const pillIndex = Math.max(
        0,
        rects.findIndex((r) => (r.width > 0 || r.height > 0) && !!pillPlacement(frameBox(r), visible, { width: 0, height: 0 })),
      );
      const move = moves.current.get(agent.agentId);
      const moving = !immediate && !reduced && !!move && move.until > now;
      rects.forEach((rect, index) => {
        if (rect.width === 0 && rect.height === 0) return;
        plan.push({ agent, id: `${agent.agentId}:${index}`, box: frameBox(rect), pill: index === pillIndex, moving });
      });
    }
    // A sidebar resized or collapsed (or the toolbar) changes the visible canvas: the pill moves with it.
    const chrome = plan.length > 0 ? Array.from(document.querySelectorAll(`[${EDITOR_CHROME_ATTR}]`)) : [];
    const root = document.querySelector('[data-camera-transform]');

    // 2. Write: the frames, and each pill's text and width (no reads in between).
    const pillWidth = `${Math.max(0, Math.min(240, visible.right - visible.left - 2 * PRESENCE_PILL_INSET))}px`;
    const keep = new Set<Element>();
    const pills: Array<{ pill: HTMLDivElement; box: ReturnType<typeof frameBox> }> = [];
    for (const item of plan) {
      let frame = container.querySelector<HTMLDivElement>(`[${PRESENCE_FRAME_ATTR}="${CSS.escape(item.id)}"]`);
      if (!frame) {
        frame = document.createElement('div');
        frame.setAttribute(PRESENCE_FRAME_ATTR, item.id);
        frame.className = 'absolute left-0 top-0 rounded-[3px] border-2 border-agent-presence';
        frame.style.pointerEvents = 'none';
        frame.style.opacity = '0';
        container.appendChild(frame);
      }
      keep.add(frame);
      const transitions = [] as string[];
      if (item.moving) transitions.push(`transform ${PRESENCE_MOVE_MS}ms ease-out`, `width ${PRESENCE_MOVE_MS}ms ease-out`, `height ${PRESENCE_MOVE_MS}ms ease-out`);
      if (!reduced) transitions.push(`opacity ${PRESENCE_FADE_MS}ms ease-out`);
      frame.style.transition = transitions.join(', ');
      frame.style.transform = `translate(${item.box.x}px, ${item.box.y}px)`;
      frame.style.width = `${item.box.width}px`;
      frame.style.height = `${item.box.height}px`;
      frame.style.opacity = item.agent.shown ? '1' : '0';
      let pill = frame.querySelector<HTMLDivElement>(`[${PRESENCE_LABEL_ATTR}]`);
      if (item.pill) {
        if (!pill) {
          pill = document.createElement('div');
          pill.setAttribute(PRESENCE_LABEL_ATTR, '');
          pill.className =
            'absolute left-0 top-0 max-w-[240px] truncate whitespace-nowrap rounded-[4px] bg-agent-presence px-1.5 py-0.5 text-[11px] font-medium leading-4 text-agent-presence-foreground shadow-sm';
          frame.appendChild(pill);
        }
        // Plain text only.
        if (pill.textContent !== item.agent.label) pill.textContent = item.agent.label;
        // Never wider than the visible canvas (it would run under a sidebar).
        pill.style.maxWidth = pillWidth;
        pills.push({ pill, box: item.box });
      } else if (pill) {
        pill.remove();
      }
    }
    for (const child of Array.from(container.children)) if (!keep.has(child)) child.remove();

    // 3. Read: every pill's size, in one layout.
    const sizes = pills.map(({ pill }) => pill.getBoundingClientRect());

    // 4. Write: each pill inside the visible canvas, never under a sidebar or the top bar.
    pills.forEach(({ pill, box }, i) => {
      const place = pillPlacement(box, visible, { width: sizes[i].width, height: sizes[i].height || 20 });
      pill.style.visibility = place ? '' : 'hidden';
      pill.style.transform = place ? `translate(${place.left}px, ${place.top}px)` : '';
    });

    for (const el of chrome) measured.add(el);
    // The canvas may have mounted after the layer: watch whichever root is there now.
    const watch = layout.current;
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

  // Redraws asked for by observers and events, coalesced into one per frame. `immediate` sticks if
  // any of the coalesced asks wanted it (a reveal that ended during a section move skips the move).
  const pending = React.useRef<{ raf: number; immediate: boolean }>({ raf: 0, immediate: false });
  const schedule = React.useCallback(
    (immediate = false) => {
      const ask = pending.current;
      ask.immediate ||= immediate;
      if (ask.raf) return;
      ask.raf = requestAnimationFrame(() => {
        const now = ask.immediate;
        ask.raf = 0;
        ask.immediate = false;
        update(now);
      });
    },
    [update],
  );
  React.useEffect(
    () => () => {
      if (pending.current.raf) cancelAnimationFrame(pending.current.raf);
      pending.current = { raf: 0, immediate: false };
    },
    [],
  );

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
    schedule();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, update, schedule]);

  // A node that just revealed (src/lib/live/reveal.ts) rose 4px into place: the
  // frame was measured at its start position, so it measures again.
  React.useEffect(() => {
    const onEnd = (e: AnimationEvent) => {
      // Many nodes reveal at once: one redraw for all of them.
      if (e.animationName === REVEAL_KEYFRAMES) schedule(true);
    };
    document.addEventListener('animationend', onEnd);
    document.addEventListener('animationcancel', onEnd);
    return () => {
      document.removeEventListener('animationend', onEnd);
      document.removeEventListener('animationcancel', onEnd);
    };
  }, [schedule]);

  // Camera moves (pan, zoom) and window resizes: redraw at once, without the move transition.
  React.useEffect(() => subscribe(() => update(true)), [subscribe, update]);
  React.useEffect(() => {
    const onResize = () => schedule(true);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [schedule]);
  // The section's own size changes (an adoption, the person's edit): redraw. The
  // elements watched are kept current by every draw.
  React.useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => schedule());
    resizes.current = { observer, watched: new Set() };
    update();
    return () => {
      observer.disconnect();
      resizes.current = null;
    };
  }, [update, schedule]);

  // Any change inside the canvas (a section above the framed one grows, the framed element is replaced)
  // redraws, once per frame. The layer's own writes are outside the canvas and never trigger it.
  React.useEffect(() => {
    if (typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(() => schedule());
    layout.current = { observer, root: null };
    update();
    return () => {
      observer.disconnect();
      layout.current = null;
    };
  }, [update, schedule]);

  // Chrome that mounts or unmounts (the phone bar appears, the toolbar leaves) changes the visible canvas.
  React.useEffect(() => {
    if (typeof MutationObserver === 'undefined') return;
    // Text nodes and leaf elements are filtered out before any query (the body changes often).
    const isChrome = (node: Node) =>
      node instanceof Element &&
      (node.hasAttribute(EDITOR_CHROME_ATTR) || (node.childElementCount > 0 && !!node.querySelector(`[${EDITOR_CHROME_ATTR}]`)));
    const touchesChrome = (nodes: NodeList) => {
      for (let i = 0; i < nodes.length; i += 1) if (isChrome(nodes[i])) return true;
      return false;
    };
    const observer = new MutationObserver((mutations) => {
      if (mutations.some((m) => touchesChrome(m.addedNodes) || touchesChrome(m.removedNodes))) schedule(true);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [schedule]);

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
 * Follow back on). Renders nothing.
 */
export const AgentCameraFollow = observer(function AgentCameraFollow() {
  const { editorUI } = useStore();
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
    if (!presence || !key || !lead?.target || !presence.follow) return;
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
  }, [key, presence?.follow]);

  return null;
});

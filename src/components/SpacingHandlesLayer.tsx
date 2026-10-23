// src/components/SpacingHandlesLayer.tsx
//
// On-canvas spacing handles (Framer / Figma style) for the selected component:
// tinted, hatched bands for its padding (inside), margin (outside) and, for a
// flex or grid container, the gaps between its children, each with a short
// bar to drag. A small pill shows the value while a band or handle is
// hovered and during a drag.
//
// Behaviour (value rules live in src/lib/canvas/spacingDrag.ts):
// - Shown for exactly one selected component while the pointer is over it
//   (its margin box, plus room for the handles) or a drag is running. Hidden
//   with another tool, during a node drag, a resize, inline text editing, a
//   multi-selection, on a locked node, and while any press that did not start
//   on a spacing handle is held (canvas pan, marquee, resize and radius
//   handles, node presses), since those live in Canvas and HudSurface.
// - Drag: whole px, Shift snaps to 8px, Alt/Option at press mirrors onto the
//   opposite side. Escape cancels and restores exactly; the whole drag is one
//   undo step. Losing window focus or a cancelled pointer ends the drag and
//   keeps what was dragged.
// - Margins are shown for components inside a page tree that have a parent
//   (not the page root, not floating elements). A margin side authored as
//   `auto` (centring) gets no band or handle.
//
// Painted with direct DOM writes on camera changes, like HudSurface, so pan
// and zoom never re-render React. Mounted next to HudSurface in EditorApp.
'use client';
import React, { useCallback, useEffect, useRef } from 'react';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';
import { useTransformContext } from '@/contexts/TransformContext';
import { EditorTool } from '@/stores/EditorUIStore';
import { getDragManager, getHistoryStore } from '@/stores/RootStore';
import type { ComponentInstance } from '@/models/ComponentModel';
import { frameHeightsKey, visibleRectInFrame, type ScreenRect } from '@/lib/canvas/viewportFrame';
import {
  HANDLE_MIN_OFFSET,
  boxBands,
  contentBox,
  gapBands,
  handleForRegion,
  intersectRects,
  outerBox,
  rectContains,
  type Edges,
  type HandlePlacement,
  type SpacingRegion,
  type SpacingTarget,
} from '@/lib/canvas/spacingGeometry';
import { isAutoSide, parseCssPx, sideProp, startSpacingDrag } from '@/lib/canvas/spacingDrag';

interface Measured {
  regions: SpacingRegion[];
  handles: Map<string, HandlePlacement>;
  /** Where the pointer counts as "over the element" for showing the layer. */
  hoverArea: ScreenRect;
  /** The frame's clip rect; bands are cut to it. Null for floating elements. */
  clip: ScreenRect | null;
  padding: Edges;
  margin: Edges;
  rowGap: number;
  columnGap: number;
  scale: number;
}

interface ActiveDrag {
  id: string;
  target: SpacingTarget;
  value: number;
}

const PILL_GAP = 6;
const HOVER_SLOP = HANDLE_MIN_OFFSET + 12;

const BRAND = 'var(--brand)';
const MARGIN = 'rgb(245 158 11)'; // amber-500: margin reads apart from padding and gap

function bandBackground(target: SpacingTarget, strong: boolean): string {
  const color = target.kind === 'margin' ? MARGIN : BRAND;
  const tint = strong ? 22 : 10;
  const stripe = strong ? 55 : 35;
  // Gaps hatch the other way, so a gap next to a padding band reads apart.
  const angle = target.kind === 'gap' ? 45 : 135;
  return [
    `repeating-linear-gradient(${angle}deg, color-mix(in oklab, ${color} ${stripe}%, transparent) 0 1px, transparent 1px 6px)`,
    `color-mix(in oklab, ${color} ${tint}%, transparent)`,
  ].join(', ');
}

function handleTitle(target: SpacingTarget): string {
  if (target.kind === 'gap') return 'Gap. Drag to change; Shift snaps to 8.';
  const name = `${target.kind === 'padding' ? 'Padding' : 'Margin'} ${target.side}`;
  return `${name}. Drag to change; Shift snaps to 8, Alt also sets the opposite side.`;
}

function edgesOf(cs: CSSStyleDeclaration, kind: 'padding' | 'margin' | 'border'): Edges {
  const read = (side: string) =>
    parseCssPx(cs.getPropertyValue(kind === 'border' ? `border-${side}-width` : `${kind}-${side}`));
  return { top: read('top'), right: read('right'), bottom: read('bottom'), left: read('left') };
}

function findElement(component: ComponentInstance, breakpointId: string | undefined): HTMLElement | null {
  if (component.isFloatingElement) {
    return document
      .getElementById(`ground-wrapper-${component.id}`)
      ?.querySelector<HTMLElement>(`[data-inner-component-id="${component.id}"]`) ?? null;
  }
  if (!breakpointId) return null;
  return document.querySelector<HTMLElement>(`[data-component-id="${breakpointId}-${component.id}"]`);
}

const sameTarget = (a: SpacingTarget, b: SpacingTarget) =>
  a.kind === b.kind &&
  (a.kind === 'gap' ? a.axis === (b as typeof a).axis : a.side === (b as typeof a).side);

const SpacingHandlesLayer = observer(() => {
  const { editorUI } = useStore();
  const { state: transformState, subscribe } = useTransformContext();

  const selected = editorUI.selectedComponent;
  const breakpointId = editorUI.selectedViewportNode?.breakpointId;
  const rootId = editorUI.currentPage?.appComponentTree?.id;
  const enabled =
    !!selected &&
    editorUI.selectedComponentList.length === 1 &&
    !selected.isViewportNode &&
    !selected.canvasLocked &&
    (selected.isFloatingElement || !!breakpointId) &&
    editorUI.selectedTool === EditorTool.SELECT &&
    !(getDragManager()?.isActive ?? false) &&
    !editorUI.isResizing &&
    !editorUI.editingComponent;
  // Read so the observer re-runs placement when the node's styles or a
  // frame's height change (content moved).
  const selectedProps = selected?.props;
  const frameLayoutKey = frameHeightsKey(editorUI.currentPage?.viewportNodes);

  const layerRef = useRef<HTMLDivElement>(null);
  const live = useRef({ enabled, selected, breakpointId, rootId });
  live.current = { enabled, selected, breakpointId, rootId };

  const ui = useRef({
    pointer: null as { x: number; y: number } | null,
    pressedElsewhere: false,
    measured: null as Measured | null,
    drag: null as ActiveDrag | null,
    nodes: new Map<string, HTMLDivElement>(),
    raf: 0,
  });

  const measure = useCallback((): Measured | null => {
    const { enabled: on, selected: node, breakpointId: bp, rootId: root } = live.current;
    if (!on || !node) return null;
    const el = findElement(node, bp);
    if (!el || !el.isConnected) return null;
    if (!node.isFloatingElement && !visibleRectInFrame(el)) return null; // clipped away
    const rect = el.getBoundingClientRect();
    const scale = el.offsetWidth > 0 ? rect.width / el.offsetWidth : transformState.current.zoom;
    const cs = getComputedStyle(el);
    const padding = edgesOf(cs, 'padding');
    const margin = edgesOf(cs, 'margin');
    const border = edgesOf(cs, 'border');
    const includeMargin = !node.isFloatingElement && node.hasParent && node.id !== root;
    const authored = (prop: string) => node.getResponsiveStyleValue(prop, node.isFloatingElement ? undefined : bp);

    let regions = boxBands({ rect, border, padding, margin, scale, includeMargin }).filter(r =>
      !(r.target.kind === 'margin' &&
        isAutoSide(authored('margin'), authored(sideProp('margin', r.target.side)), r.target.side)));

    const rowGap = parseCssPx(cs.rowGap);
    const columnGap = parseCssPx(cs.columnGap);
    const isFlex = cs.display === 'flex' || cs.display === 'inline-flex';
    const isGrid = cs.display === 'grid' || cs.display === 'inline-grid';
    if (isFlex || isGrid) {
      const children: ScreenRect[] = [];
      for (const child of Array.from(el.children)) {
        const ccs = getComputedStyle(child);
        if (ccs.display === 'none' || ccs.position === 'absolute' || ccs.position === 'fixed') continue;
        children.push(child.getBoundingClientRect());
      }
      const flow = isFlex
        ? (cs.flexDirection.startsWith('column') ? 'column' : 'row')
        : (cs.gridAutoFlow.startsWith('column') ? 'column' : 'row');
      regions = regions.concat(gapBands({
        content: contentBox(rect, border, padding, scale),
        children,
        flow,
        wrap: isGrid || cs.flexWrap !== 'nowrap',
        rowGap,
        columnGap,
        scale,
      }));
    }

    const handles = new Map<string, HandlePlacement>();
    for (const r of regions) {
      const h = handleForRegion(r, rect);
      if (h) handles.set(r.id, h);
    }
    const frame = node.isFloatingElement ? null : el.closest('[data-viewport-content-id]');
    return {
      regions,
      handles,
      hoverArea: outerBox(rect, margin, scale),
      clip: frame ? frame.getBoundingClientRect() : null,
      padding,
      margin,
      rowGap,
      columnGap,
      scale,
    };
  }, [transformState]);

  const paint = useCallback(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const state = ui.current;
    const m = state.measured;
    const drag = state.drag;
    const p = state.pointer;

    const visible = !!m && !state.pressedElsewhere && (
      !!drag || (!!p && rectContains(m.hoverArea, p.x, p.y, HOVER_SLOP))
    );
    layer.style.opacity = visible ? '1' : '0';

    // What the pointer is over: a handle first, then a band.
    let hoverId: string | null = null;
    if (visible && m && p && !drag) {
      for (const [id, h] of m.handles) {
        if (rectContains(h.hit, p.x, p.y)) { hoverId = id; break; }
      }
      if (!hoverId) hoverId = m.regions.find(r => rectContains(r.rect, p.x, p.y))?.id ?? null;
    }
    // During a drag, the dragged band; gap ids can shift if the layout
    // reflows, so fall back to a band of the same target.
    let activeId = drag && m
      ? (m.regions.find(r => r.id === drag.id) ?? m.regions.find(r => sameTarget(r.target, drag.target)))?.id ?? null
      : hoverId;
    if (!visible) activeId = null;

    const seen = new Set<string>();
    const node = (key: string, make: () => HTMLDivElement) => {
      seen.add(key);
      let el = state.nodes.get(key);
      if (!el) {
        el = make();
        state.nodes.set(key, el);
        layer.appendChild(el);
      }
      return el;
    };
    const place = (el: HTMLElement, r: ScreenRect) => {
      el.style.transform = `translate(${r.left}px, ${r.top}px)`;
      el.style.width = `${r.width}px`;
      el.style.height = `${r.height}px`;
    };

    if (m) {
      for (const region of m.regions) {
        const strong = region.id === activeId;
        const shown = m.clip ? intersectRects(region.rect, m.clip) : region.rect;
        const band = node(`band:${region.id}`, () => {
          const el = document.createElement('div');
          el.className = 'absolute left-0 top-0 pointer-events-none';
          el.setAttribute('data-testid', 'spacing-band');
          return el;
        });
        band.setAttribute('data-spacing-band', region.id);
        if (!shown || shown.width < 0.5 || shown.height < 0.5) {
          band.style.display = 'none';
        } else {
          band.style.display = 'block';
          band.style.background = bandBackground(region.target, strong);
          place(band, shown);
        }

        const h = m.handles.get(region.id);
        if (!h) continue;
        const hit = node(`handle:${region.id}`, () => {
          const el = document.createElement('div');
          el.className = 'absolute left-0 top-0 flex items-center justify-center';
          const bar = document.createElement('div');
          bar.className = 'rounded-full shadow-[0_0_0_1px_white] transition-transform duration-100 ease-out motion-reduce:transition-none';
          el.appendChild(bar);
          return el;
        });
        hit.setAttribute('data-spacing-handle', region.id);
        hit.setAttribute('data-testid', `spacing-handle-${region.id}`);
        hit.title = handleTitle(region.target);
        hit.style.cursor = h.orientation === 'horizontal' ? 'ns-resize' : 'ew-resize';
        hit.style.pointerEvents = visible ? 'auto' : 'none';
        place(hit, h.hit);
        const bar = hit.firstElementChild as HTMLDivElement;
        bar.style.width = `${h.bar.width}px`;
        bar.style.height = `${h.bar.height}px`;
        bar.style.background = region.target.kind === 'margin' ? MARGIN : BRAND;
        bar.style.transform = region.id === activeId ? 'scale(1.25)' : '';
      }
    }

    // Value pill for the hovered or dragged band.
    const active = activeId && m ? m.regions.find(r => r.id === activeId) : undefined;
    const pill = node('pill', () => {
      const el = document.createElement('div');
      el.className = 'absolute left-0 top-0 pointer-events-none select-none whitespace-nowrap rounded-full px-1.5 py-px text-[10px] font-medium leading-4 tabular-nums text-white shadow-sm';
      el.setAttribute('data-testid', 'spacing-value-pill');
      return el;
    });
    if (!active || !m) {
      pill.style.display = 'none';
    } else {
      const value = drag ? drag.value : active.value;
      pill.textContent = String(Math.round(value * 100) / 100);
      pill.style.background = active.target.kind === 'margin' ? 'rgb(180 83 9)' : BRAND; // amber-700 keeps white text legible
      pill.style.display = 'block';
      const h = m.handles.get(active.id);
      if (h && h.orientation === 'horizontal') {
        const x = h.bar.left + h.bar.width + PILL_GAP;
        const y = h.bar.top + h.bar.height / 2;
        pill.style.transform = `translate(${x}px, ${y}px) translateY(-50%)`;
      } else if (h) {
        const x = h.bar.left + h.bar.width / 2;
        const y = h.bar.top + h.bar.height + PILL_GAP;
        pill.style.transform = `translate(${x}px, ${y}px) translateX(-50%)`;
      } else {
        const x = active.rect.left + active.rect.width / 2;
        const y = active.rect.top + active.rect.height / 2;
        pill.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
      }
    }

    for (const [key, el] of state.nodes) {
      if (!seen.has(key)) {
        el.remove();
        state.nodes.delete(key);
      }
    }
  }, []);

  const refresh = useCallback(() => {
    ui.current.measured = measure();
    paint();
  }, [measure, paint]);

  const scheduleRefresh = useCallback(() => {
    if (ui.current.raf) return;
    ui.current.raf = requestAnimationFrame(() => {
      ui.current.raf = 0;
      refresh();
    });
  }, [refresh]);

  // Camera changes: repaint in the same frame, like HudSurface.
  useEffect(() => subscribe(refresh), [subscribe, refresh]);

  // Selection, styles, frame heights or the enabled state changed: wait one
  // frame for the renderer to apply styles, then measure.
  useEffect(() => {
    scheduleRefresh();
  }, [enabled, selected, breakpointId, selectedProps, frameLayoutKey, scheduleRefresh]);

  // Pointer tracking and the "press elsewhere" hide.
  useEffect(() => {
    const state = ui.current;
    const onMove = (e: PointerEvent) => {
      state.pointer = { x: e.clientX, y: e.clientY };
      scheduleRefresh();
    };
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Node && layerRef.current?.contains(e.target)) return;
      state.pressedElsewhere = true;
      paint();
    };
    const onUp = () => {
      if (!state.pressedElsewhere) return;
      state.pressedElsewhere = false;
      scheduleRefresh();
    };
    const onLeave = (e: PointerEvent) => {
      // Pointer left the window.
      if (e.relatedTarget === null) {
        state.pointer = null;
        scheduleRefresh();
      }
    };
    const onBlur = () => {
      state.pressedElsewhere = false;
      state.pointer = null;
      scheduleRefresh();
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
    document.addEventListener('pointerout', onLeave);
    window.addEventListener('resize', scheduleRefresh);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      document.removeEventListener('pointerout', onLeave);
      window.removeEventListener('resize', scheduleRefresh);
      window.removeEventListener('blur', onBlur);
      if (state.raf) cancelAnimationFrame(state.raf);
      state.raf = 0;
    };
  }, [paint, scheduleRefresh]);

  // A drag left running when the layer unmounts or the selection goes away
  // is committed (what the user dragged stays, as one undo step).
  const endDragRef = useRef<((commit: boolean) => void) | null>(null);
  useEffect(() => () => endDragRef.current?.(true), []);
  useEffect(() => {
    if (!enabled) endDragRef.current?.(true);
  }, [enabled]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !e.isPrimary) return;
    const handleEl = (e.target as Element).closest('[data-spacing-handle]');
    const id = handleEl?.getAttribute('data-spacing-handle');
    const m = ui.current.measured;
    const region = id && m ? m.regions.find(r => r.id === id) : undefined;
    const { enabled: on, selected: node, breakpointId: bp } = live.current;
    if (!region || !m || !node || !on || ui.current.drag) return;

    // Nothing else may treat this press as a selection, pan or text selection.
    e.preventDefault();
    e.stopPropagation();

    const target = region.target;
    const start = target.kind === 'gap'
      ? { row: m.rowGap, column: m.columnGap }
      : target.kind === 'padding' ? m.padding : m.margin;
    const session = startSpacingDrag({
      component: node,
      breakpointId: node.isFloatingElement ? undefined : bp,
      target,
      start,
      scale: m.scale,
      mirror: e.altKey,
      history: getHistoryStore(),
    });
    const startValue = target.kind === 'gap'
      ? m[target.axis === 'row' ? 'rowGap' : 'columnGap']
      : (start as Edges)[target.side];
    ui.current.drag = { id: region.id, target, value: startValue };

    const pointerId = e.pointerId;
    const origin = { x: e.clientX, y: e.clientY };
    const body = document.body.style;
    const prevCursor = body.cursor;
    const prevUserSelect = body.userSelect;
    body.cursor = (handleEl as HTMLElement).style.cursor;
    body.userSelect = 'none';

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId || !ui.current.drag) return;
      ui.current.drag.value = session.update({
        dx: ev.clientX - origin.x,
        dy: ev.clientY - origin.y,
        snap: ev.shiftKey,
      });
      ui.current.pointer = { x: ev.clientX, y: ev.clientY };
      scheduleRefresh();
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      end(true);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      // Cancels the drag only; must not also clear the selection.
      ev.preventDefault();
      ev.stopPropagation();
      end(false);
    };
    const onBlur = () => end(true);

    function end(commit: boolean) {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
      body.cursor = prevCursor;
      body.userSelect = prevUserSelect;
      if (commit) session.commit();
      else session.cancel();
      ui.current.drag = null;
      endDragRef.current = null;
      scheduleRefresh();
    }

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    endDragRef.current = end;
    paint();
  }, [paint, scheduleRefresh]);

  return (
    <div
      ref={layerRef}
      aria-hidden="true"
      data-testid="spacing-handles-layer"
      className="fixed inset-0 pointer-events-none transition-opacity duration-150 ease-out motion-reduce:transition-none"
      style={{ zIndex: 10, opacity: 0 }}
      onPointerDown={onPointerDown}
    />
  );
});

SpacingHandlesLayer.displayName = 'SpacingHandlesLayer';

export default SpacingHandlesLayer;

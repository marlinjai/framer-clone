// DragManager: one pointer pipeline for every drag gesture in the editor.
//
// Two-state lifecycle:
//   armed   - pointerdown fired, we're tracking but haven't committed to a
//             drag. A plain click without movement stays armed until pointerup
//             and never engages, so onClick fires naturally.
//   engaged - pointer moved past THRESHOLD. History batch started, overlays
//             paint, live-mode sources update canvasX/Y per frame.
//
// The `isActive` view returns true only when engaged. Consumers (overlay
// layers, keyboard shortcut guards) key off that.
//
// Lifecycle:
//   begin(source, event, sourceNode?)
//     -> capture pointer, attach listeners, stash start state. No history
//        batch yet, no body-style changes. DragManager.isActive remains false.
//   handleMove(e)
//     -> if not engaged, distance check against THRESHOLD. Past threshold,
//        _engage(): start history batch, set body userSelect: none, mark
//        isActive true.
//     -> resolve drop target, paint indicator, update canvasX/Y for live-mode.
//   handleUp(e)
//     -> if engaged, commit the resolved InsertTarget, commit batch. Always
//        detach listeners, restore body style, clear state.
//   handleCancel()   (pointercancel OR Escape)
//     -> if engaged, restore canvasX/Y for live-mode sources, cancel batch.
//        Always detach, restore body style, clear state.
//
// The manager lives OUTSIDE projectStore, so its own volatile mutations are
// invisible to HistoryStore's middleware. Only mutations the manager makes on
// `sourceNode` (updateCanvasTransform, setCanvasPosition) and on `page`
// (moveTreeComponent, insertRegistryComponent) are recorded, and they batch
// into one history entry per gesture via startBatch / commitBatch.

import React from 'react';
import { types, Instance, isAlive } from 'mobx-state-tree';
import type { ComponentInstance } from '@/models/ComponentModel';
import type { InsertTarget, PageModelType } from '@/models/PageModel';
import { EditorTool, type EditorUIType } from '@/stores/EditorUIStore';
import type { HistoryStoreInstance } from '@/stores/HistoryStore';
import type { DragSource, DragMode, IndicatorSpec } from './types';
import { resolveDropTarget } from './resolveDropTarget';

export interface DragManagerDeps {
  getTransform: () => { panX: number; panY: number; zoom: number };
  getPage: () => PageModelType | undefined;
  getHistory: () => HistoryStoreInstance | null;
  getEditorUI: () => EditorUIType;
}

// Pixels the pointer must move before a pointerdown becomes a drag gesture.
// Below this, the pointerdown+up sequence is treated as a click (which fires
// naturally via the compat mouse event pipeline).
const THRESHOLD_PX = 4;

function batchName(source: DragSource, sourceNode?: ComponentInstance): string {
  if (source.kind === 'create') return 'Create component';
  if (sourceNode?.isViewportNode) return 'Move viewport';
  if (sourceNode?.isFloatingElement) return 'Move element';
  return 'Move component';
}

function modeFor(source: DragSource, sourceNode?: ComponentInstance): DragMode {
  if (source.kind === 'create') return 'ghost';
  if (sourceNode?.isViewportNode) return 'live';
  if (sourceNode?.isFloatingElement) return 'live';
  return 'ghost';
}

function labelFor(source: DragSource, sourceNode?: ComponentInstance): string {
  if (source.kind === 'create') return source.registryId;
  return sourceNode?.displayName ?? 'Component';
}

const DragManagerModel = types
  .model('DragManager', {})
  .volatile(() => ({
    // Gesture state. null when no pointer is armed.
    source: null as DragSource | null,
    sourceNode: null as ComponentInstance | null,
    startClient: null as { x: number; y: number } | null,
    startCanvasPos: null as { x: number; y: number } | null,
    pointerId: null as number | null,
    mode: null as DragMode | null,
    ghostLabel: null as string | null,

    // False while armed, true once the pointer has moved past THRESHOLD_PX.
    engaged: false,

    // Updated every frame while engaged.
    pendingTarget: null as InsertTarget | null,
    indicator: null as IndicatorSpec,
    currentPointer: null as { x: number; y: number } | null,

    // Injected at store creation via wire(). See DragManagerBinding in
    // EditorApp.tsx for where this happens.
    deps: null as DragManagerDeps | null,

    // Opaque cleanup: removes listeners, releases pointer capture, restores
    // document body style. Set during begin(), called from up / cancel paths.
    _cleanup: null as null | (() => void),
  }))
  .views(self => ({
    /** True only when a drag gesture has engaged (past threshold). Consumers
     * use this to gate overlay painting and keyboard shortcut suppression. */
    get isActive(): boolean {
      return self.engaged;
    },
    get sourceNodeId(): string | undefined {
      return self.source?.kind === 'moveNode' ? self.source.nodeId : undefined;
    },
    get ghost(): { label: string } | null {
      if (!self.engaged) return null;
      if (self.mode !== 'ghost') return null;
      if (!self.ghostLabel) return null;
      return { label: self.ghostLabel };
    },
  }))
  .actions(self => ({
    wire(deps: DragManagerDeps) {
      self.deps = deps;
    },
    _arm(args: {
      source: DragSource;
      sourceNode?: ComponentInstance;
      startClient: { x: number; y: number };
      startCanvasPos?: { x: number; y: number };
      mode: DragMode;
      pointerId: number;
      ghostLabel: string;
    }) {
      self.source = args.source;
      self.sourceNode = args.sourceNode ?? null;
      self.startClient = args.startClient;
      self.startCanvasPos = args.startCanvasPos ?? null;
      self.mode = args.mode;
      self.pointerId = args.pointerId;
      self.currentPointer = args.startClient;
      self.ghostLabel = args.ghostLabel;
      self.engaged = false;
      self.pendingTarget = null;
      self.indicator = null;
    },
    _engage() {
      self.engaged = true;
    },
    _setPending(target: InsertTarget | null, indicator: IndicatorSpec) {
      self.pendingTarget = target;
      self.indicator = indicator;
    },
    _setCurrentPointer(x: number, y: number) {
      self.currentPointer = { x, y };
    },
    _setCleanup(cleanup: (() => void) | null) {
      self._cleanup = cleanup;
    },
    _clear() {
      self.source = null;
      self.sourceNode = null;
      self.startClient = null;
      self.startCanvasPos = null;
      self.mode = null;
      self.pointerId = null;
      self.pendingTarget = null;
      self.indicator = null;
      self.currentPointer = null;
      self.ghostLabel = null;
      self.engaged = false;
    },
  }))
  .actions(self => {
    // Document-level side effects applied when the gesture engages. Reverted
    // during cleanup. Stashing the previous body style so we don't clobber
    // another subsystem's setting.
    let prevUserSelect: string | null = null;
    let prevCursor: string | null = null;
    function applyEngagedBodyStyle() {
      prevUserSelect = document.body.style.userSelect;
      prevCursor = document.body.style.cursor;
      document.body.style.userSelect = 'none';
      document.body.style.cursor = self.mode === 'live' ? 'grabbing' : 'grabbing';
    }
    function restoreBodyStyle() {
      if (prevUserSelect !== null) document.body.style.userSelect = prevUserSelect;
      if (prevCursor !== null) document.body.style.cursor = prevCursor;
      prevUserSelect = null;
      prevCursor = null;
    }

    const engageIfPastThreshold = (e: PointerEvent): boolean => {
      if (self.engaged) return true;
      if (!self.startClient) return false;
      const dx = e.clientX - self.startClient.x;
      const dy = e.clientY - self.startClient.y;
      if (Math.abs(dx) < THRESHOLD_PX && Math.abs(dy) < THRESHOLD_PX) return false;
      // Cross the threshold: start the history batch, mark engaged, apply body
      // style. From here on the drag visuals paint and live mode updates
      // canvasX/Y.
      const deps = self.deps;
      if (!deps || !self.source) return false;
      deps.getHistory()?.startBatch(batchName(self.source, self.sourceNode ?? undefined));
      self._engage();
      applyEngagedBodyStyle();
      return true;
    };

    const handleMove = (e: PointerEvent) => {
      if (e.pointerId !== self.pointerId) return;
      if (!self.source) return;
      const deps = self.deps;
      if (!deps) return;

      if (!engageIfPastThreshold(e)) return;

      const transform = deps.getTransform();
      self._setCurrentPointer(e.clientX, e.clientY);

      // Resolve drop target based on what's under the cursor.
      const { target, indicator } = resolveDropTarget({
        pointer: { clientX: e.clientX, clientY: e.clientY },
        transform,
        source: self.source,
        sourceNode: self.sourceNode && isAlive(self.sourceNode) ? self.sourceNode : undefined,
      });
      self._setPending(target, indicator);

      // Live mode: keep source's canvasX/Y pinned to cursor in canvas space.
      // If the pointer wanders into a reparent-eligible container, we still
      // live-update here; on release, moveTreeComponent({kind:'parent'})
      // replaces canvasX/Y with tree-child semantics, and the intermediate
      // canvasX/Y updates are captured in the same single history entry.
      if (
        self.mode === 'live' &&
        self.sourceNode &&
        isAlive(self.sourceNode) &&
        self.startClient &&
        self.startCanvasPos
      ) {
        const dxScreen = e.clientX - self.startClient.x;
        const dyScreen = e.clientY - self.startClient.y;
        const dxCanvas = dxScreen / transform.zoom;
        const dyCanvas = dyScreen / transform.zoom;
        self.sourceNode.updateCanvasTransform({
          x: Math.round(self.startCanvasPos.x + dxCanvas),
          y: Math.round(self.startCanvasPos.y + dyCanvas),
        });
      }
    };

    const handleUp = (e: PointerEvent) => {
      if (e.pointerId !== self.pointerId) return;
      const source = self.source;
      const sourceNode = self.sourceNode;
      const target = self.pendingTarget;
      const deps = self.deps;
      if (!deps) {
        finalizeCleanup(false);
        return;
      }

      const wasEngaged = self.engaged;
      const page = deps.getPage();
      const history = deps.getHistory();
      const editorUI = deps.getEditorUI();

      try {
        // Click (armed but never engaged): nothing to commit, nothing to
        // undo. The native click event fires separately and handles selection.
        if (!wasEngaged) return;

        if (source && page && target) {
          if (source.kind === 'create') {
            const result = page.insertRegistryComponent(source.registryId, target);
            if (result) {
              const breakpointId = editorUI.selectedViewportNode?.breakpointId;
              editorUI.selectComponent(result, breakpointId);
            }
          } else if (source.kind === 'moveNode') {
            const isViewport = sourceNode?.isViewportNode === true;
            const isFloating = sourceNode?.isFloatingElement === true;
            // Live-mode sources (floating, viewport) that stay in canvas space
            // have already been positioned by the per-frame updateCanvasTransform
            // calls. Calling moveTreeComponent({kind:'floating'}) on them would
            // overwrite canvasX/Y with resolveGroundTarget's cursor-relative
            // coords, which don't preserve the initial grab offset and make the
            // element visibly jump on release.
            const liveReleaseOnCanvas = target.kind === 'floating' && (isViewport || isFloating);
            // Viewports never reparent. A tree target for a viewport source is
            // discarded; per-frame canvasX/Y updates stand.
            const viewportTreeDrop = isViewport && target.kind !== 'floating';
            if (!liveReleaseOnCanvas && !viewportTreeDrop) {
              const result = page.moveTreeComponent(source.nodeId, target);
              if (result) {
                const breakpointId = editorUI.selectedViewportNode?.breakpointId;
                editorUI.selectComponent(result, breakpointId);
              }
            }
          }
        }
      } finally {
        if (wasEngaged) history?.commitBatch();
        finalizeCleanup(wasEngaged);
      }
    };

    const handleCancel = () => {
      const sourceNode = self.sourceNode;
      const startCanvasPos = self.startCanvasPos;
      const wasEngaged = self.engaged;
      const deps = self.deps;
      const history = deps?.getHistory();

      try {
        if (!wasEngaged) return; // Nothing to revert: armed-only click.
        // Restore live-mode canvas position so the post-cancel state matches
        // what history shows (the batch is about to be dropped).
        if (
          self.mode === 'live' &&
          sourceNode &&
          isAlive(sourceNode) &&
          startCanvasPos
        ) {
          sourceNode.setCanvasPosition(startCanvasPos.x, startCanvasPos.y);
        }
      } finally {
        if (wasEngaged) history?.cancelBatch();
        finalizeCleanup(wasEngaged);
      }
    };

    function finalizeCleanup(wasEngaged: boolean) {
      if (wasEngaged) restoreBodyStyle();
      self._cleanup?.();
      self._setCleanup(null);
      self._clear();
    }

    return {
      /**
       * Start a drag gesture. Returns true if accepted.
       *
       * Refused when:
       *   - Another gesture is active.
       *   - The event is not a primary (left / single-finger / pen) press.
       *   - The selected tool is GRAB and the source is a moveNode (canvas pan
       *     takes priority over node reparenting). Panel creates still work
       *     in GRAB mode so users can drop-to-create while panning.
       *   - Source is `moveNode` but the node is the app tree root.
       *   - Source is `moveNode` but the node is currently being inline-edited.
       *   - Dependencies haven't been wired yet (shouldn't happen at runtime).
       */
      begin(
        source: DragSource,
        event: React.PointerEvent,
        sourceNode?: ComponentInstance,
      ): boolean {
        if (self.isActive || self.source !== null) return false;
        const deps = self.deps;
        if (!deps) return false;
        if (!event.isPrimary) return false;
        if (event.button !== 0 && event.pointerType === 'mouse') return false;

        if (source.kind === 'moveNode') {
          if (!sourceNode) return false;
          // App tree root: no parent AND not a canvas node. Not draggable.
          if (!sourceNode.hasParent && !sourceNode.isViewportNode && !sourceNode.isFloatingElement) {
            return false;
          }
          const editorUI = deps.getEditorUI();
          // GRAB tool owns the canvas; let Canvas's own mousedown start a pan.
          if (editorUI.selectedTool === EditorTool.GRAB) return false;
          // Currently inline-editing this node: refuse so typing stays stable.
          if (editorUI.editingComponent?.id === source.nodeId) return false;
        }

        const startClient = { x: event.clientX, y: event.clientY };
        const startCanvasPos = sourceNode?.isRootCanvasComponent
          ? { x: sourceNode.canvasX ?? 0, y: sourceNode.canvasY ?? 0 }
          : undefined;

        const mode = modeFor(source, sourceNode);
        const el = event.currentTarget as HTMLElement;
        const pointerId = event.pointerId;

        // Prevent the gesture from bubbling to an ancestor (viewport / ground)
        // drag source. We deliberately do NOT call preventDefault: that would
        // suppress the compat click event, breaking select-on-click for any
        // node whose drag-armed state never escalates to engaged.
        event.stopPropagation();

        // Capture pointer so pointermove / pointerup / pointercancel fire on
        // this element even if the pointer leaves its bounding box.
        try {
          el.setPointerCapture(pointerId);
        } catch {
          // Some environments may refuse capture. Document-level listeners
          // below are the safety net.
        }

        const onMove = (ev: PointerEvent) => handleMove(ev);
        const onUp = (ev: PointerEvent) => handleUp(ev);
        const onCancelEv = (ev: PointerEvent) => {
          if (ev.pointerId !== pointerId) return;
          handleCancel();
        };
        const onKey = (ev: KeyboardEvent) => {
          if (ev.key === 'Escape') {
            ev.preventDefault();
            ev.stopPropagation();
            handleCancel();
          }
        };

        el.addEventListener('pointermove', onMove);
        el.addEventListener('pointerup', onUp);
        el.addEventListener('pointercancel', onCancelEv);
        // Safety net on document in case pointer capture was refused.
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
        document.addEventListener('pointercancel', onCancelEv);
        document.addEventListener('keydown', onKey, true);

        const cleanup = () => {
          el.removeEventListener('pointermove', onMove);
          el.removeEventListener('pointerup', onUp);
          el.removeEventListener('pointercancel', onCancelEv);
          document.removeEventListener('pointermove', onMove);
          document.removeEventListener('pointerup', onUp);
          document.removeEventListener('pointercancel', onCancelEv);
          document.removeEventListener('keydown', onKey, true);
          try {
            if (el.hasPointerCapture(pointerId)) {
              el.releasePointerCapture(pointerId);
            }
          } catch {
            // noop
          }
        };

        self._arm({
          source,
          sourceNode,
          startClient,
          startCanvasPos,
          mode,
          pointerId,
          ghostLabel: labelFor(source, sourceNode),
        });
        self._setCleanup(cleanup);
        return true;
      },

      /** Exposed for programmatic cancel (e.g. page switch mid-gesture). */
      cancel() {
        if (self.source === null) return;
        handleCancel();
      },
    };
  });

export type DragManagerInstance = Instance<typeof DragManagerModel>;
export default DragManagerModel;

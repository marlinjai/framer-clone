// src/stores/HistoryStore.ts
//
// Custom undo/redo store built on MST's action-tracking middleware. Unlike the
// stock `mst-middlewares` UndoManager this one also captures the triggering
// action name per entry, so a history panel can render "deleteComponent" or
// "updateResponsiveStyle" instead of opaque "Step 3" labels.
//
// Scope is set via `setTargetStore(node)`. Only actions executed on that
// subtree are recorded, so selection/tool state in EditorUIStore and non-MST
// pan/zoom transforms stay out of history.
import {
  types,
  Instance,
  addMiddleware,
  recordPatches,
  applyPatch,
  createActionTrackingMiddleware2,
  IAnyStateTreeNode,
  IJsonPatch,
  addDisposer,
} from 'mobx-state-tree';
import { v4 as uuidv4 } from 'uuid';

const HistoryEntryModel = types.model('HistoryEntry', {
  id: types.identifier,
  actionName: types.string,
  timestamp: types.number,
  patches: types.frozen<readonly IJsonPatch[]>(),
  inversePatches: types.frozen<readonly IJsonPatch[]>(),
});

export type HistoryEntryInstance = Instance<typeof HistoryEntryModel>;

// Max entries kept. Older ones are trimmed from the front.
const MAX_HISTORY = 500;

const HistoryStore = types
  .model('HistoryStore', {
    history: types.array(HistoryEntryModel),
    // Points to the slot that would be filled by the next new entry. Equal to
    // history.length when no redo is pending. On undo, decremented; the entry
    // at undoIdx - 1 is the last applied.
    undoIdx: types.optional(types.number, 0),
  })
  .volatile(() => ({
    targetStore: undefined as IAnyStateTreeNode | undefined,
    // >0 means the middleware should drop this action (undo/redo reapplies
    // shouldn't themselves become history entries).
    skipDepth: 0,
    middlewareDisposer: undefined as (() => void) | undefined,
    // A batch collects patches from many actions into one history entry. Used
    // for continuous gestures (drag, resize) where per-frame mutations would
    // otherwise flood history with 60 entries per second.
    batch: undefined as {
      name: string;
      patches: IJsonPatch[];
      inversePatches: IJsonPatch[];
    } | undefined,
  }))
  .views(self => ({
    get canUndo() {
      return self.undoIdx > 0;
    },
    get canRedo() {
      return self.undoIdx < self.history.length;
    },
    // Short, human-friendly label for an entry. Leads with the action name;
    // if the action touched a single path, appends the tail of that path.
    labelFor(entry: HistoryEntryInstance): string {
      const path = entry.patches[0]?.path ?? '';
      const short = shortenPath(path);
      return short ? `${entry.actionName} · ${short}` : entry.actionName;
    },
  }))
  .actions(self => {
    // Internal: wrap a mutation so the middleware ignores actions it triggers.
    const withoutRecording = <T,>(fn: () => T): T => {
      self.skipDepth++;
      try {
        return fn();
      } finally {
        self.skipDepth--;
      }
    };

    return {
      // Wire the middleware onto `target`. Only actions under this subtree are
      // recorded. Safe to call again (disposes the previous middleware first).
      setTargetStore(target: IAnyStateTreeNode) {
        self.targetStore = target;
        if (self.middlewareDisposer) {
          self.middlewareDisposer();
          self.middlewareDisposer = undefined;
        }

        const middleware = createActionTrackingMiddleware2<{
          recorder?: ReturnType<typeof recordPatches>;
        }>({
          filter: call => {
            if (self.skipDepth > 0) return false;
            // Already being recorded by a parent action — don't double-count.
            if (call.env?.recorder) return false;
            return true;
          },
          onStart: call => {
            // recordPatches(node) captures *all* patches emitted under that
            // node for the duration of the action, regardless of which nested
            // child the action touches.
            call.env = { recorder: recordPatches(self.targetStore!) };
          },
          onFinish: (call, error) => {
            const recorder = call.env?.recorder;
            if (!recorder) return;
            recorder.stop();
            if (error) return;
            if (recorder.patches.length === 0) return;
            // During a batch, accumulate patches instead of pushing entries.
            // commitBatch() will emit a single entry on gesture end.
            if (self.batch) {
              self.batch.patches.push(...recorder.patches);
              self.batch.inversePatches.push(...recorder.inversePatches);
              return;
            }
            this.recordEntry(
              call.name,
              recorder.patches,
              recorder.inversePatches,
            );
          },
        });

        const dispose = addMiddleware(target, middleware, false);
        self.middlewareDisposer = dispose;
        addDisposer(self, () => {
          dispose();
          self.middlewareDisposer = undefined;
        });
      },

      recordEntry(
        actionName: string,
        patches: readonly IJsonPatch[],
        inversePatches: readonly IJsonPatch[],
      ) {
        withoutRecording(() => {
          // Drop redo tail — any new action invalidates it.
          if (self.undoIdx < self.history.length) {
            self.history.splice(self.undoIdx);
          }
          self.history.push({
            id: uuidv4(),
            actionName,
            timestamp: Date.now(),
            patches,
            inversePatches,
          });
          // Trim from the front once over budget.
          if (self.history.length > MAX_HISTORY) {
            self.history.splice(0, self.history.length - MAX_HISTORY);
          }
          self.undoIdx = self.history.length;
        });
      },

      undo() {
        if (!self.canUndo || !self.targetStore) return;
        withoutRecording(() => {
          const entry = self.history[self.undoIdx - 1];
          applyPatch(
            self.targetStore!,
            entry.inversePatches.slice().reverse(),
          );
          self.undoIdx--;
        });
      },

      redo() {
        if (!self.canRedo || !self.targetStore) return;
        withoutRecording(() => {
          const entry = self.history[self.undoIdx];
          applyPatch(self.targetStore!, entry.patches.slice());
          self.undoIdx++;
        });
      },

      // Jump to a specific undoIdx in [0, history.length]. Walks the stack
      // entry-by-entry so patches apply in order — cheaper than re-creating
      // state from scratch, handles both directions, preserves semantics.
      jumpTo(targetIdx: number) {
        if (!self.targetStore) return;
        const clamped = Math.max(0, Math.min(targetIdx, self.history.length));
        while (self.undoIdx > clamped) this.undo();
        while (self.undoIdx < clamped) this.redo();
      },

      clear() {
        self.history.clear();
        self.undoIdx = 0;
      },

      // ------ Gesture batching ------
      //
      // Call startBatch when a continuous interaction begins (drag, resize).
      // Every MST action that fires while the batch is active has its patches
      // appended to one pending entry instead of creating its own. commitBatch
      // finishes the gesture and writes a single history entry; cancelBatch
      // drops the accumulated patches (use this when ESC rolls state back).
      //
      // Nested batches are ignored (first-wins) — safer than nesting.
      startBatch(name: string) {
        if (self.batch) return;
        self.batch = { name, patches: [], inversePatches: [] };
      },

      commitBatch() {
        const batch = self.batch;
        if (!batch) return;
        self.batch = undefined;
        if (batch.patches.length === 0) return;
        this.recordEntry(batch.name, batch.patches, batch.inversePatches);
      },

      cancelBatch() {
        // Patches are discarded — caller is responsible for restoring state.
        self.batch = undefined;
      },
    };
  });

// Shorten MST JSON patch paths for display.
// "/projects/abc.../pages/def.../appComponentTree/children/0/props/style/width"
// becomes "width" — or "children/0" for structural edits.
function shortenPath(path: string): string {
  if (!path) return '';
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return '';
  // Take the last two segments as a hint — usually the actual field being
  // mutated and its immediate parent (e.g. "style/width", "children/0").
  return parts.slice(-2).join('/');
}

export default HistoryStore;
export type HistoryStoreInstance = Instance<typeof HistoryStore>;

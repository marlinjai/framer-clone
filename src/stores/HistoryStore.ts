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
  tryResolve,
  types,
  Instance,
  addMiddleware,
  recordPatches,
  applyPatch,
  createActionTrackingMiddleware2,
  IAnyStateTreeNode,
  IJsonPatch,
  addDisposer,
  getSnapshot,
  SnapshotIn,
} from 'mobx-state-tree';
import { v4 as uuidv4 } from 'uuid';

const HistoryEntryModel = types.model('HistoryEntry', {
  id: types.identifier,
  actionName: types.string,
  timestamp: types.number,
  patches: types.frozen<readonly IJsonPatch[]>(),
  inversePatches: types.frozen<readonly IJsonPatch[]>(),
  // A change adopted from outside this tab (applyRemote): its name is the
  // writer's label and shows as it is, without a path.
  remote: types.optional(types.boolean, false),
});

export type HistoryEntryInstance = Instance<typeof HistoryEntryModel>;

// True while ProjectModel's size guard takes back an edit it refused.
let takingBackRefusedEdit = false;

/**
 * Runs the undo of a refused edit. That edit's entry is already in, because the
 * guard sits below this store's middleware in the call, so the entry goes, and the
 * undo records none: there is nothing to step back through.
 */
export function takeBackRefusedEdit(undo: () => void): void {
  takingBackRefusedEdit = true;
  try {
    undo();
  } finally {
    takingBackRefusedEdit = false;
  }
}

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
    // What the newest entry pushed out (the redo tail, and any front entries
    // trimmed for budget), so taking a refused edit back puts it all back.
    displaced: undefined as {
      entryId: string;
      trimmed: SnapshotIn<typeof HistoryEntryModel>[];
      tail: SnapshotIn<typeof HistoryEntryModel>[];
    } | undefined,
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
      if (entry.remote) return entry.actionName;
      const path = entry.patches[0]?.path ?? '';
      const short = shortenPath(path);
      const label = short ? `${entry.actionName} · ${short}` : entry.actionName;
      // An edit inside a definition reaches every placement, so the entry names it.
      const inside = /^.*\/components\/[^/]+/.exec(path)?.[0];
      const definition = inside && self.targetStore ? tryResolve(self.targetStore, inside) as { name?: unknown } | undefined : undefined;
      return typeof definition?.name === 'string' ? `${definition.name}: ${label}` : label;
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
      // Run a change to the project that must NOT become an undo step: the
      // project rename is a server-side action (PATCH /api/projects/<id>)
      // mirrored into the working copy, so Cmd+Z reverting only the local
      // title would show a name the database does not have.
      runUntracked<T>(fn: () => T): T {
        return withoutRecording(fn);
      },

      // Record a change that came from outside this tab (an agent's or another
      // person's write, adopted by src/lib/projects/liveSync.ts) as ONE entry,
      // labelled by who made it. Entries are patches with array indices, so a
      // change applied outside the history would shift indices under the
      // earlier entries and their undos would misapply; on the stack, every
      // inverse applies to exactly the state it was recorded on. Patches are
      // taken by hand (the middleware would record the inner actions under
      // their own names); a change that patches nothing records nothing.
      // Answers whether an entry was recorded.
      applyRemote(label: string, fn: () => void): boolean {
        if (!self.targetStore) {
          withoutRecording(fn);
          return false;
        }
        // A gesture in progress keeps its own patches; the remote change is its own step.
        const recorder = recordPatches(self.targetStore);
        try {
          withoutRecording(fn);
        } finally {
          recorder.stop();
        }
        if (recorder.patches.length === 0) return false;
        this.recordEntry(label, recorder.patches, recorder.inversePatches, true);
        return true;
      },

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
            if (takingBackRefusedEdit) {
              this.forgetLastEntry();
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
        remote = false,
      ) {
        withoutRecording(() => {
          // Drop redo tail — any new action invalidates it.
          const tail = self.undoIdx < self.history.length
            ? self.history.slice(self.undoIdx).map(entry => ({ ...getSnapshot(entry) }))
            : [];
          if (tail.length > 0) self.history.splice(self.undoIdx);
          const entryId = uuidv4();
          self.history.push({
            id: entryId,
            actionName,
            timestamp: Date.now(),
            patches,
            inversePatches,
            remote,
          });
          // Trim from the front once over budget.
          let trimmed: SnapshotIn<typeof HistoryEntryModel>[] = [];
          if (self.history.length > MAX_HISTORY) {
            const over = self.history.length - MAX_HISTORY;
            trimmed = self.history.slice(0, over).map(entry => ({ ...getSnapshot(entry) }));
            self.history.splice(0, over);
          }
          self.displaced = { entryId, trimmed, tail };
          self.undoIdx = self.history.length;
        });
      },

      forgetLastEntry() {
        withoutRecording(() => {
          const lastId = self.history[self.undoIdx - 1]?.id;
          self.history.splice(self.undoIdx - 1, 1);
          self.undoIdx -= 1;
          // The refused edit's entry took the redo tail with it: put that back.
          const displaced = self.displaced;
          self.displaced = undefined;
          if (!displaced || lastId === undefined || displaced.entryId !== lastId) return;
          if (displaced.trimmed.length > 0) self.history.unshift(...displaced.trimmed);
          if (displaced.tail.length > 0) self.history.push(...displaced.tail);
          self.undoIdx = self.history.length - displaced.tail.length;
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
        // A gesture's patches were recorded against the tree before the clear: dropped too.
        self.batch = undefined;
        self.displaced = undefined;
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

      // Abort a gesture and undo what it did: applies the batch's own inverse
      // patches (unrecorded) and drops the batch. Restores the exact prior
      // state, including keys the gesture created, which a caller writing
      // "original values" back cannot do.
      revertBatch() {
        const batch = self.batch;
        if (!batch) return;
        self.batch = undefined;
        if (!self.targetStore || batch.inversePatches.length === 0) return;
        withoutRecording(() => {
          applyPatch(self.targetStore!, batch.inversePatches.slice().reverse());
        });
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

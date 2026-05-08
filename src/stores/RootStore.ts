// src/models/RootStore.ts
// Root store that composes all domain and UI stores
import { types, Instance } from 'mobx-state-tree';
import ProjectStore from './ProjectStore';
import EditorUIStore from './EditorUIStore';
import HistoryStore, { HistoryStoreInstance } from './HistoryStore';
import DragManagerModel, { DragManagerInstance } from '@/lib/drag/DragManager';


// RootStore composes domain stores and UI stores
export const RootStore = types.model('RootStore', {
  // Domain stores (persistent, reusable business logic)
  projectStore: ProjectStore,

  // UI stores (transient editor state)
  editorUI: EditorUIStore,
})

// TypeScript types
export type RootStoreType = Instance<typeof RootStore>;

// Scoped history. Only actions under `projectStore` (component tree, canvas
// nodes, style writes on nested components) are recorded. Pan/zoom lives in
// TransformContext (non-MST) and selection lives in `editorUI` so neither
// pollutes history.
let historyStoreSingleton: HistoryStoreInstance | null = null;

export function getHistoryStore(): HistoryStoreInstance | null {
  return historyStoreSingleton;
}

// Back-compat shim while Toolbar / EditorApp still reference the old name.
// The API surface is identical (canUndo / canRedo / undo / redo).
export function getUndoManager(): HistoryStoreInstance | null {
  return historyStoreSingleton;
}

// Singleton drag manager. Lives outside projectStore so its volatile mutations
// are not tracked by HistoryStore's middleware. Gesture-scoped batching is
// achieved by the manager calling historyStore.startBatch / commitBatch.
// Wired with dependencies (transform ref, page getter, etc.) by EditorApp at
// mount time; until then, begin() returns false.
let dragManagerSingleton: DragManagerInstance | null = null;

export function getDragManager(): DragManagerInstance | null {
  return dragManagerSingleton;
}

export function createRootStore(): RootStoreType {
  const store = RootStore.create({
    projectStore: ProjectStore.create({ projects: {} }),
    editorUI: EditorUIStore.create({}),
  });
  historyStoreSingleton = HistoryStore.create({});
  historyStoreSingleton.setTargetStore(store.projectStore);
  dragManagerSingleton = DragManagerModel.create({});
  return store;
}
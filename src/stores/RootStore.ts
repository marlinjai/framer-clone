// src/models/RootStore.ts
// Root store that composes all domain and UI stores
import { types, Instance, flow } from 'mobx-state-tree';
import ProjectStore from './ProjectStore';
import EditorUIStore from './EditorUIStore';


// RootStore composes domain stores and UI stores
export const RootStore = types.model('RootStore', {
  // Domain stores (persistent, reusable business logic)
  projectStore: ProjectStore,
  
  // UI stores (transient editor state)
  editorUI: EditorUIStore,
})

// TypeScript types
export type RootStoreType = Instance<typeof RootStore>;


export function createRootStore(): RootStoreType {
  return RootStore.create(
    {
      projectStore: ProjectStore.create({ projects: {} }),
      editorUI: EditorUIStore.create({}),
    }
  );
}
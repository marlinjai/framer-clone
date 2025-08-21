// src/models/RootStore.ts
// Root store that composes all domain and UI stores
import { types, Instance, flow } from 'mobx-state-tree';
import ProjectStore from '../stores/ProjectStore';
import EditorUIStore from '../stores/EditorUIStore';


// RootStore composes domain stores and UI stores
export const RootStore = types.model('RootStore', {
  // Domain stores (persistent, reusable business logic)
  projectStore: ProjectStore,
  
  // UI stores (transient editor state)
  editorUI: EditorUIStore,
})
.actions(self => ({
  // Initialize the application
  initialize: flow(function* () {

    
    // Set initial UI state - select first project if available
    if (self.projectStore.hasProjects) {
      const firstProject = self.projectStore.latestProject;
      self.editorUI.setCurrentProject(firstProject);
    }
  }),
}))
.views(self => ({
  // Get current application state summary
  get appState() {
    return {
      projects: self.projectStore.stats,
      ui: self.editorUI.uiState,
      hasData: self.projectStore.hasProjects
    };
  }
}));

// Factory function to create root store
export function createRootStore(): RootStoreInstance {
  return RootStore.create(
    {
      projectStore: ProjectStore.create({ projects: {} }),
      editorUI: EditorUIStore.create({}),
    }
  );
}

// TypeScript types
export type RootStoreInstance = Instance<typeof RootStore>;

export default RootStore;
import ProjectStore from '@/stores/ProjectStore';
import { RootStore, RootStoreType } from '@/stores/RootStore';
import EditorUIStore from '@/stores/EditorUIStore';

let store: RootStoreType | null = null;

export const useStore = (): RootStoreType => {
  if (!store) {
    store = RootStore.create({
        projectStore: ProjectStore.create({ projects: {} }),
        editorUI: EditorUIStore.create({}),
    });
  }
  return store;
};
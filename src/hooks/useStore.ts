import { createRootStore, RootStoreType } from '@/stores/RootStore';

let store: RootStoreType | null = null;

export const useStore = (): RootStoreType => {
  if (!store) {
    store = createRootStore();
  }
  return store;
};
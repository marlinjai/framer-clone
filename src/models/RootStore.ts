import { types } from 'mobx-state-tree';

export const RootStore = types.model('RootStore', {
  canvas: types.optional(types.string, ''),
});
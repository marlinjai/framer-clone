import { Instance, types, SnapshotIn } from 'mobx-state-tree';



// Breakpoint configuration for responsive design
const BreakpointModel = types.model('Breakpoint', {

  // Unique identifier for the breakpoint in order to reference them
  id: types.identifier, 
  //label for display purposes
  label: types.string,

  // Breakpoints are defined by their minimum width (this is the only required value)
  minWidth: types.number,
});

export type BreakpointType = Instance<typeof BreakpointModel>;
export type BreakpointSnapshotIn = SnapshotIn<typeof BreakpointModel>;


export { BreakpointModel };

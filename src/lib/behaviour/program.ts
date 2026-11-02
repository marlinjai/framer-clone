// src/lib/behaviour/program.ts
//
// The stored behaviour as the browser receives it: a table of parsed entries. It leaves
// the server in the props of a client island, so it holds only what the runtime reads.
// A state's `name` and every `preset` mark are for the panel, and sending them would
// put authored text on the page that nothing uses. `compileEntry` is the one way in.
//
// PURE and client-safe: no React, no MST. The runtime imports only the types here.

import type { Binding, FocusGroup, StateValue, StoredBehaviour, Trigger } from './format';

type Sent<T> = T extends unknown ? Omit<T, 'name' | 'preset'> : never;

export type ProgramState = Sent<StateValue>;
export type ProgramTrigger = Omit<Trigger, 'preset'>;
export type ProgramBinding = Sent<Binding>;

/** What the runtime needs of one node, shared by every element that runs it. */
export interface ProgramEntry {
  state?: ProgramState[];
  on?: ProgramTrigger[];
  bind?: ProgramBinding[];
  group?: FocusGroup;
}

/** The stored program as data. Every value went through the parser. */
export interface BehaviourProgram {
  /** Key to entries. An element runs the entry `data-fc-v` names, the first without it. */
  nodes: Record<string, ProgramEntry[]>;
}

const withoutMarks = <T extends object>(entry: T): Omit<T, 'preset' | 'name'> =>
  Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'preset' && key !== 'name')) as Omit<T, 'preset' | 'name'>;

/** One node's entry, reduced to what the browser needs. An empty entry has no keys. */
export function compileEntry(behaviour: StoredBehaviour | undefined, bindings: readonly Binding[]): ProgramEntry {
  return {
    ...(behaviour?.state ? { state: behaviour.state.map((state) => withoutMarks(state) as ProgramState) } : {}),
    ...(behaviour?.on ? { on: behaviour.on.map((trigger) => withoutMarks(trigger)) } : {}),
    ...(bindings.length > 0 ? { bind: bindings.map((binding) => withoutMarks(binding) as ProgramBinding) } : {}),
    ...(behaviour?.group ? { group: behaviour.group } : {}),
  };
}

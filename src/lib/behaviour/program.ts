// src/lib/behaviour/program.ts
//
// The stored behaviour as the browser receives it: a table of parsed entries. It leaves
// the server in the props of a client island, so it holds only what the runtime reads.
// A state's `name` and every `preset` mark are for the panel, and sending them would
// put authored text on the page that nothing uses. `compileEntry` is the one way in.
//
// PURE and client-safe: no React, no MST. The runtime imports only the types here.

import type { Action, Binding, Expression, FocusGroup, Rove, StateValue, StoredBehaviour, Trigger } from './format';

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
  /** Some node is a focus group: the page needs the `rove` chunk. */
  rove?: true;
  /** Some action touches the page beyond state, or a trigger reads keys: the page needs the `verbs` chunk. */
  verbs?: true;
}

/** One trigger firing: where it stands and what fired it. */
export interface Run {
  el: Element;
  event: Event | null;
  trigger: ProgramTrigger;
  /** How many `emit`s led here. Carried across `delay`. */
  depth: number;
  /** A press held from before the runtime started: state verbs only. */
  replay?: boolean;
}

/** What the core lends a chunk that loads beside it. */
export interface Kit {
  container: ParentNode & Node;
  doc: Document;
  surface: 'published' | 'preview' | 'canvas';
  /** The nearest node holding a key, scope by scope. */
  find(key: string, from: Element): Element | null;
  entryOf(el: Element): ProgramEntry | undefined;
  evaluate(expression: Expression, run: Pick<Run, 'el' | 'event'>): unknown;
  warn(message: string, id: string): void;
  /** Brings bindings up to date, for a verb that reads what they show. */
  settle(): void;
  /** Charges the page for a full scan. False when it may not run now. */
  charge(cost: number): boolean;
}

export interface Rover {
  move(group: string, move: Rove, run: Run): void;
  /** The text of a group's active item. */
  active(group: string, run: Pick<Run, 'el'>): string;
  /** Keeps one Tab stop in a group, on an item that can be seen. */
  sync(group: Element): void;
  stop(): void;
}

export type CreateRover = (kit: Kit) => Rover;

/** What decides whether a key press fires anything, from keys.ts. */
export interface KeyRules {
  keysAnswer(keys: readonly string[] | undefined, event: KeyboardEvent, element: Element): boolean;
  isTextEntry(element: Element): boolean;
}

export type RunVerb = (action: Action, run: Run) => void;
export type CreateVerbs = (kit: Kit) => RunVerb;

const STATE_AND_FLOW: readonly string[] = ['set', 'toggle', 'step', 'delay', 'cancel', 'emit', 'rove'];

/** True when an action, or one under a `delay`, needs the `verbs` chunk. */
function needsVerbs(action: Action): boolean {
  if ('delay' in action) return action.do.some(needsVerbs);
  return !STATE_AND_FLOW.some((verb) => verb in action);
}

/** The chunk also holds the key rules, so a key trigger needs it too. */
const needsChunk = (trigger: ProgramTrigger): boolean =>
  trigger.on === 'keydown' || trigger.on === 'keyup' || trigger.do.some(needsVerbs);

/** The whole program from its entries, saying which chunks it needs beside the core. */
export function compileProgram(nodes: Record<string, ProgramEntry[]>): BehaviourProgram {
  const entries = Object.values(nodes).flat();
  return {
    nodes,
    ...(entries.some((entry) => entry.group) ? { rove: true as const } : {}),
    ...(entries.some((entry) => entry.on?.some(needsChunk)) ? { verbs: true as const } : {}),
  };
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

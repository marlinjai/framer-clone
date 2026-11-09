// src/lib/components/definition.ts
//
// A definition: one reusable component of a site, stored under
// ProjectModel.components. It wraps a real page, so everything that edits a page
// edits a component with no new code path. That page is never in
// ProjectModel.pages, so it has no address and is in no sitemap.
//
// `parseComponents` normalises the stored JSON on read, as normalizeSiteSettings
// does: stored JSON can say anything, so a definition it refuses is skipped with
// a reason, and placements of it render as missing.
//
// A state's no-JavaScript rules compile to rules carrying `gate: 'off'` (see
// docs/plans/2026-11-02-behaviour-model.md). A pointer state is plain CSS relative
// to a marker on the placement root, named here once for expansion and detach.
//
// Contract: docs/plans/2026-11-02-reusable-components.md.

import { withDefaultViewports } from '@/lib/canvas/defaultViewports';
import { isStickyCta } from '@/lib/stickyCta/stickyCta';
import { inputDefinitionRefusal, type InputDefinition } from './inputs';
import { COMPONENT_LIMITS, isPlacementType, serializedBytes } from './placement';
import type { PageSnapshotOut } from '@/models/PageModel';

export type StateKind = 'hover' | 'pressed' | 'focused' | 'custom';

const STATE_KINDS: readonly StateKind[] = ['hover', 'pressed', 'focused', 'custom'];

export interface StateDefinition {
  /** `s1`, or `hover`, `pressed`, `focused`. */
  id: string;
  /** "Open". */
  name: string;
  kind: StateKind;
  /** Pressed implies hover, as the named states do. */
  implies?: string[];
  /** The frame's place on the definition's canvas, if moved. */
  x?: number;
  y?: number;
}

export interface ComponentDefinition {
  /** Stable, referenced by placements. */
  id: string;
  /** "Card", shown in the panel. */
  name: string;
  /** One sentence, for the AI generator and the panel. */
  description?: string;
  /** A full page: `appComponentTree` is the component, `canvasNodes` its frames. */
  page: PageSnapshotOut;
  /** The panel's order. */
  inputs: InputDefinition[];
  /** The cascade: a later state wins a tie. `primary` is implied, never listed. */
  states: StateDefinition[];
  /** A state id, for a page without its script. */
  noScriptState?: string;
}

// ---------- pointer states ----------

export type PointerStateKind = Exclude<StateKind, 'custom'>;

export const isPointerState = (state: Pick<StateDefinition, 'kind'>): state is StateDefinition & { kind: PointerStateKind } =>
  state.kind !== 'custom';

/** What each pointer state is in CSS, on the element that has it. Focus counts from inside too. */
export const POINTER_STATE_CSS: Readonly<Record<PointerStateKind, string>> = {
  hover: ':hover',
  pressed: ':active',
  focused: ':is(:focus-visible, :has(:focus-visible))',
};

/**
 * The attribute on a placement root that a compiled pointer state reads. The
 * contract named `data-fc-c`, but the rule parser refuses every `data-fc-` name as
 * renderer-owned (isPlatformMarker), and `data-u-c-` is the one stored family a rule
 * may read. Detach writes the same name with an empty value, so a plain copy never
 * matches a live placement's rules: they read the definition id as the value.
 */
export const placementMarker = (definitionId: string): string => `data-u-c-${definitionId.slice(0, 8).toLowerCase()}`;

/** `[data-u-c-xxxxxxxx="<definition id>"]`, what a compiled state is relative to. */
export const placementMarkerSelector = (definitionId: string): string =>
  `[${placementMarker(definitionId)}="${definitionId}"]`;

/** True when placements of this definition carry the marker. */
export const hasPointerState = (definition: Pick<ComponentDefinition, 'states'>): boolean =>
  (definition.states ?? []).some(isPointerState);

// ---------- custom states ----------

/** The state a placement starts in when it names none, or one its definition lacks. */
export const PRIMARY_STATE = 'primary';

/**
 * `S`: the behaviour state on a placement root that holds which custom state it is
 * in. Lower case, as behaviour state ids are, since an attribute name ignores case.
 */
export const customStateScope = (definitionId: string): string => `cs-${definitionId.slice(0, 8).toLowerCase()}`;

/** The custom states of a definition, in their order. */
export const customStatesOf = (definition: Pick<ComponentDefinition, 'states'>): StateDefinition[] =>
  (definition.states ?? []).filter(state => state.kind === 'custom');

/** The `choice` a definition's custom states compile to, or null when it has none. */
export function customStateChoice(definition: Pick<ComponentDefinition, 'id' | 'states'>, initial = PRIMARY_STATE) {
  const custom = customStatesOf(definition);
  if (custom.length === 0) return null;
  const options = [PRIMARY_STATE, ...custom.map(state => state.id)];
  return {
    id: customStateScope(definition.id),
    name: 'State',
    type: 'choice' as const,
    initial: options.includes(initial) ? initial : PRIMARY_STATE,
    options,
  };
}

/** A site's definitions by id, as `parseComponents` gives them. */
export type ComponentDefinitions = Record<string, ComponentDefinition>;

export interface RefusedDefinition {
  id: string;
  reason: string;
  /** Set when the definition is fine and one edit to it was undone instead. */
  edit?: boolean;
}

export interface ParsedComponents {
  definitions: ComponentDefinitions;
  refused: RefusedDefinition[];
}

// A compiled selector holding a name starting `fc-` is refused whole by parseSelector.
const DEFINITION_ID = /^(?!fc-)[A-Za-z0-9-]{1,64}$/i;
const STATE_ID = /^(?!fc[-_])[A-Za-z0-9_-]{1,64}$/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function holdsStickyBar(node: Record<string, unknown>): boolean {
  if (isStickyCta(node.props)) return true;
  const { children } = node;
  return Array.isArray(children) && children.some(child => isRecord(child) && holdsStickyBar(child));
}

/** Why a node, or anything under it, is not a component node, or null. */
function nodeShapeRefusal(node: unknown): string | null {
  if (!isRecord(node)) return 'every node in a definition is an object';
  if (typeof node.type !== 'string' || node.type.length === 0) return 'every node in a definition needs a type';
  const { children } = node;
  if (children === undefined) return null;
  if (!Array.isArray(children)) return 'a node\'s children are a list';
  for (const child of children) {
    const reason = nodeShapeRefusal(child);
    if (reason) return reason;
  }
  return null;
}

/** Why a tree cannot be a definition's: its root needs an element of its own. */
function treeRefusal(tree: unknown): string | null {
  if (!isRecord(tree)) return 'a definition needs a component tree';
  const { type } = tree;
  if (typeof type !== 'string' || type.length === 0) return 'a definition root needs a type';
  if (type.startsWith('#')) return 'a definition root is an element, not text or another placement';
  // One per page and page-level: a component placed twice would be two bars.
  const malformed = nodeShapeRefusal(tree);
  if (malformed) return malformed;
  if (holdsStickyBar(tree)) return 'a sticky bar is one per page, so a definition cannot hold it';
  return null;
}

/** Why a stored state cannot be used, or null. */
export function stateRefusal(state: unknown): string | null {
  if (!isRecord(state)) return 'a state is an object';
  const { id, name, kind, implies, x, y } = state;
  if (typeof id !== 'string' || !STATE_ID.test(id)) return 'a state id is letters, digits, dashes and underscores, and never starts fc-';
  if (id === 'primary') return 'primary is implied, never listed';
  if (typeof name !== 'string' || name.length === 0) return `state ${id} has no name`;
  if (!STATE_KINDS.includes(kind as StateKind)) return `state ${id} has an unknown kind`;
  if (implies !== undefined && !(Array.isArray(implies) && implies.every(entry => typeof entry === 'string'))) {
    return `state ${id}: implies is a list of state ids`;
  }
  if ([x, y].some(value => value !== undefined && typeof value !== 'number')) return `state ${id}: x and y are numbers`;
  return null;
}

function firstDuplicate(items: readonly { id: string }[]): string | undefined {
  const seen = new Set<string>();
  for (const { id } of items) {
    if (seen.has(id)) return id;
    seen.add(id);
  }
  return undefined;
}

function inputsRefusal(inputs: unknown): string | null {
  if (!Array.isArray(inputs)) return 'inputs is a list';
  if (inputs.length > COMPONENT_LIMITS.inputsPerDefinition) {
    return `a definition has at most ${COMPONENT_LIMITS.inputsPerDefinition} inputs`;
  }
  for (const input of inputs) {
    const reason = inputDefinitionRefusal(input);
    if (reason) return reason;
  }
  const duplicate = firstDuplicate(inputs as InputDefinition[]);
  return duplicate ? `input ${duplicate} appears twice` : null;
}

function statesRefusal(states: unknown, noScriptState: unknown): string | null {
  if (!Array.isArray(states)) return 'states is a list';
  if (states.length > COMPONENT_LIMITS.statesPerDefinition) {
    return `a definition has at most ${COMPONENT_LIMITS.statesPerDefinition} states`;
  }
  for (const state of states) {
    const reason = stateRefusal(state);
    if (reason) return reason;
  }
  const duplicate = firstDuplicate(states as StateDefinition[]);
  if (duplicate) return `state ${duplicate} appears twice`;
  if (noScriptState !== undefined && !(states as StateDefinition[]).some(state => state.id === noScriptState)) {
    return 'noScriptState names no state';
  }
  return null;
}

/** Why a stored definition cannot be used, or null when it can. */
function definitionRefusal(key: string, stored: unknown): string | null {
  if (!DEFINITION_ID.test(key)) return 'a definition id is letters, digits and dashes, and never starts fc-';
  if (!isRecord(stored)) return 'a definition is an object';
  if (stored.id !== key) return 'a definition is stored under its own id';
  if (typeof stored.name !== 'string' || stored.name.length === 0) return 'a definition has a name';
  if (stored.description !== undefined && typeof stored.description !== 'string') return 'a description is text';
  if (serializedBytes(stored) > COMPONENT_LIMITS.definitionBytes) {
    return `a definition is at most ${COMPONENT_LIMITS.definitionBytes} bytes`;
  }
  if (!isRecord(stored.page)) return 'a definition holds a page';
  return treeRefusal(stored.page.appComponentTree)
    ?? inputsRefusal(stored.inputs ?? [])
    ?? statesRefusal(stored.states ?? [], stored.noScriptState);
}

/**
 * The site's definitions from stored JSON. Each one has frames afterwards, or
 * D(P) would have nothing to map from. Beyond the site's limit, later ones are
 * refused. It reports what it refused and warns once per call.
 */
export function parseComponents(raw: unknown): ParsedComponents {
  const definitions: ComponentDefinitions = {};
  const refused: RefusedDefinition[] = [];
  let kept = 0;
  if (isRecord(raw)) {
    for (const [id, stored] of Object.entries(raw)) {
      const reason = kept >= COMPONENT_LIMITS.definitionsPerSite
        ? `a site has at most ${COMPONENT_LIMITS.definitionsPerSite} definitions`
        : definitionRefusal(id, stored);
      if (reason) {
        refused.push({ id, reason });
        continue;
      }
      const definition = stored as ComponentDefinition;
      kept += 1;
      const page = definition.page.id !== undefined ? withDefaultViewports(definition.page) : withDefaultViewports({ ...definition.page, id });
      // A definition that needs no repair stays the stored object itself, so an
      // adopted copy whose definition did not change reconciles as a no-op.
      definitions[id] = page === definition.page && definition.inputs && definition.states
        ? definition
        : { ...definition, page, inputs: definition.inputs ?? [], states: definition.states ?? [] };
    }
  }
  if (refused.length > 0) {
    console.warn(`parseComponents: skipped ${refused.length} definition(s)`, refused.slice(0, 10));
  }
  return { definitions, refused };
}

// ---------- nesting ----------

const treeOf = (definition: ComponentDefinition | undefined): unknown => definition?.page?.appComponentTree;

/** The definition ids a stored tree places directly, in document order. */
export function placedDefinitionIds(tree: unknown): string[] {
  const found: string[] = [];
  const visit = (node: unknown) => {
    if (!isRecord(node)) return;
    if (isPlacementType(node.type)) {
      const { component } = (node.props ?? {}) as { component?: unknown };
      if (typeof component === 'string') found.push(component);
    }
    if (Array.isArray(node.children)) node.children.forEach(visit);
  };
  visit(tree);
  return found;
}

/**
 * The chain of definition ids that placing `placedId` inside `targetId` would
 * close, target first and last, or null when it closes none.
 */
export function wouldCycle(definitions: ComponentDefinitions, targetId: string, placedId: string): string[] | null {
  const seen = new Set<string>();
  const visit = (id: string, path: readonly string[]): string[] | null => {
    if (id === targetId) return [...path, id];
    if (seen.has(id)) return null;
    seen.add(id);
    for (const next of placedDefinitionIds(treeOf(definitions[id]))) {
      const found = visit(next, [...path, id]);
      if (found) return found;
    }
    return null;
  };
  const found = visit(placedId, [targetId]);
  return found;
}

/** "Card contains Grid, which contains Card". */
export function cycleReason(definitions: ComponentDefinitions, path: readonly string[]): string {
  const names = path.map(id => definitions[id]?.name ?? id);
  const [first, second, ...rest] = names;
  return `${first} contains ${second}${rest.map(name => `, which contains ${name}`).join('')}.`;
}

/** How many definitions deep the longest chain below this one runs, itself included. */
function depthBelow(definitions: ComponentDefinitions, id: string, stack: readonly string[] = []): number {
  if (stack.includes(id) || !Object.hasOwn(definitions, id)) return 0;
  const below = [...new Set(placedDefinitionIds(treeOf(definitions[id])))].map(next => depthBelow(definitions, next, [...stack, id]));
  return 1 + Math.max(0, ...below);
}

/** How many definitions deep the longest chain above this one runs, itself included. */
function depthAbove(definitions: ComponentDefinitions, id: string, stack: readonly string[] = []): number {
  if (stack.includes(id)) return 0;
  const holders = Object.keys(definitions).filter(holder => placedDefinitionIds(treeOf(definitions[holder])).includes(id));
  return 1 + Math.max(0, ...holders.map(holder => depthAbove(definitions, holder, [...stack, id])));
}

/**
 * Why `placedId` cannot go inside `targetId`, a definition, or on a page when
 * undefined. Expansion checks again, since stored JSON can say anything.
 */
export function placementRefusal(
  definitions: ComponentDefinitions,
  targetId: string | undefined,
  placedId: string,
): string | null {
  if (!Object.hasOwn(definitions, placedId)) return 'That component no longer exists.';
  if (targetId === undefined) return null;
  const cycle = wouldCycle(definitions, targetId, placedId);
  if (cycle) return cycleReason(definitions, cycle);
  const depth = depthAbove(definitions, targetId) + depthBelow(definitions, placedId);
  return depth > COMPONENT_LIMITS.nestingDepth
    ? `Components nest at most ${COMPONENT_LIMITS.nestingDepth} deep, and this would make ${depth}.`
    : null;
}

// ---------- placing by content model ----------

// A browser's parser closes the outer element on these, so the tree would not
// stay what the editor shows.
const INTERACTIVE_TAGS: ReadonlySet<string> = new Set(['a', 'button', 'input', 'select', 'textarea', 'details', 'label', 'iframe', 'embed']);
const PHRASING_TAGS: ReadonlySet<string> = new Set([
  'a', 'abbr', 'audio', 'b', 'bdi', 'bdo', 'br', 'button', 'canvas', 'cite', 'code', 'data', 'dfn', 'em', 'i', 'img',
  'input', 'kbd', 'label', 'mark', 'picture', 'q', 's', 'samp', 'select', 'small', 'span', 'strong', 'sub', 'sup',
  'svg', 'textarea', 'time', 'u', 'var', 'video', 'wbr',
]);

function holdsInteractive(tree: unknown, definitions: ComponentDefinitions, stack: readonly string[] = []): boolean {
  if (!isRecord(tree)) return false;
  if (typeof tree.type === 'string' && INTERACTIVE_TAGS.has(tree.type)) return true;
  if (isPlacementType(tree.type)) {
    const { component } = (tree.props ?? {}) as { component?: unknown };
    if (typeof component !== 'string' || stack.includes(component)) return false;
    return holdsInteractive(treeOf(definitions[component]), definitions, [...stack, component]);
  }
  return Array.isArray(tree.children) && tree.children.some(child => holdsInteractive(child, definitions, stack));
}

/**
 * Why a placement of this definition may not sit inside these ancestors' tags, or
 * null. Reads the definition's root tag and whether it holds interactive content,
 * because the placement itself has no element for a drop to ask about.
 */
export function contentModelRefusal(
  definitions: ComponentDefinitions,
  definitionId: string,
  ancestorTags: readonly string[],
): string | null {
  const tree = treeOf(definitions[definitionId]);
  if (!isRecord(tree)) return null;
  const inside = ancestorTags.find(tag => tag === 'a' || tag === 'button');
  if (inside && holdsInteractive(tree, definitions, [definitionId])) {
    return `This component holds a link or a control, and a browser would move it out of the <${inside}>.`;
  }
  if (ancestorTags.includes('p') && !PHRASING_TAGS.has(String(tree.type))) {
    return `A browser would end the paragraph at this component's <${String(tree.type)}>.`;
  }
  return null;
}

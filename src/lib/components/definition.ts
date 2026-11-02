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
// docs/plans/2026-11-02-behaviour-model.md), so nothing here names a selector.
//
// Contract: docs/plans/2026-11-02-reusable-components.md.

import { withDefaultViewports } from '@/lib/canvas/defaultViewports';
import { isStickyCta } from '@/lib/stickyCta/stickyCta';
import { inputDefinitionRefusal, type InputDefinition } from './inputs';
import { COMPONENT_LIMITS } from './placement';
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

/** A site's definitions by id, as `parseComponents` gives them. */
export type ComponentDefinitions = Record<string, ComponentDefinition>;

export interface RefusedDefinition {
  id: string;
  reason: string;
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

/** Serialised size in bytes, which is what the render budget charges. */
export function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value) ?? '').length;
}

function holdsStickyBar(node: Record<string, unknown>): boolean {
  if (isStickyCta(node.props)) return true;
  const { children } = node;
  return Array.isArray(children) && children.some(child => isRecord(child) && holdsStickyBar(child));
}

/** Why a tree cannot be a definition's: its root needs an element of its own. */
function treeRefusal(tree: unknown): string | null {
  if (!isRecord(tree)) return 'a definition needs a component tree';
  const { type } = tree;
  if (typeof type !== 'string' || type.length === 0) return 'a definition root needs a type';
  if (type.startsWith('#')) return 'a definition root is an element, not text or another placement';
  // One per page and page-level: a component placed twice would be two bars.
  if (holdsStickyBar(tree)) return 'a sticky bar is one per page, so a definition cannot hold it';
  return null;
}

function stateRefusal(state: unknown): string | null {
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
      definitions[id] = {
        ...definition,
        page: withDefaultViewports({ ...definition.page, id: definition.page.id ?? id }),
        inputs: definition.inputs ?? [],
        states: definition.states ?? [],
      };
    }
  }
  if (refused.length > 0) {
    console.warn(`parseComponents: skipped ${refused.length} definition(s)`, refused.slice(0, 10));
  }
  return { definitions, refused };
}

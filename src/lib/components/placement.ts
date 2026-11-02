// src/lib/components/placement.ts
//
// A placement: one use of a reusable component on a page. It is a node with
// `type: '#component'`, holding only props, on the precedent of `#text` in
// src/lib/renderer/textNode.ts. A `#` type cannot be a tag, so a renderer that
// missed one would throw rather than draw an empty box, and each renderer checks
// it before its tag path. Expansion (expand.ts) replaces every placement with
// ordinary nodes before hydration, or with a `#missing` node when it cannot, so a
// Collection keeps its template and the page still serves.
//
// See docs/plans/2026-11-02-reusable-components.md.
//
// PURE: no React, no MST. Client and server safe.

export const PLACEMENT_TYPE = '#component';
export const MISSING_TYPE = '#missing';

/** True for a node that stands for a use of a definition. */
export function isPlacementType(type: unknown): boolean {
  return type === PLACEMENT_TYPE;
}

/** True for what is left of a placement that could not be expanded. */
export function isMissingType(type: unknown): boolean {
  return type === MISSING_TYPE;
}

/** True for a node no renderer may draw an element for. */
export function isComponentPlaceholderType(type: unknown): boolean {
  return isPlacementType(type) || isMissingType(type);
}

/** What a placement stores. A value from data sits in `node.bindings` under `input.<id>`. */
export interface PlacementProps {
  /** The definition id. */
  component: string;
  /** Input id to value; absent means the default. */
  inputs?: Record<string, unknown>;
  /** The initial state id; absent means primary. */
  state?: string;
  /** How it sits on the page, merged onto the definition's root per property and breakpoint. */
  style?: Record<string, unknown>;
  effects?: unknown;
  /** The Trigger field: `on` and `showWhen`, in the behaviour contract's format. Nothing else of behaviour. */
  behaviour?: { on?: unknown[]; showWhen?: unknown };
}

/**
 * The limits of the format. Stored JSON is opaque to the save route and all
 * tenants share one Node process, so the model refuses these and the render
 * step checks them again. See "Limits" in the contract.
 */
export const COMPONENT_LIMITS = {
  definitionsPerSite: 200,
  definitionBytes: 256 * 1024,
  inputsPerDefinition: 40,
  statesPerDefinition: 16,
  nestingDepth: 8,
  expandedNodesPerPage: 5_000,
  expandedBytesPerPage: 4 * 1024 * 1024,
} as const;

/** Serialised size in bytes, which is what the render budget charges. */
export function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value) ?? '').length;
}

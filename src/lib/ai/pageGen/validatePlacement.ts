// src/lib/ai/pageGen/validatePlacement.ts
//
// A placement of one of the site's own components in generated output, checked
// before it can reach a page (see "AI generation" in
// docs/plans/2026-11-02-reusable-components.md). The model writes
//
//   { "type": "#component", "name": "Card", "inputs": { "title": "Pricing" },
//     "state": "s1", "props": { "style": { ... } } }
//
// and gets back a stored placement, or nothing with the reason:
//
//   - The component must be one the site has, named by its name or its id.
//   - The placement must not close a cycle or nest past the limit when the
//     generation lands inside a definition, and a browser must not move it out of
//     what holds it (a component with a link inside a link). The route checks both
//     with the editor's own functions over skeleton definitions (summaries.ts).
//   - Each input value goes through `parseInputValue`, the one check every value
//     passes. An unknown input is dropped and reported, and so is a value the
//     input refuses. Only literal values: a binding is a person's to make. A
//     picture or a file comes from the site's own paths or stays the component's
//     default, because a generated address on another host is not the owner's.
//     An Event input holds no value, so the model cannot set one.
//   - `state` names a custom state of the component, or primary; anything else
//     is dropped and the placement starts in primary.
//   - Only `style` of `props` is kept: how it sits on the page. Its content is
//     the definition's, so children are dropped with a warning.
//
// PURE: no React, no MST. Client and server safe.

import { contentModelRefusal, placementRefusal, PRIMARY_STATE } from '@/lib/components/definition';
import { parseInputValue } from '@/lib/components/inputs';
import { PLACEMENT_TYPE } from '@/lib/components/placement';
import { skeletonDefinitions, summaryNamed, type GenerationComponents } from '@/lib/components/summaries';

/** The keys a placement may hold in generated output. */
export const PLACEMENT_KEYS: ReadonlySet<string> = new Set(['type', 'name', 'inputs', 'state', 'props', 'children', 'label']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** True for a generated node that is a placement. */
export const isPlacementInput = (raw: unknown): raw is Record<string, unknown> =>
  isRecord(raw) && typeof raw.type === 'string' && raw.type.trim() === PLACEMENT_TYPE;

/** An address a generated picture or file may hold: the site's own path. */
const isSitePath = (value: unknown): boolean =>
  typeof value === 'string' && value.startsWith('/') && !value.startsWith('//');

/** True when every address in this image, gallery or file value is the site's own. */
export function sitePathsOnly(type: string, value: unknown): boolean {
  if (type === 'file') return isSitePath(value);
  const srcOf = (entry: unknown) => (typeof entry === 'string' ? entry : isRecord(entry) ? entry.src : undefined);
  if (type === 'image') return isSitePath(srcOf(value));
  if (type === 'gallery') return Array.isArray(value) && value.every((entry) => isSitePath(srcOf(entry)));
  return true;
}

export interface PlacementCheck {
  /** The stored props, or null when the placement is dropped. */
  props: { component: string; inputs?: Record<string, unknown>; state?: string } | null;
  /** The definition's name, for the node's label. */
  name?: string;
  /** Raw `props.style`, for the generator's own style check. */
  style?: unknown;
  warnings: string[];
}

/**
 * One generated placement. `ancestorTags` are the tags above it in the generated
 * tree, nearest first, ahead of those above the insertion point.
 */
export function checkPlacement(raw: Record<string, unknown>, components: GenerationComponents | undefined, ancestorTags: readonly string[]): PlacementCheck {
  const warnings: string[] = [];
  const drop = (reason: string): PlacementCheck => ({ props: null, warnings: [...warnings, reason] });
  for (const key of Object.keys(raw)) {
    if (!PLACEMENT_KEYS.has(key)) warnings.push(`unknown key "${key}" on a placement ignored`);
  }
  if (!components || components.summaries.length === 0) return drop('this site has no components to place, placement dropped');
  const name = typeof raw.name === 'string' ? raw.name : '';
  const summary = name ? summaryNamed(components.summaries, name) : undefined;
  if (!summary) return drop(`the site has no component named ${JSON.stringify(name)}, placement dropped`);

  const definitions = skeletonDefinitions(components.summaries);
  const refusal = placementRefusal(definitions, components.insideDefinition, summary.id)
    ?? contentModelRefusal(definitions, summary.id, [...ancestorTags, ...(components.ancestorTags ?? [])]);
  if (refusal) return drop(`${summary.name} cannot go here: ${refusal} Placement dropped`);

  if (Array.isArray(raw.children) && raw.children.length > 0) {
    warnings.push(`a placement shows its component's content, ${raw.children.length} children dropped`);
  }

  const inputs: Record<string, unknown> = {};
  if (raw.inputs !== undefined && !isRecord(raw.inputs)) warnings.push('inputs must be an object, ignored');
  for (const [id, value] of Object.entries(isRecord(raw.inputs) ? raw.inputs : {})) {
    const input = summary.inputs.find((candidate) => candidate.id === id)
      ?? summary.inputs.find((candidate) => candidate.name.toLowerCase() === id.toLowerCase());
    if (!input) {
      warnings.push(`${summary.name} has no input "${id}", dropped`);
      continue;
    }
    const parsed = parseInputValue(input, value);
    if (!parsed.ok) {
      warnings.push(`${summary.name} input "${input.name}" dropped: ${parsed.reason}`);
      continue;
    }
    if (!sitePathsOnly(input.type, value)) {
      warnings.push(`${summary.name} input "${input.name}" dropped: a picture or a file comes from the site, so the component's default stays`);
      continue;
    }
    // The value as written: the stored form, which hydration parses again.
    inputs[input.id] = value;
  }

  let state: string | undefined;
  if (raw.state !== undefined && raw.state !== PRIMARY_STATE) {
    const named = typeof raw.state === 'string'
      ? summary.states.find((candidate) => candidate.kind === 'custom' && (candidate.id === raw.state || candidate.name.toLowerCase() === String(raw.state).toLowerCase()))
      : undefined;
    if (named) state = named.id;
    else warnings.push(`${summary.name} has no state ${JSON.stringify(raw.state)} to start in, it starts in primary`);
  }

  const props = isRecord(raw.props) ? raw.props : {};
  for (const key of Object.keys(props)) {
    if (key !== 'style') warnings.push(`prop "${key}" is not allowed on a placement, dropped`);
  }

  return {
    props: { component: summary.id, ...(Object.keys(inputs).length > 0 ? { inputs } : {}), ...(state ? { state } : {}) },
    name: summary.name,
    ...(props.style !== undefined ? { style: props.style } : {}),
    warnings,
  };
}

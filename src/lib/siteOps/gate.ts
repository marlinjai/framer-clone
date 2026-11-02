// src/lib/siteOps/gate.ts
//
// The render gate (src/lib/renderer/blockedNodes.ts), asked BEFORE a write rather
// than at render: both renderers drop a blocked tag or prop silently, which is
// right for stored rows and wrong for a write path that promises "rejected, never
// silently dropped". Each node a batch created or changed is checked with the
// renderers' own rules, in the namespace it stands in (svg and math children are
// judged as such), and anything a renderer would drop refuses the batch.
//
// Not checked here: `style`, whose responsive maps the renderers resolve first and
// whose values passed the generator's style rules on the way in, and the node
// settings the renderers read off the node instead of rendering (isSettingsProp).

import { contentBelow, isBlockedProp, isBlockedTag, isSettingsProp, type ForeignContent } from '@/lib/renderer/blockedNodes';
import { TEXT_NODE_TYPE } from '@/lib/renderer/textNode';

export interface GateNode {
  id: string;
  type: string;
  props?: Record<string, unknown> | null;
  children?: readonly GateNode[];
}

/** Props the renderers handle themselves, never as attributes. */
const OWN_PROPS: ReadonlySet<string> = new Set(['style', 'children']);

/** Why this node or something inside it would not render as stored, or null. */
export function renderGateProblem(node: GateNode, foreign: ForeignContent = false): string | null {
  if (node.type === TEXT_NODE_TYPE) return null;
  if (isBlockedTag(node.type, foreign)) return `<${node.type}> is not rendered here (node ${node.id})`;
  for (const [name, value] of Object.entries(node.props ?? {})) {
    if (OWN_PROPS.has(name) || isSettingsProp(name)) continue;
    if (isBlockedProp(name, value)) return `the prop ${JSON.stringify(name)} is not rendered (node ${node.id})`;
  }
  const below = contentBelow(node.type, foreign);
  for (const child of node.children ?? []) {
    const problem = renderGateProblem(child, below);
    if (problem) return problem;
  }
  return null;
}

/** The namespace a node stands in, from its ancestors' tags, outermost first. */
export function foreignContentOf(ancestorTypes: readonly string[]): ForeignContent {
  let foreign: ForeignContent = false;
  for (const type of ancestorTypes) foreign = contentBelow(type, foreign);
  return foreign;
}

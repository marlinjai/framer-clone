// src/lib/siteOps/gate.ts
//
// The render gate (src/lib/renderer/blockedNodes.ts), asked BEFORE a write rather
// than at render: both renderers drop a blocked tag or prop silently, which is
// right for stored rows and wrong for a write path that promises "rejected, never
// silently dropped". Each node a batch created or changed is checked with the
// renderers' own rules, in the namespace it stands in (svg and math children are
// judged as such), and anything a renderer would drop refuses the batch.
//
// A placement (`#component`) is the one node no renderer draws: expansion
// (src/lib/components/expand.ts) replaces it with its definition's tree before any
// renderer runs. So the gate judges that tree where the placement stands, and
// refuses a placement expansion would leave empty. Not checked: the page's render
// budget, which checkBeforePublish reports for the page as a whole.
//
// Not checked here: `style`, whose responsive maps the renderers resolve first and
// whose values passed the generator's style rules on the way in, and the node
// settings the renderers read off the node instead of rendering (isSettingsProp).

import type { ComponentDefinitions } from '@/lib/components/definition';
import { COMPONENT_LIMITS, isPlacementType, serializedBytes, type PlacementProps } from '@/lib/components/placement';
import { REPEAT_PROP, withoutRepeat } from '@/lib/components/repeat';
import { isFxSceneProp } from '@/lib/fxScene/marker';
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

/** What a placement stores: PlacementProps, and the marker of one repeated for a list. */
const PLACEMENT_PROPS: ReadonlySet<string> = new Set<keyof PlacementProps | typeof REPEAT_PROP>([
  'component', 'inputs', 'state', 'style', 'effects', 'behaviour', REPEAT_PROP,
]);

/** One check's view of the site's definitions. */
interface Placements {
  definitions: ComponentDefinitions;
  /** The definitions open around the node, outermost first. */
  open: readonly string[];
  /** Definitions found sound, by id, namespace and depth: nested placements repeat them without bound. */
  sound: Set<string>;
}

/**
 * Why this node or something inside it would not render as stored, or null.
 * `definitions` are the site's: without them every placement is refused.
 */
export function renderGateProblem(node: GateNode, foreign: ForeignContent = false, definitions: ComponentDefinitions = {}): string | null {
  return nodeProblem(node, foreign, { definitions, open: [], sound: new Set() });
}

function placementProblem(node: GateNode, foreign: ForeignContent, placements: Placements): string | null {
  const { definitions, open, sound } = placements;
  if (node.children?.length) return `a component placement holds no children (node ${node.id})`;
  const unknown = Object.keys(node.props ?? {}).find((name) => !PLACEMENT_PROPS.has(name));
  if (unknown !== undefined) return `the prop ${JSON.stringify(unknown)} is not rendered (node ${node.id})`;
  const id = node.props?.component;
  if (typeof id !== 'string' || !Object.hasOwn(definitions, id)) {
    return `the component ${JSON.stringify(id ?? null)} is not one of this site's components (node ${node.id})`;
  }
  const definition = definitions[id];
  const named = `component ${JSON.stringify(definition.name)}`;
  if (open.includes(id)) return `${named} contains itself (node ${node.id})`;
  if (open.length >= COMPONENT_LIMITS.nestingDepth) return `components nest more than ${COMPONENT_LIMITS.nestingDepth} deep (node ${node.id})`;
  const key = JSON.stringify([id, foreign, open.length]);
  if (sound.has(key)) return null;
  const tree = definition.page?.appComponentTree as GateNode | undefined;
  if (!tree || typeof tree.type !== 'string' || tree.type.startsWith('#') || serializedBytes(definition) > COMPONENT_LIMITS.definitionBytes) {
    return `${named} cannot be rendered (node ${node.id})`;
  }
  // As expansion opens it: the root of a definition never repeats.
  const problem = nodeProblem(withoutRepeat(tree as never) as unknown as GateNode, foreign, { definitions, open: [...open, id], sound });
  if (problem) return `in ${named}, placed by node ${node.id}: ${problem}`;
  sound.add(key);
  return null;
}

function nodeProblem(node: GateNode, foreign: ForeignContent, placements: Placements): string | null {
  if (node.type === TEXT_NODE_TYPE) return null;
  if (isPlacementType(node.type)) return placementProblem(node, foreign, placements);
  if (isBlockedTag(node.type, foreign)) return `<${node.type}> is not rendered here (node ${node.id})`;
  for (const [name, value] of Object.entries(node.props ?? {})) {
    if (OWN_PROPS.has(name) || isSettingsProp(name) || isFxSceneProp(name, node.type)) continue;
    if (isBlockedProp(name, value)) return `the prop ${JSON.stringify(name)} is not rendered (node ${node.id})`;
  }
  const below = contentBelow(node.type, foreign);
  for (const child of node.children ?? []) {
    const problem = nodeProblem(child, below, placements);
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
// ci-replay touch

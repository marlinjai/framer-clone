// Layer 2 inside the pipeline: the classes layer 1 collected go through Tailwind, what came
// of them lands on the nodes, and every line Tailwind wrote becomes a ledger line at the
// place in the source it is about. A class attribute is claimed only now, with what became
// of it, so it never reads "converted" while one of its classes is left.
//
// A Tailwind line can carry the class or the parser's reason, which are source. They go
// into the excerpt, which the ledger keeps only where excerpts are kept, and never into
// a detail, which is fixed text and can travel.
//
// The contract is docs/plans/2026-11-02-react-import.md, "Layer 2: Tailwind".

import type ts from 'typescript';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import type { ImportBudget } from './budget';
import type { ClassAttribute } from './jsx';
import type { Claim, Ledger, Position } from './ledger';
import type { Disposition } from './report';
import { convertClasses, type ConvertedNode, type ElementClasses, type TailwindLine } from './tailwind';
import type { BreakpointIds } from './tailwind/breakpoints';

export interface ClassLayerInput {
  root: ComponentNode;
  classes: readonly ClassAttribute[];
  elements: ReadonlyMap<string, ts.Node>;
  /** The file the elements are in. Trees here carry no parent pointers, so a node cannot name its file. */
  source: ts.SourceFile;
  /** The stylesheet read for tokens, as data. */
  sheet?: { name: string; text: string };
  ledger: Ledger;
  budget: ImportBudget;
  breakpoints?: BreakpointIds;
  systemDark?: boolean;
}

/** Each node of a tree by its key. */
function nodesByKey(root: ComponentNode): Map<string, ComponentNode> {
  const found = new Map<string, ComponentNode>();
  const waiting = [root];
  while (waiting.length > 0) {
    const node = waiting.pop() as ComponentNode;
    if (typeof node.id === 'string') found.set(node.id, node);
    for (const child of node.children ?? []) if (typeof child === 'object' && child !== null) waiting.push(child);
  }
  return found;
}

/** What layer 2 made of a node, on the node. Inline `style` beats a utility in the original, so it wins here. */
function apply(node: ComponentNode, converted: ConvertedNode): void {
  const props = (node.props ?? {}) as Record<string, unknown>;
  if (converted.style) {
    const inline = props.style !== null && typeof props.style === 'object' ? (props.style as Record<string, unknown>) : {};
    props.style = { ...converted.style, ...inline };
  }
  if (converted.rules) props.rules = converted.rules;
  if (converted.className) props.className = converted.className;
  node.props = props as ComponentNode['props'];
}

const RANK: Readonly<Record<Disposition, number>> = { converted: 0, rebuilt: 1, adapted: 2, left: 3 };

/** The class, and why the parser refused it, as one excerpt. Source, so only an excerpt holds it. */
const excerptOf = ({ source, reason }: TailwindLine): string | undefined =>
  source === undefined ? reason : reason === undefined ? source : `${source}: ${reason}`;

/** Runs layer 2 over what layer 1 collected, and claims each class attribute with what became of it. */
export async function applyClasses(input: ClassLayerInput): Promise<void> {
  const { root, classes, elements, source, sheet, ledger, budget } = input;
  const rootKey = typeof root.id === 'string' ? root.id : '';
  const elementsIn: ElementClasses[] = classes.map(({ key, parent, classes: tokens, merged, dynamic }) => ({
    key, classes: tokens, merged, ...(parent === undefined ? {} : { parent }), ...(dynamic ? { dynamic } : {}),
  }));
  const result = await convertClasses({
    elements: elementsIn,
    rootKey,
    ...(sheet ? { stylesheet: sheet.text } : {}),
    budget,
    ...(input.systemDark ? { systemDark: true } : {}),
    ...(input.breakpoints ? { breakpoints: input.breakpoints } : {}),
  });

  const byKey = nodesByKey(root);
  for (const [key, converted] of result.nodes) {
    const node = byKey.get(key);
    if (node) apply(node, converted);
  }

  const attributes = new Map(classes.map((each) => [each.key, each]));
  /** Where a line about a node stands: its class attribute, or its element, or the first line of the sheet. */
  const positionOf = (line: TailwindLine): Position => {
    if (line.line !== undefined && sheet) return { file: sheet.name, line: line.line };
    const attribute = line.nodeKey === undefined ? undefined : attributes.get(line.nodeKey);
    if (attribute) return { source: attribute.source, node: attribute.attribute };
    const element = line.nodeKey === undefined ? undefined : elements.get(line.nodeKey);
    if (element) return { source, node: element };
    return { file: sheet?.name ?? '', line: 1 };
  };

  const worst = new Map<string, Disposition>();
  for (const line of result.lines) {
    // The attribute's own claim below says this for the element as a whole.
    if (line.detail === 'classConverted' && line.disposition === 'converted') continue;
    const claim: Claim = { kind: line.kind, disposition: line.disposition, detail: line.detail, next: line.next, ...(line.nodeKey === undefined ? {} : { nodeKey: line.nodeKey }) };
    ledger.note(positionOf(line), claim, excerptOf(line));
    if (line.nodeKey !== undefined && line.line === undefined) {
      const before = worst.get(line.nodeKey) ?? 'converted';
      if (RANK[line.disposition] > RANK[before]) worst.set(line.nodeKey, line.disposition);
    }
  }

  const helpers = new Set(classes.flatMap((each) => [...each.helpers]));
  for (const { helper, declaration } of helpers) {
    ledger.claimSubtree(source, declaration, helper.assumed
      ? { kind: 'import', disposition: 'adapted', detail: 'cnAssumed', next: ['accept'] }
      : { kind: 'import', disposition: 'converted', detail: 'classHelper' });
  }

  for (const attribute of classes) {
    const disposition = worst.get(attribute.key) ?? 'converted';
    const detail = disposition === 'left' ? 'classesLeft' : disposition === 'adapted' ? 'classesAdapted' : 'classConverted';
    ledger.claimSubtree(attribute.source, attribute.attribute, {
      kind: 'class', disposition, detail, nodeKey: attribute.key, ...(disposition === 'converted' ? {} : { next: ['accept', 'rewrite'] }),
    });
  }
}

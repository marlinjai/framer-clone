// applyResponsiveStyles: moves a published page's responsive styles out of the
// inline `style` and into one per-page stylesheet.
//
// Runs on the HYDRATED tree (after hydrateBindings, before renderComponentNode),
// so the rewritten props are what both the server walk and the client commerce
// islands (CommerceIsland -> nodeDomProps) receive: every node renders its class
// and no responsive map ever reaches an inline style.
//
// Per node:
//   - A node whose style holds at least one responsive map gets a stable class
//     (`fc-<id>`, merged into an existing className) and ALL of its styles move
//     into that class's rule, in stored order. Moving only the responsive ones
//     would let a plain inline `padding` beat a responsive `paddingTop` (inline
//     always wins), which the editor's single inline style never does.
//   - A node with only plain style values keeps its inline style unchanged.
//   - A responsive map on a top-level prop that is not `style` (an attribute)
//     resolves to the largest breakpoint's value: an attribute cannot change
//     with the viewport width without client code.
//
// hydrateBindings clones a template subtree per collection row, so one id can
// appear many times. Identical rules share one class; a different rule under
// the same id gets a numbered class, in walk order, so output is deterministic.
//
// PURE: no React, no MST, no server-only.

import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { largestFirst, resolveCascade, isResponsiveMap, type BreakpointRef } from '@/lib/responsive/cascade';
import {
  buildResponsiveCss,
  isStyleMap,
  type DroppedDeclaration,
  type ResponsiveRuleInput,
} from '@/lib/responsive/responsiveCss';

export interface ResponsiveStylesResult {
  /** The tree with responsive styles replaced by classes (a new tree; the input is not mutated). */
  root: ComponentNode;
  /** The page's stylesheet text, or '' when no node has a responsive style. */
  css: string;
}

/** An id reduced to class-name-safe characters. */
function classStem(id: string | undefined): string | null {
  if (typeof id !== 'string' || id.length === 0) return null;
  return id.replace(/[^A-Za-z0-9_-]/g, '_');
}

function hasResponsiveStyle(style: Record<string, unknown>): boolean {
  return Object.values(style).some(isStyleMap);
}

/**
 * Rewrite the tree and build its stylesheet. `breakpoints` are the page's
 * viewport breakpoints (from the snapshot's canvas nodes); with none, a map's
 * `base` still applies everywhere and no media queries are emitted.
 */
export function applyResponsiveStyles(
  root: ComponentNode,
  breakpoints: readonly BreakpointRef[],
): ResponsiveStylesResult {
  const breakpointIds = new Set(breakpoints.map(b => b.id));
  const primaryId = largestFirst(breakpoints)[0]?.id;
  const rules: ResponsiveRuleInput[] = [];
  /** className -> the serialized style it was issued for (dedupe of cloned rows). */
  const issued = new Map<string, string>();
  /** stem -> the classes issued under it, in order. */
  const byStem = new Map<string, string[]>();
  let anonymous = 0;

  const classFor = (node: ComponentNode, style: Record<string, unknown>): string => {
    const stem = classStem(node.id) ?? `anon-${++anonymous}`;
    const signature = JSON.stringify(style);
    const existing = byStem.get(stem) ?? [];
    for (const name of existing) {
      if (issued.get(name) === signature) return name;
    }
    let name = existing.length === 0 ? `fc-${stem}` : `fc-${stem}--${existing.length + 1}`;
    // A real id may itself look like a suffixed or anonymous stem: never reuse a taken name.
    while (issued.has(name)) name = `${name}_`;
    issued.set(name, signature);
    byStem.set(stem, [...existing, name]);
    rules.push({ className: name, style });
    return name;
  };

  const visit = (node: ComponentNode): ComponentNode => {
    const next: ComponentNode = { ...node };
    if (node.props) {
      const props: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(node.props as Record<string, unknown>)) {
        if (name === 'style' || name === 'children') {
          props[name] = value;
          continue;
        }
        if (isResponsiveMap(value, breakpointIds)) {
          const resolved = resolveCascade(value, primaryId, breakpoints).value;
          if (resolved !== undefined) props[name] = resolved;
          continue;
        }
        props[name] = value;
      }
      const style = props.style;
      if (isStyleMap(style) && hasResponsiveStyle(style)) {
        const className = classFor(node, style);
        delete props.style;
        const existing = typeof props.className === 'string' ? props.className.trim() : '';
        props.className = existing ? `${existing} ${className}` : className;
      }
      next.props = props as ComponentNode['props'];
    }
    if (node.children) next.children = node.children.map(visit);
    return next;
  };

  const rewritten = visit(root);

  const dropped: DroppedDeclaration[] = [];
  const css = buildResponsiveCss(rules, breakpoints, { onDrop: d => dropped.push(d) });
  if (dropped.length > 0) {
    // One line per page, never one per declaration: a stored value that could
    // break out of its CSS rule is a data problem to fix in the editor, and the
    // page still serves without it.
    console.warn(
      `applyResponsiveStyles: dropped ${dropped.length} unsafe style declaration(s) from the published stylesheet`,
      dropped.slice(0, 10),
    );
  }
  return { root: rewritten, css };
}

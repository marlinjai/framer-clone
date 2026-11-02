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
//     (`fc-<id>`, merged into an existing className) and its styles move into
//     that class's rule, in stored order. Moving only the responsive ones would
//     let a plain inline `padding` beat a responsive `paddingTop` (inline always
//     wins), which the editor's single inline style never does.
//   - A node with an authored rule (`props.rules`, src/lib/rules/rules.ts) moves
//     its styles the same way, because inline beats any selector. So does every
//     element under a rule that reaches inside its node, such as `&:hover h2`.
//     Its rules go on a second class, `fc_r-<id>`, keyed on the rules alone, so
//     rows that differ only in a bound value share one rule block. A preset or a
//     definition is not an authored rule here and moves nothing.
//   - On a move a rule caused, a declaration the sheet refuses stays inline,
//     alone, and is reported, so a rule never costs a value. A map keeps its
//     largest value there and loses its breakpoints, which the report names. A
//     node that is only responsive is not newly authored, so it stays as it has
//     always been: the refused value is dropped, reported, and the overrides stay.
//   - A node with only plain style values keeps its inline style unchanged.
//   - A responsive map on a top-level prop that is not `style` (an attribute)
//     resolves to the largest breakpoint's value: an attribute cannot change
//     with the viewport width without client code.
//
// This is the trust boundary for `props.rules`. Save and publish keep a page as
// opaque JSON, so every stored rule goes through the parser here, a refused rule
// is dropped whole and reported, and `props.rules` never leaves this step. A
// `rules` that is not a list is the legacy `<table>` attribute and stays.
//
// A rule makes a request conditional, so on a page with an authored rule a custom
// property holding an external address is dropped on every node: a rule could
// reach it through `var()`.
//
// `fc-` and `fc_` names belong to this step, so a stored className cannot hold one:
// it would take another node's styles, a step sideways out of that node.
//
// hydrateBindings clones a template subtree per collection row, so one id can
// appear many times. Identical rules share one class; a different rule under
// the same id gets a numbered class, in walk order, so output is deterministic.
// Placements of one definition have distinct ids and a shared `classKey`, which
// is what a class is keyed on, so twelve cards share their CSS the same way.
//
// PURE: no React, no MST, no server-only.

import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { largestFirst, resolveCascade, isResponsiveMap, type BreakpointRef } from '@/lib/responsive/cascade';
import {
  buildResponsiveCss,
  cssValueText,
  isStyleMap,
  unsafeDeclaration,
  type AuthoredRulesInput,
  type DroppedDeclaration,
  type DroppedRule,
  type ResponsiveRuleInput,
} from '@/lib/responsive/responsiveCss';
import { isTextNodeType } from '@/lib/renderer/textNode';
import {
  hasExternalAddress,
  isRuleList,
  reachesInsideNode,
  readRules,
  type ParsedSelectorRule,
  type ReadRules,
} from '@/lib/rules/rules';

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

/** True when a style value, or any value of its map, could give a rule an external address. */
function holdsExternalAddress(value: unknown): boolean {
  return isStyleMap(value) ? Object.values(value).some(hasExternalAddress) : hasExternalAddress(value);
}

/** A stored className without any name this step issues. Anything else is left exactly as stored. */
function withoutIssuedClasses(className: string): string {
  if (!/(?:^|\s)fc[-_]/i.test(className)) return className;
  return className.split(/\s+/).filter(name => name.length > 0 && !/^fc[-_]/i.test(name)).join(' ');
}

/** A problem with a rule or a custom property, for the page's one warning. */
interface RuleProblem {
  node: string;
  rule?: string;
  property?: string;
  reason: string;
}

const EXTERNAL_VARIABLE = 'a custom property cannot hold an external address on a page with rules';

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
  const authored: AuthoredRulesInput[] = [];
  /** className -> the serialized input it was issued for (dedupe of cloned rows). */
  const issued = new Map<string, string>();
  /** `fc-<stem>` or `fc_r-<stem>` -> the classes issued under it, in order. */
  const byStem = new Map<string, string[]>();
  const kept: DroppedDeclaration[] = [];
  const problems: RuleProblem[] = [];
  /** Rows repeat one list, so a page parses each distinct list once. */
  const parsed = new Map<string, ReadRules>();
  let anonymous = 0;

  /** A class for this input: the one already issued for it, or the next free name. */
  const issueClass = (prefix: string, stem: string, signature: string): { name: string; isNew: boolean } => {
    const first = `${prefix}${stem}`;
    const existing = byStem.get(first) ?? [];
    for (const name of existing) {
      if (issued.get(name) === signature) return { name, isNew: false };
    }
    let name = existing.length === 0 ? first : `${first}--${existing.length + 1}`;
    // A real id may itself look like a suffixed or anonymous stem: never reuse a taken name.
    while (issued.has(name)) name = `${name}_`;
    issued.set(name, signature);
    byStem.set(first, [...existing, name]);
    return { name, isNew: true };
  };

  const classFor = (node: ComponentNode, style: Record<string, unknown>): string => {
    const stem = classStem(node.classKey ?? node.id) ?? `anon-${++anonymous}`;
    const { name, isNew } = issueClass('fc-', stem, JSON.stringify(style));
    if (isNew) rules.push({ className: name, style });
    return name;
  };

  /** Keyed on the rules alone, so a node without an id still shares a block by what it holds. */
  const ruleClassFor = (node: ComponentNode, selectorRules: ParsedSelectorRule[]): string => {
    const { name, isNew } = issueClass('fc_r-', classStem(node.classKey ?? node.id) ?? 'anon', JSON.stringify(selectorRules));
    if (isNew) authored.push({ className: name, rules: selectorRules });
    return name;
  };

  const readNode = (node: ComponentNode): ReadRules | null => {
    const stored = (node.props as Record<string, unknown> | undefined)?.rules;
    if (!isRuleList(stored) || isTextNodeType(node.type)) return null;
    const signature = JSON.stringify(stored);
    let read = parsed.get(signature);
    if (!read) {
      read = readRules({ rules: stored });
      parsed.set(signature, read);
      for (const { index, reason, rule } of read.refused) {
        const id = (rule as { id?: unknown } | null)?.id;
        problems.push({ node: node.id ?? 'unnamed', rule: typeof id === 'string' ? id : `#${index}`, reason });
      }
    }
    return read;
  };

  const pageHasRule = (node: ComponentNode): boolean =>
    (readNode(node)?.rules.length ?? 0) > 0 || (node.children ?? []).some(pageHasRule);

  const withoutExternalVariables = (node: ComponentNode, style: Record<string, unknown>): Record<string, unknown> => {
    const refused = Object.keys(style).filter(key => key.startsWith('--') && holdsExternalAddress(style[key]));
    if (refused.length === 0) return style;
    const clean = { ...style };
    for (const key of refused) {
      delete clean[key];
      problems.push({ node: node.id ?? 'unnamed', property: key, reason: EXTERNAL_VARIABLE });
    }
    return clean;
  };

  /** A style split into what the sheet can hold and what has to stay inline. */
  const splitForSheet = (style: Record<string, unknown>): { sheet: Record<string, unknown>; inline: Record<string, unknown> } => {
    const inline: Record<string, unknown> = {};
    for (const [key, stored] of Object.entries(style)) {
      const value = isStyleMap(stored) ? resolveCascade(stored, primaryId, breakpoints).value : stored;
      if (unsafeDeclaration(key, cssValueText(key, value))) inline[key] = value;
    }
    if (Object.keys(inline).length === 0) return { sheet: style, inline };
    return { sheet: Object.fromEntries(Object.entries(style).filter(([key]) => !(key in inline))), inline };
  };

  const hasRules = pageHasRule(root);

  const visit = (node: ComponentNode, insideReachingRule: boolean): ComponentNode => {
    const next: ComponentNode = { ...node };
    const read = readNode(node);
    const selectorRules = (read?.rules ?? []).filter((rule): rule is ParsedSelectorRule => rule.kind === 'selector');
    const reaches = selectorRules.some(rule => rule.parts.some(reachesInsideNode));
    if (node.props) {
      const props: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(node.props as Record<string, unknown>)) {
        if (name === 'rules' && isRuleList(value)) {
          // The model refuses this, so it can only arrive by hand or by import.
          if (value.length > 0 && isTextNodeType(node.type)) {
            problems.push({ node: node.id ?? 'unnamed', reason: 'text has no element of its own, so it holds no rules' });
          }
          continue;
        }
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
      if (typeof props.className === 'string') {
        const className = withoutIssuedClasses(props.className);
        if (className) props.className = className;
        else delete props.className;
      }
      const classes: string[] = [];
      const stored = props.style;
      if (isStyleMap(stored)) {
        const style = hasRules ? withoutExternalVariables(node, stored) : stored;
        const emptied = style !== stored && Object.keys(style).length === 0;
        if (emptied) delete props.style;
        else props.style = style;
        const inReach = insideReachingRule && !isTextNodeType(node.type);
        const causedByRule = selectorRules.length > 0 || inReach;
        if (hasResponsiveStyle(style) || causedByRule) {
          const { sheet, inline } = causedByRule ? splitForSheet(style) : { sheet: style, inline: {} };
          const className = Object.keys(sheet).length > 0 ? classFor(node, sheet) : undefined;
          if (className) classes.push(className);
          for (const [key, value] of Object.entries(inline)) {
            const map = style[key];
            const lost = isStyleMap(map) ? Object.keys(map).filter(id => id !== 'base') : [];
            kept.push({
              className: className ?? `fc-${classStem(node.classKey ?? node.id) ?? 'anon'}`,
              property: key,
              reason: unsafeDeclaration(key, cssValueText(key, value)) ?? 'unsafe-value',
              ...(lost.length > 0 ? { lostBreakpoints: lost } : {}),
            });
          }
          if (Object.keys(inline).length > 0) props.style = inline;
          else delete props.style;
        }
      }
      if (selectorRules.length > 0) classes.push(ruleClassFor(node, selectorRules));
      if (classes.length > 0) {
        const existing = typeof props.className === 'string' ? props.className.trim() : '';
        props.className = [...(existing ? [existing] : []), ...classes].join(' ');
      }
      next.props = props as ComponentNode['props'];
    }
    if (node.children) next.children = node.children.map(child => visit(child, insideReachingRule || reaches));
    return next;
  };

  const rewritten = visit(root, false);

  const dropped: DroppedDeclaration[] = [];
  const css = buildResponsiveCss(rules, breakpoints, {
    onDrop: d => dropped.push(d),
    authored,
    onDropRule: ({ className, ruleId, reason }: DroppedRule) => problems.push({ node: className, rule: ruleId, reason }),
  });
  if (dropped.length + kept.length + problems.length > 0) {
    // One line per page, never one per declaration: a stored value that could
    // break out of its CSS rule is a data problem to fix in the editor, and the
    // page still serves without it. A bad rule never blocks a publish either.
    const said = [
      ...(dropped.length > 0 ? [`dropped ${dropped.length} unsafe style declaration(s) from the published stylesheet`] : []),
      ...(kept.length > 0 ? [`left ${kept.length} style declaration(s) the stylesheet refuses inline`] : []),
      ...(problems.length > 0 ? [`left out ${problems.length} rule(s) or custom properties`] : []),
    ];
    console.warn(
      `applyResponsiveStyles: ${said.join(', ')}`,
      [...kept, ...dropped].slice(0, 10),
      ...(problems.length > 0 ? [problems.slice(0, 10)] : []),
    );
  }
  return { root: rewritten, css };
}

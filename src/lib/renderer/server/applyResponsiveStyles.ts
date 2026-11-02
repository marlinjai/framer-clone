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
//   - A hover preset (the mark applyEffects leaves on a node) adds its shared class,
//     `fc_fx-<kind>`, and moves nothing. Each kind used is emitted once.
//   - A definition (`@keyframes`, `@font-face`, ...) is global to the page, whichever
//     node holds it. Identical ones dedupe, so 500 cloned rows emit one. A different
//     one with the same identity (definitionIdentity in rules.ts) is a clash: the
//     first in walk order wins and the rest are reported. Regular and Bold of one
//     family differ in identity, so both stay.
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
// reach it through `var()`. So is an inline `field-sizing`, which would beat
// FIELD_SIZING_GUARD, the line such a page's sheet ends with: a control sized by
// its text is a width a rule can read.
//
// A rule on `:root` applies to the document, so the page root is the only node that
// may hold one, and it asks for no class and moves no style: the root node is not
// its subject. Such a node still makes this a page with a rule, for everything above.
//
// `fc-` and `fc_` names belong to this step, so a stored className cannot hold one:
// it would take another node's styles, a step sideways out of that node.
//
// A node the behaviour pass worked on brings `compiledRules`: its list read against
// the state on its path, with `showWhen` and `noScript` added. That stands in for
// `props.rules`, and it ends here, with what marks a clone or a placement root, so none
// of them crosses to an island.
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
  setsFieldSizing,
  unsafeDeclaration,
  type AuthoredRulesInput,
  type DefinitionInput,
  type DroppedDeclaration,
  type DroppedRule,
  type ResponsiveRuleInput,
} from '@/lib/responsive/responsiveCss';
import { isTextNodeType } from '@/lib/renderer/textNode';
import {
  definitionClaims,
  hasExternalAddress,
  holdsTooManyBlocks,
  isRuleList,
  reachesInsideNode,
  readRules,
  type ParsedDefinitionRule,
  type ParsedRootRule,
  type ParsedSelectorRule,
  type ReadRules,
} from '@/lib/rules/rules';
import { hoverPresetClass, type HoverKind } from '@/lib/effects/effects';
import { isPlatformVariable } from '@/lib/rules/rootProperties';
import type { ColorScheme } from '@/lib/site/theme';

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

/** True when a style entry, or any value of its map, would set `field-sizing` inline. */
function holdsFieldSizing(key: string, value: unknown): boolean {
  return isStyleMap(value) ? Object.values(value).some(entry => setsFieldSizing(key, entry)) : setsFieldSizing(key, value);
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
const PLATFORM_VARIABLE = "one of the platform's own custom properties cannot be set by a stored style";
const FIELD_SIZING = 'a control cannot size itself to its text on a page with rules';

/**
 * Rewrite the tree and build its stylesheet. `breakpoints` are the page's
 * viewport breakpoints (from the snapshot's canvas nodes); with none, a map's
 * `base` still applies everywhere and no media queries are emitted.
 */
export function applyResponsiveStyles(
  root: ComponentNode,
  breakpoints: readonly BreakpointRef[],
  options: {
    gated?: boolean;
    /**
     * The site's forced colour mode, only when its theme says `light` or `dark`: rules
     * under `prefers-color-scheme` then follow the site, not the visitor's system.
     */
    colorMode?: ColorScheme;
  } = {},
): ResponsiveStylesResult {
  const breakpointIds = new Set(breakpoints.map(b => b.id));
  const primaryId = largestFirst(breakpoints)[0]?.id;
  const rules: ResponsiveRuleInput[] = [];
  const authored: AuthoredRulesInput[] = [];
  const rootRules: ParsedRootRule[] = [];
  const definitions: DefinitionInput[] = [];
  const hoverPresets = new Set<HoverKind>();
  const claim = definitionClaims();
  /** Bodies that lost a claim, so a clash on a cloned row is reported once. */
  const clashing = new Set<string>();
  /** className -> the serialized input it was issued for (dedupe of cloned rows). */
  const issued = new Map<string, string>();
  /** `fc-<stem>` or `fc_r-<stem>` -> the classes issued under it, in order. */
  const byStem = new Map<string, string[]>();
  const kept: DroppedDeclaration[] = [];
  const problems: RuleProblem[] = [];
  /** Rows repeat one list, so a page parses each distinct list once. */
  const parsed = new Map<string, ReadRules>();
  /** A list holding an oversized definition is refused by count, so it is never serialized to find its twin. */
  const oversized = new WeakMap<unknown[], ReadRules>();
  /** What the page root's list reads as there, and only there: `:root` is refused anywhere else. */
  let pageRootRead: ReadRules | undefined;
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

  const claimDefinition = (node: ComponentNode, rule: ParsedDefinitionRule): void => {
    const { claim: result, body } = claim(rule);
    if (result === 'first') {
      definitions.push({ node: node.id ?? 'unnamed', rule });
    } else if (result === 'clash' && !clashing.has(body)) {
      clashing.add(body);
      problems.push({ node: node.id ?? 'unnamed', rule: rule.id, reason: 'another definition on this page already has this name' });
    }
  };

  const reportRefused = (node: ComponentNode, read: ReadRules): ReadRules => {
    for (const { index, reason, rule } of read.refused) {
      const id = (rule as { id?: unknown } | null)?.id;
      problems.push({ node: node.id ?? 'unnamed', rule: typeof id === 'string' ? id : `#${index}`, reason });
    }
    return read;
  };

  const readNode = (node: ComponentNode): ReadRules | null => {
    if (node.compiledRules) return { rules: node.compiledRules, refused: [] };
    const stored = (node.props as Record<string, unknown> | undefined)?.rules;
    if (!isRuleList(stored) || isTextNodeType(node.type)) return null;
    if (node === root && !node.placementRoot) {
      pageRootRead ??= reportRefused(node, readRules({ rules: stored }, { pageRoot: true }));
      return pageRootRead;
    }
    const signature = stored.some(holdsTooManyBlocks) ? null : JSON.stringify(stored);
    let read = signature === null ? oversized.get(stored) : parsed.get(signature);
    if (!read) {
      read = reportRefused(node, readRules({ rules: stored }));
      if (signature === null) oversized.set(stored, read);
      else parsed.set(signature, read);
    }
    return read;
  };

  const pageHasRule = (node: ComponentNode): boolean =>
    (readNode(node)?.rules.length ?? 0) > 0 || (node.children ?? []).some(pageHasRule);

  /**
   * The style without a key naming one of the platform's own custom properties
   * (isPlatformVariable), on every page: a node redefining `--fc-t-<id>` would repaint
   * every use of a theme token below it. Removed, not kept inline, because an inline
   * declaration would do exactly that.
   */
  const withoutPlatformVariables = (node: ComponentNode, style: Record<string, unknown>): Record<string, unknown> => {
    const refused = Object.keys(style).filter(isPlatformVariable);
    if (refused.length === 0) return style;
    const clean = { ...style };
    for (const key of refused) {
      problems.push({ node: node.id ?? 'unnamed', property: key, reason: PLATFORM_VARIABLE });
      delete clean[key];
    }
    return clean;
  };

  /** Normal without what a rule on this page could use to report on a visitor. */
  const withoutReportingValues = (node: ComponentNode, style: Record<string, unknown>): Record<string, unknown> => {
    const refusal = (key: string): string | null => {
      if (holdsFieldSizing(key, style[key])) return FIELD_SIZING;
      return key.startsWith('--') && holdsExternalAddress(style[key]) ? EXTERNAL_VARIABLE : null;
    };
    const refused = Object.keys(style).filter(key => refusal(key) !== null);
    if (refused.length === 0) return style;
    const clean = { ...style };
    for (const key of refused) {
      problems.push({ node: node.id ?? 'unnamed', property: key, reason: refusal(key) as string });
      delete clean[key];
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
    // The mark ends here: a commerce island's node crosses to the client as it is.
    const { hoverPreset, ...next }: ComponentNode = node;
    delete next.compiledRules;
    delete next.cloneIndex;
    delete next.placementRoot;
    const read = readNode(node);
    const selectorRules = (read?.rules ?? []).filter((rule): rule is ParsedSelectorRule => rule.kind === 'selector');
    for (const rule of read?.rules ?? []) {
      if (rule.kind === 'definition') claimDefinition(node, rule);
      else if (rule.kind !== 'root') continue;
      else if (node === root && !node.placementRoot) rootRules.push(rule);
      else problems.push({ node: node.id ?? 'unnamed', rule: rule.id, reason: 'only the root of a page can hold a rule on :root' });
    }
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
      for (const name of ['className', 'class']) {
        if (typeof props[name] !== 'string') continue;
        const className = withoutIssuedClasses(props[name]);
        if (className) props[name] = className;
        else delete props[name];
      }
      const classes: string[] = [];
      const stored = props.style;
      if (isStyleMap(stored)) {
        const own = withoutPlatformVariables(node, stored);
        const style = hasRules ? withoutReportingValues(node, own) : own;
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
      if (hoverPreset && !isTextNodeType(node.type)) {
        hoverPresets.add(hoverPreset);
        classes.push(hoverPresetClass(hoverPreset));
      }
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
    definitions,
    hoverPresets: [...hoverPresets],
    authored,
    rootRules,
    fieldGuard: hasRules,
    gated: options.gated,
    colorMode: options.colorMode,
    onColorModeWarning: reason => problems.push({ node: 'page', reason }),
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

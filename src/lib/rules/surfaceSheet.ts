// src/lib/rules/surfaceSheet.ts
//
// The rule sheet of an editor surface: applyResponsiveStyles' counterpart for the
// canvas and the preview, which keep Normal inline and show a node once per frame.
// It walks the tree, reads every node's rules through the parser, and hands the
// result to the one emitter, buildResponsiveCss. A rule never reaches a sheet any
// other way, here or on the published page.
//
// Rules and definitions travel through the same page-level steps as the published
// page: a text node holds none, a list that does not parse is set aside whole with
// its reason, and definitions dedupe by identity with the first in walk order
// winning. So a page that publishes without a rule shows without it here too.
//
// Normal stays inline on these surfaces, so the filter that drops a custom property
// holding an external address from a published page cannot run on it. A rule could
// reach that address through `var()`, on the signed-in origin, so the sheet clears
// each such property on a page with a rule, which has the same effect.
//
// PURE: no React and no MobX. Reading MobX-State-Tree nodes through this inside an
// observer is what subscribes the caller to them.

import {
  buildResponsiveCss,
  cssPropertyName,
  isStyleMap,
  type DefinitionInput,
  type SurfaceCopy,
  type SurfaceMemo,
  type SurfaceRulesInput,
} from '@/lib/responsive/responsiveCss';
import type { BreakpointRef } from '@/lib/responsive/cascade';
import { normalizeHover, storedEffectsOf, type HoverKind } from '@/lib/effects/effects';
import { isTextNodeType } from '@/lib/renderer/textNode';
import { definitionClaims, hasExternalAddress, isRuleList, readRules, storedRulesOf, type ParsedSelectorRule, type ReadRules } from './rules';
import { previewedBy } from './states';
import { DATA_PLACEMENT_ROOT } from '@/lib/drag/markers';
import { FLOATING_ROOT, PREVIEW_ROOT, VIEWPORT_ROOT, type EditorSurfaceKind, type SurfaceFrame } from './surfaces';

/** A node on either surface: a plain tree or a MobX-State-Tree instance. */
export interface SurfaceNode {
  id: string;
  type: string;
  props?: unknown;
  children?: readonly unknown[];
  /** From expansion: the definition node this one is a copy of. */
  classKey?: string;
  /** From expansion: the element a placement stands on. */
  placementRoot?: boolean;
}

/** One frame a tree renders into. */
export interface SurfaceFrameInput extends SurfaceFrame {
  breakpointId: string;
}

export interface SurfaceProblem {
  node: string;
  rule?: string;
  reason: string;
}

export interface SurfaceSheetInput {
  kind: EditorSurfaceKind;
  /** The page's tree, drawn once per frame. */
  tree: SurfaceNode | null | undefined;
  /** Elements outside any frame. Canvas only. */
  floating?: readonly SurfaceNode[];
  frames: readonly SurfaceFrameInput[];
  breakpoints: readonly BreakpointRef[];
  previewRule?: { componentId: string; ruleId: string } | null;
  memo?: SurfaceMemo;
  onProblem?: (problem: SurfaceProblem) => void;
}

/** What an id may be to stand in an attribute selector. Anything else is skipped with the warning. */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** Stored lists are frozen and replaced whole, so a list parses once. */
const parsed = new WeakMap<object, ReadRules>();

function parsedRulesOf(node: SurfaceNode): ReadRules | null {
  const stored = (node.props as { rules?: unknown } | undefined)?.rules;
  if (!isRuleList(stored) || isTextNodeType(node.type)) return null;
  let read = parsed.get(stored);
  if (!read) {
    read = readRules({ rules: stored });
    parsed.set(stored, read);
  }
  return read;
}

/** The custom properties of a node's Normal that could give a rule an external address. */
function externalVariables(node: SurfaceNode): string[] {
  const style = (node.props as { style?: unknown } | undefined)?.style;
  if (!isStyleMap(style) || isTextNodeType(node.type)) return [];
  return Object.keys(style).filter((key) => {
    const value = style[key];
    return key.startsWith('--') && (isStyleMap(value) ? Object.values(value).some(hasExternalAddress) : hasExternalAddress(value));
  });
}

const presetOf = (node: SurfaceNode): HoverKind => (isTextNodeType(node.type) ? 'none' : normalizeHover(storedEffectsOf(node.props)?.hover));

/** The largest frame: a floating element has no frame of its own, and it reads as the largest breakpoint already. */
function largestFrame(frames: readonly SurfaceFrameInput[], breakpoints: readonly BreakpointRef[]): SurfaceFrameInput {
  const width = (frame: SurfaceFrameInput) => breakpoints.find((b) => b.id === frame.breakpointId)?.minWidth ?? frame.width;
  return frames.reduce((best, frame) => (width(frame) > width(best) ? frame : best), frames[0]);
}

/** The stylesheet text of one surface, or '' when nothing on the page needs one. */
export function surfaceSheet(input: SurfaceSheetInput): string {
  const { kind, tree, floating = [], frames, breakpoints, previewRule, memo } = input;
  const report = input.onProblem ?? (() => {});
  const canvas = kind === 'canvas';
  const nodes: SurfaceRulesInput[] = [];
  const definitions: DefinitionInput[] = [];
  const presets = new Set<HoverKind>();
  const previewedPresets: { selector: string; kind: HoverKind }[] = [];
  const previewedNodes: string[] = [];
  const clearedVariables: { selector: string; property: string }[] = [];
  const claim = definitionClaims();
  const reported = new Set<string>();

  const safeFrames = frames.filter(({ breakpointId }) => {
    if (SAFE_ID.test(breakpointId)) return true;
    report({ node: breakpointId, reason: 'this breakpoint id cannot stand in a selector' });
    return false;
  });

  const once = (problem: SurfaceProblem) => {
    const key = `${problem.rule}|${problem.reason}`;
    if (reported.has(key)) return;
    reported.add(key);
    report(problem);
  };

  // On the canvas a definition's nodes keep their definition id across placements, so
  // one block per definition node per frame reaches them all, and the placement
  // root's element carries the attribute that lets a root rule do the same. A preview
  // renders a detached tree with an id per placement, so it writes one block for each.
  const addressOf = (node: SurfaceNode): { attribute: string; key: string; shared: boolean } => {
    const key = (canvas && node.classKey) || node.id;
    const attribute = canvas && node.placementRoot ? DATA_PLACEMENT_ROOT : 'data-component-id';
    return { attribute, key, shared: canvas && node.classKey !== undefined };
  };
  const drawn = new Set<string>();

  const visit = (node: SurfaceNode, copiesOf: (attribute: string, id: string) => SurfaceCopy[]): void => {
    const read = parsedRulesOf(node);
    if (read) {
      for (const { index, rule, reason } of read.refused) {
        const id = (rule as { id?: unknown } | null)?.id;
        once({ node: node.id, rule: typeof id === 'string' ? id : `#${index}`, reason });
      }
      for (const rule of read.rules) {
        if (rule.kind !== 'definition') continue;
        const { claim: result } = claim(rule);
        if (result === 'first') definitions.push({ node: node.id, rule });
        else if (result === 'clash') once({ node: node.id, rule: rule.id, reason: 'another definition on this page already has this name' });
      }
    }
    const rules = (read?.rules ?? []).filter((rule): rule is ParsedSelectorRule => rule.kind === 'selector');
    const preset = presetOf(node);
    if (preset !== 'none') presets.add(preset);

    const variables = externalVariables(node);
    if (rules.length > 0 || preset !== 'none' || variables.length > 0) {
      const { attribute, key, shared } = addressOf(node);
      if (!SAFE_ID.test(key)) {
        once({ node: node.id, reason: 'this node id cannot stand in a selector' });
      } else {
        const copies = copiesOf(attribute, key);
        clearedVariables.push(...variables.flatMap((property) => copies.map(({ selector }) => ({ selector, property }))));
        const isPreviewed = canvas && previewRule?.componentId === node.id;
        const active = isPreviewed ? previewedBy(storedRulesOf(node.props), previewRule.ruleId) : undefined;
        const first = !shared || !drawn.has(key);
        if (shared) drawn.add(key);
        if (rules.length > 0 && first) nodes.push({ node: key, rules, copies, previewed: active?.ids ?? new Set() });
        const showsPreset = active?.hover === true && preset !== 'none';
        if (showsPreset) previewedPresets.push(...copies.map(({ selector }) => ({ selector, kind: preset })));
        if (active && (active.ids.size > 0 || showsPreset)) previewedNodes.push(node.id);
      }
    }
    for (const child of (node.children ?? []) as readonly SurfaceNode[]) visit(child, copiesOf);
  };

  if (tree && safeFrames.length > 0) {
    const root = canvas ? VIEWPORT_ROOT : PREVIEW_ROOT;
    visit(tree, (attribute, id) =>
      safeFrames.map(({ breakpointId, width, height }) => ({
        selector: `${root} [${attribute}="${breakpointId}-${id}"]`,
        breakpointId,
        frame: { width, height },
      })),
    );
  }
  if (canvas && floating.length > 0) {
    const { width, height } = largestFrame(frames, breakpoints) ?? { width: 0, height: 0 };
    const copiesOf = (attribute: string, id: string): SurfaceCopy[] => [
      { selector: `${FLOATING_ROOT} [${attribute}="-${id}"]`, breakpointId: '', frame: { width, height } },
    ];
    for (const element of floating) visit(element, copiesOf);
  }

  const animated = new Set(
    definitions.flatMap(({ rule }) => (rule.atRule === 'keyframes' ? (rule.blocks ?? []).flatMap((block) => Object.keys(block.style).map(cssPropertyName)) : [])),
  );

  return buildResponsiveCss([], breakpoints, {
    definitions,
    hoverPresets: canvas ? [] : [...presets],
    onDropRule: ({ className, ruleId, reason }) => report({ node: className, rule: ruleId, reason }),
    surface: {
      kind,
      nodes,
      framesShown: safeFrames.length,
      previewedPresets,
      previewedNodes,
      animated,
      // Only a rule can read one, and a page with none stays as it is.
      clearedVariables: nodes.length + definitions.length > 0 ? clearedVariables : [],
      memo,
    },
  });
}

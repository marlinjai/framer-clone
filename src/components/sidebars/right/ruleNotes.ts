// src/components/sidebars/right/ruleNotes.ts
//
// What the panel says about a rule that a stored rule alone cannot say: why it does
// not show on the canvas, what differs on the published page, and what on the page
// will not work with it. Advice, never a refusal, except a definition clash, which
// is refused when typed because the page would silently keep the first one. See
// docs/plans/2026-11-02-selector-styling.md, "The canvas" and "At-rules".
import type { ComponentInstance } from '@/models/ComponentModel';
import type { PageModelType } from '@/models/PageModel';
import {
  definitionClaims,
  hasExternalAddress,
  isDefinitionRule,
  parseRule,
  storedRulesOf,
  type ParsedDefinitionRule,
  type RuleDraft,
  type StoredRule,
} from '@/lib/rules/rules';
import { namedStateOf } from '@/lib/rules/states';
import { mediaVerdict, type SurfaceFrame } from '@/lib/rules/surfaces';

const walk = (node: ComponentInstance, out: ComponentInstance[]): ComponentInstance[] => {
  out.push(node);
  for (const child of node.children as ComponentInstance[]) walk(child, out);
  return out;
};

/** Every node of a page, tree and floating elements, in walk order. */
export function pageNodes(page: PageModelType): ComponentInstance[] {
  const out: ComponentInstance[] = [];
  walk(page.appComponentTree as ComponentInstance, out);
  for (const floating of page.floatingElements as ComponentInstance[]) walk(floating, out);
  return out;
}

const parsedDefinition = (rule: unknown): ParsedDefinitionRule | undefined => {
  const parsed = parseRule(rule);
  return parsed.ok && parsed.value.kind === 'definition' ? parsed.value : undefined;
};

/**
 * Why a definition cannot join the page, or null: another with its identity and a
 * different body exists, and the sheet keeps only the first. `ignoring` is the rule
 * being edited, which does not clash with itself.
 */
export function definitionClash(page: PageModelType, draft: RuleDraft, ignoring?: string): string | null {
  const incoming = parsedDefinition({ id: 'draft', ...draft });
  if (!incoming) return null;
  const claim = definitionClaims();
  for (const node of pageNodes(page)) {
    for (const rule of storedRulesOf(node.props)) {
      const existing = rule.id === ignoring ? undefined : parsedDefinition(rule);
      if (existing) claim(existing);
    }
  }
  const name = incoming.name ?? String(incoming.style?.fontFamily ?? 'This font');
  return claim(incoming).claim === 'clash' ? `${name} is already defined differently on this page` : null;
}

/** Style keys whose values name a definition. */
const NAMES_A_DEFINITION = /^(animation|fontFamily|font$|fontPalette|listStyle|counter|positionTry)/;
const DEFINED_NAME = /(?<![\w-])(?:--)?u-[a-z0-9-]+/g;

/** The reserved names a style refers to through a property that takes one. */
function referencedNames(style: Record<string, unknown> | undefined): string[] {
  const names: string[] = [];
  for (const [key, value] of Object.entries(style ?? {})) {
    if (!NAMES_A_DEFINITION.test(key)) continue;
    names.push(...JSON.stringify(value).matchAll(DEFINED_NAME).map((match) => match[0]));
  }
  return names;
}

/** The definition names a node refers to that nothing on the page defines. */
function undefinedNames(target: ComponentInstance, nodes: readonly ComponentInstance[]): string[] {
  const defined = new Set<string>();
  for (const node of nodes) {
    for (const rule of storedRulesOf(node.props)) {
      const definition = parsedDefinition(rule);
      if (!definition) continue;
      if (definition.name) defined.add(definition.name);
      if (definition.style?.fontFamily) defined.add(String(definition.style.fontFamily));
    }
  }
  const rules = storedRulesOf(target.props);
  const referenced = [
    ...referencedNames((target.props as { style?: Record<string, unknown> }).style),
    ...rules.flatMap((rule) => (isDefinitionRule(rule) ? [] : referencedNames(rule.style))),
  ];
  return [...new Set(referenced)].filter((name) => !defined.has(name));
}

/** A Normal custom property the sheet drops once the page has a rule. */
function externalCustomProperties(nodes: readonly ComponentInstance[]): string[] {
  const found = new Set<string>();
  for (const node of nodes) {
    const style = ((node.props as { style?: Record<string, unknown> }).style ?? {}) as Record<string, unknown>;
    for (const [key, value] of Object.entries(style)) {
      if (!key.startsWith('--')) continue;
      const values = value !== null && typeof value === 'object' ? Object.values(value) : [value];
      if (values.some(hasExternalAddress)) found.add(key);
    }
  }
  return [...found];
}

const POINTER_STATE = /:(?:hover|active|focus(?:-visible|-within)?)\b/i;
const STRUCTURAL = /:(?:first|last|only|nth)-/i;

/** Why a rule does not show on the canvas until it is picked, or null. */
function canvasNote(rule: StoredRule, frame: SurfaceFrame): string | null {
  if (isDefinitionRule(rule)) return null;
  for (const wrapper of rule.at ?? []) {
    const media = /^@media\s+([\s\S]+)$/i.exec(wrapper.trim());
    if (media) {
      const verdict = mediaVerdict(media[1], frame);
      if (verdict === 'unknown') return 'The canvas cannot measure this query, so it shows only while this rule is picked.';
      if (verdict === 'environment') return "This depends on the visitor's device or settings, so the canvas shows it only while this rule is picked.";
      if (verdict === 'no') return 'This query does not match this frame, so the frame does not show it.';
    }
    if (/^@scope\s+\S/i.test(wrapper.trim())) return 'The canvas shows a scope only while this rule is picked.';
  }
  return POINTER_STATE.test(rule.selector) ? 'The canvas shows this only while this rule is picked.' : null;
}

export interface RuleNoteInput {
  target: ComponentInstance;
  page: PageModelType | undefined;
  /** The rule being edited, when it is stored. */
  rule: StoredRule | undefined;
  frame: SurfaceFrame;
}

/** The notes for what is selected. Empty for a node with no rules and nothing wrong. */
export function ruleNotes({ target, page, rule, frame }: RuleNoteInput): string[] {
  const notes: string[] = [];
  // A named state is what the switch exists to preview, so it needs no explaining.
  const canvas = rule && !namedStateOf(rule) ? canvasNote(rule, frame) : null;
  if (canvas) notes.push(canvas);
  if (rule && !isDefinitionRule(rule) && STRUCTURAL.test(rule.selector) && (page?.appComponentTree as ComponentInstance | undefined)?.id === target.id) {
    notes.push('On the published page this root has style and script elements beside it, so a structural selector can match differently.');
  }
  if (!page) return notes;
  const nodes = pageNodes(page);
  const missing = undefinedNames(target, nodes);
  if (missing.length > 0) notes.push(`Nothing on this page defines ${missing.join(', ')}.`);
  if (storedRulesOf(target.props).length > 0) {
    const external = externalCustomProperties(nodes);
    if (external.length > 0) notes.push(`${external.join(', ')} holds an external address, so the published page drops it now that this page has a rule.`);
  }
  return notes;
}

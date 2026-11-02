// src/lib/ai/pageGen/promptSections/rules.ts
//
// What the page generator may do with `props.rules`, and the model-facing text
// that says so. Plan: docs/plans/2026-11-02-selector-styling.md, "AI output".
//
// The validator accepts everything the rule parser accepts; the prompt teaches a
// short list. The two differ on purpose: a state on every element is a tell of a
// generated page, so TAUGHT_RULE_ROWS stays small while the score's other rule rows
// count as accepted, not taught.
//
// Motion is the one place generated rules are held to more than authored ones,
// because an import has to stay faithful and a generation does not. Nothing here
// runs in a rule's favour: see motionValueProblem and namesGeneratedKeyframes.

import { HOVER_GATE } from '@/lib/rules/states';

/** The node prop that carries rules (props.rules, as in the editor). */
export const RULES_PROP = 'rules';

/** Most rules one generation may store; the rest are dropped with a warning. */
export const MAX_GENERATED_RULES = 24;

/** Most times a generated animation may run: a huge count is `infinite` by another name. */
export const MAX_GENERATED_ANIMATION_RUNS = 10;

/** What an `animation` in a generated rule sits behind. */
export const REDUCED_MOTION_GATE = '@media (prefers-reduced-motion: no-preference)';

/** The score's rule rows the prompt teaches, by row id. The other rule rows are accepted, not taught. */
export const TAUGHT_RULE_ROWS: ReadonlySet<string> = new Set([
  ':hover',
  ':active',
  ':focus-visible',
  '::before',
  '::after',
  ':nth-child()',
  'prefers-color-scheme',
]);

/** The "## States and decoration" section of the schema docs (part of the cached prefix: keep it tight). */
export function rulesDocs(): string {
  return [
    '## States and decoration',
    '',
    'Optional "props.rules": a list of {"id": "<short, unique on the node>", "selector": "<starts with &>",',
    '"at": [<optional wrappers>], "style": { <exactly like props.style, responsive maps included> }}.',
    '"&" is the node itself. Use only these forms:',
    `- Hover, on links and buttons: {"id":"hover","selector":"&:hover","at":["${HOVER_GATE}"],"style":{...}}.`,
    '- Pressed: "selector":"&:active". Focused, for the keyboard: "selector":"&:focus-visible".',
    '- Decoration: "selector":"&::before" or "&::after", with "content":"\'\'" in its style.',
    '- Rhythm, on the parent of a repeated row: "selector":"& > :nth-child(2n)".',
    '- A dark look, only when the brief asks for one: "selector":"&","at":["@media (prefers-color-scheme: dark)"].',
    `A rule holds no url(). At most ${MAX_GENERATED_RULES} rules per generation: keep states for links and buttons, never`,
    'every card. A rule that does not fit these rules is dropped whole.',
  ].join('\n');
}

/** A style key that animates, in any vendor spelling. A custom property is not one. */
export function isMotionKey(property: string): boolean {
  return /^(?:webkit|moz|ms|o)?animation/i.test(property);
}

/** The keys a repeat count or a keyframes name can stand in. */
const COUNTING_KEY = /animation(?:IterationCount|Name)?$/i;

const TIMING_FUNCTION = /\b(?:cubic-bezier|steps|linear)\([^()]*\)/gi;
const BARE_NUMBER = /(?:^|[\s,])\+?(\d*\.?\d+(?:e[+-]?\d+)?)(?=$|[\s,])/gi;

/**
 * Why generated motion would never end, or undefined. A `var()` or a `calc()` could
 * hide the count from this check, so only the timing functions pass.
 */
export function motionValueProblem(property: string, value: string): string | undefined {
  if (!isMotionKey(property) || !COUNTING_KEY.test(property)) return undefined;
  const plain = value.replace(TIMING_FUNCTION, '');
  if (/\binfinite\b/i.test(plain)) return 'infinite motion';
  if (plain.includes('(')) return 'a function that can hide how often an animation runs';
  for (const [, count] of plain.matchAll(BARE_NUMBER)) {
    if (Number(count) > MAX_GENERATED_ANIMATION_RUNS) return `an animation running more than ${MAX_GENERATED_ANIMATION_RUNS} times`;
  }
  return undefined;
}

/**
 * True when a value outside a rule plays a stored `@keyframes`. Normal has no
 * wrapper, so it would run for a visitor who asked for reduced motion: the
 * animation belongs in a rule, behind the gate.
 */
export function namesGeneratedKeyframes(property: string, value: string): boolean {
  return isMotionKey(property) && /(?:^|[\s,])["']?u-[a-z0-9-]/.test(value);
}

/** True when a wrapper is the reduced-motion gate itself, however it is spaced. */
export function isReducedMotionGate(wrapper: string): boolean {
  return wrapper.toLowerCase().replace(/\s+/g, '') === REDUCED_MOTION_GATE.replace(/\s+/g, '');
}

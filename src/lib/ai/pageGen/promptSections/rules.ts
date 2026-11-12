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
// Generated rules are held to more than authored ones, because an import has to stay
// faithful and a generation may have been written by a prompt injection in a brief:
//
//   - Motion ends, and stays behind the gate: motionValueProblem and
//     namesGeneratedKeyframes.
//   - A rule cannot read what a visitor does: selectorProblem. Refusing an address in
//     a rule is not enough, because a rule can switch on what Normal holds and report
//     a ticked box or a started form to any host. So a generation with a rule keeps
//     no foreign address either (dropForeignAddresses in ../validate.ts).
//
// What stays open: a generated rule on a page whose existing Normal holds an address
// can still switch it on, with `&:hover` or a media condition. Only an enforced
// Content Security Policy closes that, open question 1 of the plan.

import { looksBeyondNode, pseudoClassesIn } from '@/lib/rules/surfaces';
import { HOVER_GATE } from '@/lib/rules/states';
import type { ThemeMode } from '@/lib/site/theme';

/** The node prop that carries rules (props.rules, as in the editor). */
export const RULES_PROP = 'rules';

/** Most rules one generation may store; the rest are dropped with a warning. */
export const MAX_GENERATED_RULES = 24;

/** Most times a generated animation may run: a huge count is `infinite` by another name. */
export const MAX_GENERATED_ANIMATION_RUNS = 10;

/** Most parts of one generated selector list, each of which the sheet writes out in full. */
export const MAX_GENERATED_SELECTOR_PARTS = 8;

/**
 * Most bytes of sheet text one generation may spend, an eighth of the page's
 * MAX_RULE_BYTES_PER_PAGE. Past that cap the sheet drops a rule and all later ones, so a
 * generation early in the page must not be able to reach it: that would remove the
 * owner's rules. Eight full generations can, and nothing here sees the page: see the plan.
 */
export const MAX_GENERATED_RULE_WEIGHT = 32 * 1024;

/** The least a block of the sheet is counted at, so the page's cap on blocks is covered too. */
const MIN_BLOCK_WEIGHT = 128;

/** The node's class, written twice into each block, and the media query around it. */
const BLOCK_OVERHEAD = 120;

/** `<` and `>` reach the sheet as a four-byte escape, where JSON holds one. */
const ESCAPED_IN_SHEET = /[<>]/g;

/** What a rule costs the sheet in bytes: one block per part, per breakpoint if it holds a map. */
export function ruleWeight(rule: unknown, parts: number, widths: number): number {
  const text = JSON.stringify(rule);
  const bytes = new TextEncoder().encode(text).length + 3 * (text.match(ESCAPED_IN_SHEET)?.length ?? 0);
  return parts * widths * Math.max(bytes + BLOCK_OVERHEAD, MIN_BLOCK_WEIGHT);
}

/**
 * The pseudo-classes a generated rule may use. An allow list, so a new state stays out.
 * What is missing reads a visitor: `:checked`, `:valid`, `:placeholder-shown`,
 * `:target`, `:visited` and whatever comes next. The pointer states are here because
 * they are the point of a hover, and a page's own hover is no secret.
 */
const GENERATED_PSEUDO_CLASSES: ReadonlySet<string> = new Set([
  'hover',
  'active',
  'focus',
  'focus-visible',
  'focus-within',
  'nth-child',
  'nth-last-child',
  'nth-of-type',
  'nth-last-of-type',
  'first-child',
  'last-child',
  'first-of-type',
  'last-of-type',
  'only-child',
  'only-of-type',
  'empty',
  'is',
  'not',
  'where',
  'has',
]);

/** The one outward condition a page needs: the look a dark ancestor asks for. */
const DARK_ANCESTOR = ':is(.dark *)';

/** Why a generated selector part may not be stored, or undefined. The parser has accepted it. */
export function selectorProblem(part: string): string | undefined {
  const name = pseudoClassesIn(part).find((candidate) => !GENERATED_PSEUDO_CLASSES.has(candidate));
  if (name !== undefined) return `:${name} is not a state a generated rule may read`;
  return looksBeyondNode(part.replaceAll(DARK_ANCESTOR, '')) ? 'a generated rule cannot read beyond its node' : undefined;
}

/** Why a generated wrapper may not be stored, or undefined. `@scope` with a prelude reads the whole document. */
export function wrapperProblem(wrapper: string): string | undefined {
  return /^@scope\b/i.test(wrapper) && wrapper.trim().length > '@scope'.length ? 'a generated rule cannot scope to the document' : undefined;
}

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

/** The mode a site fixes, or undefined when it fixes none (`system` or not chosen). */
function fixedMode(mode: ThemeMode | undefined): 'light' | 'dark' | undefined {
  return mode === 'light' || mode === 'dark' ? mode : undefined;
}

/**
 * The dark look's line of the rules docs. A site that fixes its mode answers a
 * `prefers-color-scheme` rule itself (src/lib/rules/colorMode.ts): under `light` it is dropped,
 * under `dark` it is always on, so teaching it there would write a rule that does nothing or
 * everything. With `system` or no choice it stays, because there it is what makes a dark look.
 */
const DARK_LOOK_LINE =
  '- A dark look, only when the brief asks for one: "selector":"&","at":["@media (prefers-color-scheme: dark)"].';

/** The "## States and decoration" section of the schema docs (part of the cached prefix: keep it tight). */
export function rulesDocs(mode?: ThemeMode): string {
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
    ...(fixedMode(mode) ? [] : [DARK_LOOK_LINE]),
    `A rule holds no url(). At most ${MAX_GENERATED_RULES} rules per generation: keep states for links and buttons, never`,
    'every card. A rule that does not fit these rules is dropped whole. On a generation with a rule, an image from',
    'another host is dropped: use imageQuery or a site path.',
  ].join('\n');
}

/**
 * What the request says about the site's mode (the volatile part, because it differs per
 * site). Only a fixed mode says anything: the rules docs of that request left the dark look
 * out (rulesDocs), and this says why the page must not write one.
 */
export function darkLineNote(mode: ThemeMode | undefined): string | undefined {
  const fixed = fixedMode(mode);
  if (!fixed) return undefined;
  return `- This site is fixed to ${fixed} mode: write the ${fixed} look only, with no "prefers-color-scheme" rule and no dark variant (${fixed === 'light' ? 'a dark rule is dropped' : 'a dark rule is always on and a light one dropped'}). Give a new token one value, "light".`;
}

/** A style key that animates, in any vendor spelling. A custom property is not one. */
export function isMotionKey(property: string): boolean {
  return /^(?:webkit|moz|ms|o)?animation/i.test(property);
}

/** The keys a repeat count or a keyframes name can stand in. */
const COUNTING_KEY = /animation(?:IterationCount|Name)?$/i;

const STRING = /"[^"]*"|'[^']*'/g;
const TIMING_FUNCTION = /\b(?:cubic-bezier|steps|linear)\([^()]*\)/gi;
const BARE_NUMBER = /^\+?\d*\.?\d+(?:e[+-]?\d+)?$/i;

/** What a browser reads as the keyframes names of a value: every token, quoted or glued to what stands before it. */
function motionNames(value: string): string[] {
  return value.replace(/["']/g, ' ').match(/[a-z0-9_-]+/gi) ?? [];
}

/**
 * Why generated motion would never end, or undefined. The value is read as tokens,
 * because CSS needs no separator after a string or a `)`: strings go first, so one
 * cannot hide text inside a timing function, then the timing functions. A `var()` or a
 * `calc()` could hide the count, so nothing else with brackets passes, and `!` would
 * end a token where no pattern looks for it.
 */
export function motionValueProblem(property: string, value: string): string | undefined {
  if (!isMotionKey(property) || !COUNTING_KEY.test(property)) return undefined;
  if (value.includes('!')) return 'a ! in an animation';
  const plain = value.replace(STRING, ' ').replace(TIMING_FUNCTION, ' ');
  if (plain.includes('(')) return 'a function that can hide how often an animation runs';
  for (const token of plain.split(/[\s,]+/)) {
    if (token.toLowerCase() === 'infinite') return 'infinite motion';
    if (BARE_NUMBER.test(token) && Number(token) > MAX_GENERATED_ANIMATION_RUNS) return `an animation running more than ${MAX_GENERATED_ANIMATION_RUNS} times`;
  }
  return undefined;
}

/**
 * True when a value outside a rule plays a stored `@keyframes`. Normal has no
 * wrapper, so it would run for a visitor who asked for reduced motion: the
 * animation belongs in a rule, behind the gate.
 */
export function namesGeneratedKeyframes(property: string, value: string): boolean {
  return isMotionKey(property) && motionNames(value).some((token) => /^u-/i.test(token));
}

/** The keyframes a motion declaration can name: a stored one, whatever it stands beside. */
export function storedKeyframesIn(value: unknown): string[] {
  return typeof value === 'string' ? motionNames(value).filter((token) => token.startsWith('u-')) : [];
}

/**
 * True for a declaration that hides what it sits on. Under reduced motion the animation
 * that would reveal it does not run, so such a value has to go behind the gate with it.
 */
export function hidesContent(property: string, value: unknown): boolean {
  if (value !== null && typeof value === 'object') return Object.entries(value).some(([, entry]) => hidesContent(property, entry));
  const text = String(value).trim().toLowerCase();
  if (property === 'opacity') return Number.parseFloat(text) <= 0;
  if (property === 'visibility') return text === 'hidden' || text === 'collapse';
  if (property === 'transform') return /\bscale[xy]?\(\s*0(?:\.0*)?\s*[,)]/.test(text);
  if (property === 'scale') return /^0(?:\.0*)?(?:\s|$)/.test(text);
  if (property === 'clipPath') return /\binset\(\s*(?:50|100)%/.test(text);
  return property === 'display' && text === 'none';
}

/** True when a wrapper is the reduced-motion gate itself, however it is spaced. */
export function isReducedMotionGate(wrapper: string): boolean {
  return wrapper.toLowerCase().replace(/\s+/g, '') === REDUCED_MOTION_GATE.replace(/\s+/g, '');
}

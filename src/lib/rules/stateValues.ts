// src/lib/rules/stateValues.ts
//
// What a property reads as in a state: the panel's side of "State first, then
// breakpoint" in docs/plans/2026-11-02-selector-styling.md. The rule, then each rule
// the state implies, then Normal, each through the ordinary cascade. So a Hover set on
// Desktop reaches Tablet even where Normal has a Tablet override, and a Hover with no
// value for a property shows Normal's. The sheet gets the same answer by itself; the
// one difference is that the sheet has shorthands to work with and a panel row reads
// one key, so the rows look through the small table below.

import { resolveCascade, type BreakpointRef, type CascadeSource } from '@/lib/responsive/cascade';
import { isDefinitionRule, type StoredRule } from './rules';
import { findRuleIndex, namedState, namedStateOf } from './states';

/** Splits on whitespace outside brackets, so `rgb(0 0 0)` stays one token. */
function tokens(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let part = '';
  for (const char of text.trim()) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (/\s/.test(char) && depth === 0) {
      if (part) parts.push(part);
      part = '';
    } else part += char;
  }
  return part ? [...parts, part] : parts;
}

/** One side of a box shorthand: 1 to 4 values for top, right, bottom, left. */
const side = (index: number) => (text: string): string | undefined => {
  const [top, right = top, bottom = top, left = right] = tokens(text);
  return [top, right, bottom, left][index];
};

/** `gap` holds a row value and then a column value. */
const gapPart = (index: number) => (text: string): string | undefined => {
  const [row, column = row] = tokens(text);
  return [row, column][index];
};

/** One corner of `border-radius`, ignoring the elliptical part after a slash. */
const corner = (index: number) => (text: string): string | undefined => {
  const [topLeft, topRight = topLeft, bottomRight = topLeft, bottomLeft = topRight] = tokens(text.split('/')[0]);
  return [topLeft, topRight, bottomRight, bottomLeft][index];
};

const BORDER_STYLES = /^(none|hidden|dotted|dashed|solid|double|groove|ridge|inset|outset)$/;
const LENGTH = /^(?:[\d.]+[a-z%]*|thin|medium|thick)$/i;

const borderPart = (part: 'width' | 'style' | 'color') => (text: string): string | undefined =>
  tokens(text).find((token) => {
    if (part === 'style') return BORDER_STYLES.test(token);
    if (part === 'width') return LENGTH.test(token);
    return !BORDER_STYLES.test(token) && !LENGTH.test(token);
  });

const IMAGE = /(?:url|gradient|image-set)\(/i;

/** `background` when it is one colour or one image, and nothing when it is anything more. */
const backgroundPart = (part: 'color' | 'image') => (text: string): string | undefined => {
  const parts = tokens(text);
  if (parts.length !== 1) return undefined;
  return IMAGE.test(parts[0]) === (part === 'image') ? parts[0] : undefined;
};

const FONT_SIZE = /^[\d.]+(?:[a-z]+|%)(?:\/.+)?$/i;

const fontPart = (part: 'weight' | 'size' | 'lineHeight' | 'family') => (text: string): string | undefined => {
  const parts = tokens(text);
  const at = parts.findIndex((token) => FONT_SIZE.test(token));
  if (at === -1) return undefined;
  const [size, lineHeight] = parts[at].split('/');
  if (part === 'size') return size;
  if (part === 'lineHeight') return lineHeight;
  if (part === 'family') return parts.slice(at + 1).join(' ') || undefined;
  return parts.slice(0, at).find((token) => /^(?:\d+|bold|bolder|lighter)$/.test(token));
};

/** The rows' longhands, each with the shorthand that can hold it and how to read it there. */
const LOOK_THROUGH: Record<string, { shorthand: string; read: (text: string) => string | undefined }> = {
  paddingTop: { shorthand: 'padding', read: side(0) },
  paddingRight: { shorthand: 'padding', read: side(1) },
  paddingBottom: { shorthand: 'padding', read: side(2) },
  paddingLeft: { shorthand: 'padding', read: side(3) },
  marginTop: { shorthand: 'margin', read: side(0) },
  marginRight: { shorthand: 'margin', read: side(1) },
  marginBottom: { shorthand: 'margin', read: side(2) },
  marginLeft: { shorthand: 'margin', read: side(3) },
  top: { shorthand: 'inset', read: side(0) },
  right: { shorthand: 'inset', read: side(1) },
  bottom: { shorthand: 'inset', read: side(2) },
  left: { shorthand: 'inset', read: side(3) },
  rowGap: { shorthand: 'gap', read: gapPart(0) },
  columnGap: { shorthand: 'gap', read: gapPart(1) },
  borderTopLeftRadius: { shorthand: 'borderRadius', read: corner(0) },
  borderTopRightRadius: { shorthand: 'borderRadius', read: corner(1) },
  borderBottomRightRadius: { shorthand: 'borderRadius', read: corner(2) },
  borderBottomLeftRadius: { shorthand: 'borderRadius', read: corner(3) },
  borderWidth: { shorthand: 'border', read: borderPart('width') },
  borderStyle: { shorthand: 'border', read: borderPart('style') },
  borderColor: { shorthand: 'border', read: borderPart('color') },
  backgroundColor: { shorthand: 'background', read: backgroundPart('color') },
  backgroundImage: { shorthand: 'background', read: backgroundPart('image') },
  fontSize: { shorthand: 'font', read: fontPart('size') },
  fontWeight: { shorthand: 'font', read: fontPart('weight') },
  lineHeight: { shorthand: 'font', read: fontPart('lineHeight') },
  fontFamily: { shorthand: 'font', read: fontPart('family') },
};

interface LayerHit {
  /** The stored key that gives the value, which a reset removes. */
  key: string;
  value: unknown;
  source: CascadeSource;
}

function readLayer(
  style: Record<string, unknown>,
  property: string,
  breakpointId: string | undefined,
  breakpoints: readonly BreakpointRef[],
): LayerHit | undefined {
  const own = resolveCascade(style[property], breakpointId, breakpoints);
  if (own.value !== undefined) return { key: property, value: own.value, source: own.source };
  const through = LOOK_THROUGH[property];
  if (!through) return undefined;
  const whole = resolveCascade(style[through.shorthand], breakpointId, breakpoints);
  if (typeof whole.value !== 'string') return undefined;
  const value = through.read(whole.value);
  return value === undefined ? undefined : { key: through.shorthand, value, source: whole.source };
}

export type StateRead =
  /** Set in this state. `setHere` is false when the value reaches this breakpoint from a larger one. */
  | { layer: 'state'; value: unknown; key: string; setHere: boolean; fromBreakpoint?: string }
  /** Set in a state this one implies. */
  | { layer: 'implied'; value: unknown; fromLabel: string }
  | { layer: 'normal'; value: unknown }
  | { layer: 'none'; value: undefined };

export interface StateReadInput {
  rules: readonly StoredRule[];
  /** `props.style`. */
  normal: Record<string, unknown>;
  ruleId: string;
  property: string;
  breakpointId: string | undefined;
  /** Largest first, as the model's cascadeBreakpoints gives them. */
  breakpoints: readonly BreakpointRef[];
}

const styleOf = (rule: StoredRule | undefined): Record<string, unknown> =>
  rule && !isDefinitionRule(rule) ? rule.style : {};

/** The value of one property in a state on a breakpoint, and which layer gave it. */
export function readInState({ rules, normal, ruleId, property, breakpointId, breakpoints }: StateReadInput): StateRead {
  const rule = rules[findRuleIndex(rules, ruleId)];
  const state = namedState(ruleId) ?? (rule ? namedStateOf(rule) : undefined);

  const own = readLayer(styleOf(rule), property, breakpointId, breakpoints);
  if (own) {
    const isLargest = !breakpointId || breakpoints[0]?.id === breakpointId;
    const setHere = own.source.kind === 'own' || (own.source.kind === 'base' && isLargest);
    const fromBreakpoint = own.source.kind === 'inherited' ? own.source.breakpointId : breakpoints[0]?.id;
    return { layer: 'state', value: own.value, key: own.key, setHere, ...(setHere ? {} : { fromBreakpoint }) };
  }

  for (const impliedId of state?.implies ?? []) {
    const implied = readLayer(styleOf(rules[findRuleIndex(rules, impliedId)]), property, breakpointId, breakpoints);
    if (implied) return { layer: 'implied', value: implied.value, fromLabel: namedState(impliedId)?.label ?? impliedId };
  }

  const plain = readLayer(normal, property, breakpointId, breakpoints);
  return plain ? { layer: 'normal', value: plain.value } : { layer: 'none', value: undefined };
}

// src/lib/ai/review/ops.ts
//
// Validation of the review model's patch operations. Runs on the server (on
// the raw tool input, against the tree the client sent) and again in the
// editor (against the LIVE page, right before applying), so an operation can
// only ever touch a node that exists, through a property the editor supports,
// with a value the generator itself would accept. Every refused operation is
// reported with its index and a reason; nothing is silently dropped.
//
// Rules:
//   - nodeId must name a node of the tree; the page root can be restyled but
//     never removed.
//   - update_style: `property` must be an editor style key (CSS_PROP_SET,
//     kebab-case converted). `breakpoint` is null or one of the request's
//     breakpoint keys (case-insensitive); the largest breakpoint is normalized
//     to null, because desktop-first it writes the base value
//     (src/lib/responsive/cascade.ts). Values follow the generator's rules
//     (src/lib/ai/pageGen/validate.ts): no CSS breakout characters, nothing
//     unsafe, at most maxStyleValueChars. A url() is accepted only when the
//     node's background already holds that exact URL (the review may change
//     the scrim over a photo, never bring in a new picture or drop a credited
//     one). `null` removes the value on that breakpoint.
//   - update_text: only on a node whose content is plain text (string
//     children, no child components), at most maxTextChars.
//   - remove_node: at most REVIEW_LIMITS.maxRemovals per review; later
//     operations on a removed node or inside it are refused.
//   - The plan's tells (docs/plans/2026-10-23-ai-design-quality-round-2.md)
//     the review must never introduce, where a single value shows them: long
//     dashes and emoji in copy, Inter / Geist / Space Grotesk, backdrop-filter
//     glass, radial-gradient orbs. The full tells screen is a separate checker
//     built in parallel; this is the guard for what a patch can add.

import { CSS_PROP_SET } from '@/lib/styles/cssPropSet';
import { GENERATION_LIMITS, isSafeSrc } from '@/lib/ai/pageGen/schema';
import { STYLE_BREAKOUT_CHARS, UNSAFE_STYLE_VALUE } from '@/lib/ai/pageGen/validate';
import { REVIEW_LIMITS, type RejectedOp, type ReviewOp, type ReviewTreeNode } from './protocol';

interface IndexedNode {
  type: string;
  parentId?: string;
  isRoot: boolean;
  textEditable: boolean;
  /** Every url() in the node's backgroundImage (all breakpoints). */
  backgroundUrls: Set<string>;
}

export interface OpValidationContext {
  /** Breakpoint keys, largest first (deriveBreakpointKeys order). */
  breakpointKeys: string[];
  nodes: Map<string, IndexedNode>;
}

const URL_RE = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;

function urlsIn(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') {
    for (const m of value.matchAll(URL_RE)) if (m[2]) into.add(m[2].trim());
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) urlsIn(v, into);
  }
}

/** Index a review tree by node id. */
export function indexReviewTree(tree: ReviewTreeNode): Map<string, IndexedNode> {
  const out = new Map<string, IndexedNode>();
  const walk = (n: ReviewTreeNode, parentId: string | undefined) => {
    const style = (n.props?.style ?? {}) as Record<string, unknown>;
    const backgroundUrls = new Set<string>();
    urlsIn(style.backgroundImage, backgroundUrls);
    urlsIn(n.props?.backgroundImage, backgroundUrls);
    out.set(n.id, {
      type: n.type,
      ...(parentId ? { parentId } : {}),
      isRoot: parentId === undefined,
      textEditable: typeof n.props?.children === 'string' && n.children.length === 0,
      backgroundUrls,
    });
    for (const c of n.children ?? []) walk(c, n.id);
  };
  walk(tree, undefined);
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const kebabToCamel = (key: string) => key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
const LONG_DASH = /[–—]/;
const EMOJI = /\p{Extended_Pictographic}/u;
const BANNED_FONTS = /\b(inter|geist|space\s+grotesk)\b/i;

/** Why a style value is refused, or null when it is fine. */
function styleValueProblem(property: string, value: string, node: IndexedNode): string | null {
  if (value.length > GENERATION_LIMITS.maxStyleValueChars) return `value longer than ${GENERATION_LIMITS.maxStyleValueChars} characters`;
  if (STYLE_BREAKOUT_CHARS.test(value)) return 'value contains ; { } \\ or a control character';
  if (UNSAFE_STYLE_VALUE.test(value)) return 'unsafe value';
  for (const m of value.matchAll(URL_RE)) {
    const url = (m[2] ?? '').trim();
    if (!isSafeSrc(url)) return 'url() to a disallowed location';
    if (!node.backgroundUrls.has(url)) return 'url() that is not already on this node (the review never adds pictures)';
  }
  if (property === 'fontFamily' && BANNED_FONTS.test(value)) return 'Inter, Geist and Space Grotesk are banned typefaces';
  if (property === 'backdropFilter' && value !== 'none') return 'backdrop-filter glass is a banned tell';
  if (/radial-gradient\(/i.test(value)) return 'radial-gradient orbs are a banned tell';
  if (LONG_DASH.test(value)) return 'long dashes are banned';
  return null;
}

/** The descendants-or-self test, through parent links. */
function isInside(id: string, ancestorId: string, nodes: Map<string, IndexedNode>): boolean {
  let cur: string | undefined = id;
  let guard = 0;
  while (cur && guard++ < 500) {
    if (cur === ancestorId) return true;
    cur = nodes.get(cur)?.parentId;
  }
  return false;
}

/**
 * Validate raw operations. Returns the accepted operations (normalized:
 * camelCase property, trimmed values, the largest breakpoint as null) and
 * every refusal with its index.
 */
export function validateReviewOps(raw: unknown, ctx: OpValidationContext): { ops: ReviewOp[]; rejected: RejectedOp[] } {
  const ops: ReviewOp[] = [];
  const rejected: RejectedOp[] = [];
  if (!Array.isArray(raw)) return { ops, rejected: [{ index: -1, reason: 'ops must be a list' }] };
  const keys = ctx.breakpointKeys.map((k) => k.toLowerCase());
  const removed: string[] = [];
  let removals = 0;

  raw.forEach((item, index) => {
    const reject = (reason: string) => rejected.push({ index, reason });
    if (index >= REVIEW_LIMITS.maxOps) return reject(`more than ${REVIEW_LIMITS.maxOps} operations`);
    if (!isObj(item)) return reject('not an object');
    const nodeId = typeof item.nodeId === 'string' ? item.nodeId : '';
    const node = ctx.nodes.get(nodeId);
    if (!node) return reject(`unknown node id ${JSON.stringify(item.nodeId)}`);
    if (removed.some((r) => isInside(nodeId, r, ctx.nodes))) return reject('the node was removed by an earlier operation');
    const reason = typeof item.reason === 'string' ? item.reason.trim().slice(0, REVIEW_LIMITS.maxReasonChars) : '';

    switch (item.op) {
      case 'update_style': {
        const rawProp = typeof item.property === 'string' ? item.property.trim() : '';
        const property = CSS_PROP_SET.has(rawProp) ? rawProp : kebabToCamel(rawProp);
        if (!CSS_PROP_SET.has(property)) return reject(`style key ${JSON.stringify(item.property)} is not supported by the editor`);
        let breakpoint: string | null = null;
        if (item.breakpoint !== null && item.breakpoint !== undefined) {
          const k = typeof item.breakpoint === 'string' ? item.breakpoint.trim().toLowerCase() : '';
          const i = keys.indexOf(k);
          if (i < 0) return reject(`unknown breakpoint ${JSON.stringify(item.breakpoint)}`);
          breakpoint = i === 0 ? null : ctx.breakpointKeys[i];
        }
        let value: string | number | null;
        if (item.value === null) value = null;
        else if (typeof item.value === 'number') {
          if (!Number.isFinite(item.value)) return reject('non-finite number');
          value = item.value;
        } else if (typeof item.value === 'string') {
          const v = item.value.trim();
          if (STYLE_BREAKOUT_CHARS.test(item.value)) return reject('value contains ; { } \\ or a control character');
          if (!v) {
            value = null;
          } else {
            const problem = styleValueProblem(property, v, node);
            if (problem) return reject(problem);
            value = v;
          }
        } else return reject('value must be a string, a number or null');
        ops.push({ op: 'update_style', nodeId, breakpoint, property, value, reason });
        return;
      }
      case 'update_text': {
        if (!node.textEditable) return reject('the node does not hold plain text');
        const text = typeof item.text === 'string' ? item.text.replace(/\s+/g, ' ').trim() : '';
        if (!text) return reject('empty text');
        if (text.length > GENERATION_LIMITS.maxTextChars) return reject(`text longer than ${GENERATION_LIMITS.maxTextChars} characters`);
        if (LONG_DASH.test(text)) return reject('long dashes are banned in copy');
        if (EMOJI.test(text)) return reject('emoji are banned in copy');
        if (/[<>]/.test(text)) return reject('markup is not allowed in text');
        ops.push({ op: 'update_text', nodeId, text, reason });
        return;
      }
      case 'remove_node': {
        if (node.isRoot) return reject('the page root cannot be removed');
        if (removals >= REVIEW_LIMITS.maxRemovals) return reject(`more than ${REVIEW_LIMITS.maxRemovals} removals`);
        removals += 1;
        removed.push(nodeId);
        ops.push({ op: 'remove_node', nodeId, reason });
        return;
      }
      default:
        return reject(`unknown operation ${JSON.stringify(item.op)}`);
    }
  });
  return { ops, rejected };
}

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
//   - update_style: `property` must be a style key the generator keeps
//     (isAcceptedStyleKey in src/lib/ai/pageGen/schema.ts, kebab-case converted). `breakpoint` is null or one of the request's
//     breakpoint keys (case-insensitive); the largest breakpoint is normalized
//     to null, because desktop-first it writes the base value
//     (src/lib/responsive/cascade.ts). Values follow the generator's rules
//     (src/lib/ai/pageGen/validate.ts): no CSS breakout characters, nothing
//     unsafe, at most maxStyleValueChars. A url() is accepted only when the
//     node's background already holds that exact URL (the review may change
//     the scrim over a photo, never bring in a new picture or drop a credited
//     one). `null` removes the value on that breakpoint. A text node has no
//     element to style, so it is refused. A page can hold keyframes now, so the
//     review may not start one outside a rule or let any run without end.
//   - update_text: only on a node whose content is plain text (string
//     children, no child components), at most maxTextChars.
//   - remove_node: at most REVIEW_LIMITS.maxRemovals per review; later
//     operations on a removed node or inside it are refused.
//   - Custom code is never written here: an operation that names `customCode` anywhere,
//     as a property or as a key, is refused with that reason, always. The review reads
//     the page, and a page's content can carry instructions; only a person writes code,
//     through the guarded route (docs/plans/2026-11-02-behaviour-model.md, "AI output").
//     No operation writes `behaviour` either: it is no style key and no text.
//   - The plan's tells (docs/plans/2026-10-23-ai-design-quality-round-2.md)
//     the review must never introduce, where a single value shows them,
//     checked by the tells screen's own single-value rules (styleValueTell,
//     textTell in src/lib/ai/pageGen/tells.ts): long dashes, emoji and
//     "it's not X, it's Y" copy, Inter / Geist / Space Grotesk, backdrop
//     glass, coloured radial orbs, rainbow gradients.

import { TEXT_NODE_TYPE } from '@/lib/renderer/textNode';
import { cssUrlsIn } from '@/lib/responsive/responsiveCss';
import { GENERATION_LIMITS, isAcceptedStyleKey, isSafeSrc, styleKeyFrom } from '@/lib/ai/pageGen/schema';
import { clampedZIndex, styleValueBreaksOut, styleValueProblem } from '@/lib/ai/pageGen/validate';
import { motionValueProblem } from '@/lib/ai/pageGen/promptSections/rules';
import { CUSTOM_CODE_PROP, CUSTOM_CODE_REASON } from '@/lib/ai/pageGen/promptSections/behaviour';
import { styleValueTell, textTell } from '@/lib/ai/pageGen/tells';
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

function urlsIn(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') {
    for (const url of cssUrlsIn(value)) if (url) into.add(url);
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

/** Whether an operation names custom code, as a key or as the property it writes, at any depth. */
function namesCustomCode(value: unknown, depth = 0): boolean {
  if (depth > 8 || !value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((entry) => namesCustomCode(entry, depth + 1));
  return Object.entries(value).some(([key, entry]) =>
    key === CUSTOM_CODE_PROP || (key === 'property' && entry === CUSTOM_CODE_PROP) || namesCustomCode(entry, depth + 1));
}

/** Why a style value is refused, or null when it is fine. */
function reviewValueProblem(property: string, value: string, node: IndexedNode): string | null {
  if (value.length > GENERATION_LIMITS.maxStyleValueChars) return `value longer than ${GENERATION_LIMITS.maxStyleValueChars} characters`;
  const problem = styleValueProblem(property, value);
  if (problem) return problem;
  for (const url of cssUrlsIn(value)) {
    // A reference inside the page (an SVG clip or mask) brings nothing in.
    if (url.startsWith('#')) continue;
    if (!isSafeSrc(url)) return 'url() to a disallowed location';
    if (!node.backgroundUrls.has(url)) return 'url() that is not already on this node (the review never adds pictures)';
  }
  return styleValueTell(property, value);
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
    if (namesCustomCode(item)) return reject(CUSTOM_CODE_REASON);
    const nodeId = typeof item.nodeId === 'string' ? item.nodeId : '';
    const node = ctx.nodes.get(nodeId);
    if (!node) return reject(`unknown node id ${JSON.stringify(item.nodeId)}`);
    if (removed.some((r) => isInside(nodeId, r, ctx.nodes))) return reject('the node was removed by an earlier operation');
    const reason = typeof item.reason === 'string' ? item.reason.trim().slice(0, REVIEW_LIMITS.maxReasonChars) : '';

    switch (item.op) {
      case 'update_style': {
        if (node.type === TEXT_NODE_TYPE) return reject('a text node has no element to style; style its parent');
        const rawProp = typeof item.property === 'string' ? item.property.trim() : '';
        const property = styleKeyFrom(rawProp);
        if (!isAcceptedStyleKey(property)) return reject(`style key ${JSON.stringify(item.property)} is not supported by the editor`);
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
          const motion = motionValueProblem(property, String(item.value));
          if (motion) return reject(motion);
          value = item.value;
        } else if (typeof item.value === 'string') {
          const v = item.value.trim();
          if (styleValueBreaksOut(item.value)) return reject('value contains a bare ;, { } \\ or a control character');
          if (!v) {
            value = null;
          } else {
            const problem = reviewValueProblem(property, v, node);
            if (problem) return reject(problem);
            value = v;
          }
        } else return reject('value must be a string, a number or null');
        if (property === 'zIndex' && value !== null) {
          const clamped = clampedZIndex(value);
          if (clamped === undefined) return reject('z-index must be a plain number');
          value = clamped;
        }
        ops.push({ op: 'update_style', nodeId, breakpoint, property, value, reason });
        return;
      }
      case 'update_text': {
        if (!node.textEditable) return reject('the node does not hold plain text');
        const text = typeof item.text === 'string' ? item.text.replace(/\s+/g, ' ').trim() : '';
        if (!text) return reject('empty text');
        if (text.length > GENERATION_LIMITS.maxTextChars) return reject(`text longer than ${GENERATION_LIMITS.maxTextChars} characters`);
        const tell = textTell(text);
        if (tell) return reject(tell);
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

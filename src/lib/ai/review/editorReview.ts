// src/lib/ai/review/editorReview.ts
//
// The glue between the review pass and the live editor store:
//   - reviewBreakpoints: the page's breakpoints (real ids, viewport node ids,
//     keys), largest first.
//   - serializeForReview: the page tree as the review sees it, responsive maps
//     re-keyed from breakpoint ids to the keys the model knows ("desktop").
//   - applyReviewOps: validate the operations again against the LIVE page,
//     then apply them as ONE history entry (a HistoryStore batch), all or
//     nothing: if any write throws, the batch is reverted and the page stays
//     exactly as it was.
//   - undoReview: take the review back, but only while its entry is the last
//     one (a later edit is never undone by accident).

import type { PageModelType } from '@/models/PageModel';
import type { ComponentInstance } from '@/models/ComponentModel';
import { serializeSubtree, type SerializedComponent } from '@/lib/ai/serializers/subtree';
import { deriveBreakpointKeys, BASE_KEY } from '@/lib/ai/pageGen/schema';
import { getHistoryStore } from '@/stores/RootStore';
import type { HistoryStoreInstance } from '@/stores/HistoryStore';
import { indexReviewTree, validateReviewOps } from './ops';
import { REVIEW_LIMITS, type RejectedOp, type ReviewOp, type ReviewTreeNode } from './protocol';

export interface ReviewBreakpoint {
  /** The breakpoint id responsive maps are keyed by. */
  id: string;
  /** The viewport node that renders it (its frame's data-viewport-content-id). */
  viewportId: string;
  label: string;
  minWidth: number;
  /** The key the model uses ("desktop", "phone"). */
  key: string;
}

/** The page's breakpoints, largest first, with their review keys. */
export function reviewBreakpoints(page: PageModelType): ReviewBreakpoint[] {
  const frames = (page.viewportNodes as ComponentInstance[])
    .filter((v) => v.breakpointId)
    .map((v) => ({
      id: v.breakpointId as string,
      viewportId: v.id as string,
      label: (v.label as string | undefined) ?? '',
      minWidth: (v.breakpointMinWidth as number | undefined) ?? 0,
    }))
    .sort((a, b) => b.minWidth - a.minWidth);
  const keys = deriveBreakpointKeys(frames.map(({ label, minWidth }) => ({ label, minWidth })));
  return frames.map((f, i) => ({ ...f, key: keys[i].key }));
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Re-key one responsive map from breakpoint ids to keys (unknown ids are left out). */
function rekey(value: unknown, idToKey: Map<string, string>): unknown {
  if (!isObj(value)) return value;
  const keys = Object.keys(value);
  if (!keys.some((k) => k === BASE_KEY || idToKey.has(k))) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === BASE_KEY) out[BASE_KEY] = v;
    else if (idToKey.has(k)) out[idToKey.get(k)!] = v;
  }
  return out;
}

function toReviewNode(n: SerializedComponent, idToKey: Map<string, string>): ReviewTreeNode {
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(n.props ?? {})) {
    if (k === 'style' && isObj(v)) {
      const style: Record<string, unknown> = {};
      for (const [sk, sv] of Object.entries(v)) style[sk] = rekey(sv, idToKey);
      props.style = style;
    } else if (k.startsWith('data-credit')) {
      continue; // photo credit metadata: noise for the review
    } else {
      props[k] = rekey(v, idToKey);
    }
  }
  return {
    id: n.id,
    type: n.type,
    ...(n.label ? { label: n.label } : {}),
    props,
    children: (n.children ?? []).map((c) => toReviewNode(c, idToKey)),
  };
}

/**
 * The page tree for the review. A tree over the size budget is truncated by
 * depth (innermost leaves first, serializeSubtree's token budget); operations
 * on a node that was left out are refused by validation, never misapplied.
 */
export function serializeForReview(page: PageModelType, breakpoints: ReviewBreakpoint[]): ReviewTreeNode {
  const idToKey = new Map(breakpoints.map((b) => [b.id, b.key] as const));
  const root = page.appComponentTree as ComponentInstance;
  let tree = toReviewNode(serializeSubtree(root), idToKey);
  if (JSON.stringify(tree).length > REVIEW_LIMITS.maxTreeChars) {
    // About four characters per token: aim well under the character cap.
    tree = toReviewNode(serializeSubtree(root, { maxTokens: Math.floor(REVIEW_LIMITS.maxTreeChars / 5) }), idToKey);
  }
  return tree;
}

function findInPage(page: PageModelType, id: string): ComponentInstance | undefined {
  const walk = (n: ComponentInstance): ComponentInstance | undefined => {
    if (n.id === id) return n;
    for (const c of n.children) {
      const hit = walk(c as ComponentInstance);
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(page.appComponentTree as ComponentInstance);
}

export type ApplyReviewOutcome =
  | {
      ok: true;
      applied: ReviewOp[];
      /** Refused on the client (the page changed since the review was asked, or a rule). */
      rejected: RejectedOp[];
      /** The history entry the review became (null when nothing changed). */
      historyEntryId: string | null;
    }
  | { ok: false; reason: string };

/**
 * Apply validated operations to the LIVE page as one undo step. Validation
 * runs again here against the current page, so an operation on a node that
 * was deleted meanwhile is refused instead of thrown.
 */
export function applyReviewOps(
  page: PageModelType,
  ops: ReviewOp[],
  history: HistoryStoreInstance | null = getHistoryStore(),
): ApplyReviewOutcome {
  const breakpoints = reviewBreakpoints(page);
  const keyToId = new Map(breakpoints.map((b) => [b.key, b.id] as const));
  const live = serializeForReview(page, breakpoints);
  const { ops: valid, rejected } = validateReviewOps(ops, {
    breakpointKeys: breakpoints.map((b) => b.key),
    nodes: indexReviewTree(live),
  });
  if (valid.length === 0) return { ok: true, applied: [], rejected, historyEntryId: null };
  if (history?.batch) {
    return { ok: false, reason: 'Another edit is in progress on the canvas. Finish it and try again.' };
  }

  history?.startBatch('AI review');
  try {
    for (const op of valid) {
      const node = findInPage(page, op.nodeId);
      if (!node) throw new Error(`node ${op.nodeId} disappeared while applying`);
      if (op.op === 'update_style') {
        const bpId = op.breakpoint === null ? undefined : keyToId.get(op.breakpoint);
        node.updateResponsiveStyle(op.property, op.value === null ? undefined : op.value, bpId);
      } else if (op.op === 'update_text') {
        node.setTextContent(op.text);
      } else if (!page.deleteComponent(op.nodeId)) {
        throw new Error(`node ${op.nodeId} could not be removed`);
      }
    }
  } catch (err) {
    history?.revertBatch();
    return { ok: false, reason: `Nothing was changed: ${err instanceof Error ? err.message : 'a fix could not be applied'}.` };
  }
  history?.commitBatch();
  const entry = history && history.undoIdx > 0 ? history.history[history.undoIdx - 1] : undefined;
  return { ok: true, applied: valid, rejected, historyEntryId: entry?.id ?? null };
}

/** Undo the review's history entry, only while it is the most recent one. */
export function undoReview(
  historyEntryId: string,
  history: HistoryStoreInstance | null = getHistoryStore(),
): { ok: true } | { ok: false; reason: string } {
  if (!history) return { ok: false, reason: 'Undo is not available here.' };
  const top = history.undoIdx > 0 ? history.history[history.undoIdx - 1] : undefined;
  if (!top || top.id !== historyEntryId) {
    return { ok: false, reason: 'The page was edited after the review. Use Undo in the editor (Cmd+Z) step by step.' };
  }
  history.undo();
  return { ok: true };
}

// src/lib/projects/structuralSharing.ts
//
// Structural sharing for an adopted server copy (review perf P1 of the live agent
// canvas, plan docs/plans/2026-11-08-live-agent-canvas.md). The snapshot route
// delivers parsed JSON, so every object in it is new, even where the content is
// what the open copy already holds. MobX-State-Tree (MST) reconciles a frozen
// value (a node's props and bindings, a definition's inputs) by reference: a new
// object with equal content still replaces the stored one, emits a patch (to
// autosave's onPatch and into the undo entry) and re-renders everything that
// reads it. Before the reconcile, every part of the incoming copy whose content
// equals the open copy's is replaced by the open copy's own object, so the
// reconcile only touches what really changed.

type Json = unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Old array items by their string `id`, when every item has one (a node's children). */
function byId(items: readonly unknown[]): Map<string, unknown> | undefined {
  const out = new Map<string, unknown>();
  for (const item of items) {
    if (!isRecord(item) || typeof item.id !== 'string') return undefined;
    out.set(item.id, item);
  }
  return out;
}

/** Keys whose value is defined (a snapshot can name an optional key with undefined; JSON never does). */
function definedKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).filter((key) => value[key] !== undefined);
}

/**
 * `next` with every subtree whose content equals the matching subtree of `old`
 * replaced by `old`'s object. Array items that carry an `id` are matched by it
 * (an insert does not shift every later sibling into a mismatch), others by
 * position. Answers `old` itself when the whole value is equal. Neither input
 * is changed.
 */
export function shareUnchanged<T extends Json>(old: unknown, next: T): T {
  if (old === next) return next;
  if (Array.isArray(next)) {
    if (!Array.isArray(old)) return next;
    const index = byId(old);
    let same = old.length === next.length;
    const out = next.map((item, i) => {
      const match = index && isRecord(item) && typeof item.id === 'string' ? index.get(item.id) : old[i];
      const shared = shareUnchanged(match, item as Json);
      if (shared !== old[i]) same = false;
      return shared;
    });
    return (same ? old : out) as T;
  }
  if (isRecord(next)) {
    if (!isRecord(old)) return next;
    const keys = definedKeys(next);
    let same = keys.length === definedKeys(old).length;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(next)) {
      const shared = shareUnchanged(old[key], next[key]);
      out[key] = shared;
      if (next[key] !== undefined && shared !== old[key]) same = false;
    }
    return (same ? old : out) as T;
  }
  return next;
}

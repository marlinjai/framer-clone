// src/lib/ai/serializers/normalize.ts
//
// Determinism layer for AI prompt payloads.
//
// Anthropic's prompt-cache only hits when the prefix is byte-identical
// turn-to-turn, so every serializer in this folder funnels through
// `normalize` before being stringified. Three guarantees:
//
//   1. Plain-object keys are emitted in alphabetical order — V8 preserves
//      insertion order for string keys, so a sorted build means a
//      sorted JSON.stringify.
//   2. `undefined` is dropped (it would otherwise serialise to nothing
//      anyway, but stripping it up-front means the snapshot equality test
//      doesn't trip on `{ a: undefined } !== { }`).
//   3. Dates are normalised to ISO strings (MST emits `Date` instances
//      on snapshot reads of `types.Date`; `JSON.stringify(new Date())`
//      already produces an ISO string but doing it here means the
//      pre-stringify object is also stable for in-memory equality
//      checks).
//
// We also strip known MST-internal keys (`$treenode`, `$mobx`, `$meta`)
// in case a caller accidentally hands us an MST instance instead of a
// plain object pulled via getSnapshot — defensive, not load-bearing.

const MST_INTERNAL_KEYS = new Set<string>([
  '$treenode',
  '$mobx',
  '$meta',
  // MobX-internal symbols (defensive — these are usually non-enumerable
  // but some custom toJSON impls leak them).
  '_internalAtom',
]);

/**
 * Recursively walk an arbitrary JSON-shaped value and produce a clone whose
 * plain-object keys are sorted alphabetically, undefineds dropped, and
 * `Date` values converted to ISO strings. Idempotent: re-running on the
 * output produces the same value.
 *
 * Note: arrays are NOT reordered. Array order is meaningful (children of a
 * component tree, breakpoint ordering by minWidth, etc.) and the caller is
 * responsible for sorting if a stable order is desired.
 */
export function normalize(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;

  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const n = normalize(item);
      // Drop undefined-valued slots (rare, but normalize() may produce them
      // when an entire item resolves to undefined).
      if (n !== undefined) out.push(n);
    }
    return out;
  }

  const src = value as Record<string, unknown>;
  const keys = Object.keys(src)
    .filter((k) => !MST_INTERNAL_KEYS.has(k))
    .sort();

  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = src[k];
    if (v === undefined) continue;
    out[k] = normalize(v);
  }
  return out;
}

/**
 * Convenience: `JSON.stringify` over a `normalize`d clone. Use this to
 * produce the byte-identical-across-turns string that goes into a
 * prompt-cache-eligible chunk.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(normalize(value));
}

/**
 * Wrap a payload with a labeled header so the model can locate it inside
 * a longer prompt. Uses XML-style tags because Claude follows them
 * reliably and they survive copy-paste.
 *
 * The payload is stable-stringified, so identical payloads produce
 * identical strings — cache-friendly.
 */
export function toPromptString(label: string, payload: unknown): string {
  const json = stableStringify(payload);
  return `<${label}>\n${json}\n</${label}>`;
}

// src/lib/ai/serializers/registry.ts
//
// Component-registry serializer. Tells the model which components it can
// insert and what their default props look like. Goes in the cached
// system prefix — the registry is hand-edited in code and doesn't churn
// turn-to-turn.

import { COMPONENT_REGISTRY } from '@/lib/componentRegistry';
import { isVoidTag } from '@/lib/drag/voidTags';
import { normalize } from './normalize';

export type SerializedRegistry = Array<{
  acceptsChildren: boolean;
  defaults: Record<string, unknown>;
  description: string;
  type: string;
}>;

/**
 * Serialize the component registry into a deterministic, prompt-friendly
 * shape. Entries are sorted by `type` (the registry id, e.g. 'button',
 * 'card') so the output is byte-identical across runs for the same
 * registry contents.
 *
 *   - `type`          — the id used by `getComponentEntry` / drag library
 *   - `description`   — the human-readable label
 *   - `acceptsChildren` — false for HTML void tags (img, br, input...),
 *                          true otherwise; matches the drop-resolver rule
 *                          that void tags can't host children
 *   - `defaults`      — `defaultProps` with sorted keys, ready to ship
 *                       as the props of a freshly-inserted component
 */
export function serializeRegistry(): SerializedRegistry {
  const entries = Object.values(COMPONENT_REGISTRY)
    .map((entry) => ({
      acceptsChildren: !isVoidTag(entry.htmlType),
      defaults: entry.defaultProps,
      description: entry.label,
      type: entry.id,
    }))
    .sort((a, b) => a.type.localeCompare(b.type));
  return normalize(entries) as SerializedRegistry;
}

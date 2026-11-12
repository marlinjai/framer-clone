// src/lib/ai/serializers/registry.ts
//
// Component-registry serializer. Tells the model which components it can
// insert and what their default props look like. Goes in the cached
// system prefix — the registry is hand-edited in code and doesn't churn
// turn-to-turn.

import { COMPONENT_REGISTRY } from '@/lib/componentRegistry';
import { isVoidTag } from '@/lib/drag/voidTags';
import { FX_PROP, isFxScene } from '@/lib/fxScene/marker';
import { normalize } from './normalize';

function withoutScene(props: Record<string, unknown>): Record<string, unknown> {
  const { [FX_PROP]: _scene, ...rest } = props;
  void _scene;
  return rest;
}

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
  // A behaviour preset's defaults are not what it inserts, so it is no entry to copy from.
  const entries = Object.values(COMPONENT_REGISTRY)
    .filter((entry) => !entry.preset && entry.generation !== false)
    .map((entry) => ({
      acceptsChildren: !isVoidTag(entry.htmlType),
      // An FX scene box's stored scene (src/lib/fxScene) is long and is written through its own
      // checked reader, never copied from here: the entry is listed without it.
      defaults: isFxScene(entry.defaultProps, entry.htmlType) ? withoutScene(entry.defaultProps as Record<string, unknown>) : entry.defaultProps,
      description: entry.label,
      type: entry.id,
    }))
    .sort((a, b) => a.type.localeCompare(b.type));
  return normalize(entries) as SerializedRegistry;
}

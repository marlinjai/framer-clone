// src/lib/ai/serializers/pageTree.ts
//
// Page-scoped serializer. Returns the SerializedComponent for the page's
// deployable app component tree (the thing that becomes the final HTML).
//
// Canvas-only nodes (viewports, floating elements) are NOT included here —
// they're part of the editor canvas, not the deployed page. Call
// `serializeSubtree` on individual canvas nodes if the AI needs to reason
// about them.

import type { PageModelType } from '@/models/PageModel';
import type { ComponentInstance } from '@/models/ComponentModel';
import { serializeSubtree, type SerializedComponent } from './subtree';

/**
 * Serialize the app component tree of a page. The result is the volatile
 * portion of the AI prompt — sits AFTER the cache breakpoint on the
 * server side because it changes on every edit.
 *
 * `opts.maxTokens` defaults to 8K — generous enough for a realistic
 * 50-node page but bounded so a runaway tree doesn't blow the context
 * window. Caller can override.
 */
export function serializePageTree(
  page: PageModelType,
  opts: { maxTokens?: number } = {},
): SerializedComponent {
  const root = page.appComponentTree as ComponentInstance;
  const maxTokens = opts.maxTokens ?? 8000;
  return serializeSubtree(root, { maxTokens });
}

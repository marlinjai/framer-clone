// src/lib/ai/promptCache.ts
//
// Helpers for assembling Anthropic system prompts with prompt-caching
// breakpoints in the right place.
//
// Rules of thumb (from the prompt-caching docs):
//   - Cache breakpoints attach to a *content block*, marking "everything
//     up to and including this block is the cached prefix".
//   - Cache hits are byte-exact: if anything before the breakpoint
//     changes, the cache misses. Volatile state (page snapshots,
//     selection) must therefore live *after* the last cached block.
//   - At most a handful of breakpoints per request — we use one, at the
//     end of the stable prefix.
//   - TTL is 1h for editor sessions (20+ minute lifespan amortizes the
//     ~2x write cost after two re-uses).

import type Anthropic from '@anthropic-ai/sdk';

/**
 * Author-friendly system block shape. `cache: true` marks the block as
 * part of the cacheable prefix. `buildSystemPrompt` then places a
 * single `cache_control` breakpoint on the *last* `cache: true` block,
 * which captures every preceding cache-eligible block as the prefix.
 */
export type SystemBlock = {
  type: 'text';
  text: string;
  /**
   * When true, this block is part of the stable cached prefix. All
   * cache:true blocks should come before any cache:false (volatile)
   * blocks; `buildSystemPrompt` will throw if that invariant is
   * violated, because mixing them defeats the cache.
   */
  cache?: boolean;
};

export const CACHE_TTL_1H = '1h' as const;

/**
 * Build the `system` parameter for `messages.create`.
 *
 * - Emits the blocks in input order.
 * - Places a single `cache_control: { type: 'ephemeral', ttl: '1h' }`
 *   marker on the *last* cache:true block. That block (and every block
 *   before it) becomes the cached prefix.
 * - Volatile blocks (cache:false / unset) MUST appear after every
 *   cached block. Throws if a volatile block precedes a cached one.
 */
export function buildSystemPrompt(
  blocks: SystemBlock[],
): Anthropic.TextBlockParam[] {
  if (blocks.length === 0) return [];

  // Validate ordering: every cache:true block must precede every
  // volatile block.
  let sawVolatile = false;
  for (const b of blocks) {
    if (b.cache && sawVolatile) {
      throw new Error(
        'buildSystemPrompt: cache=true block must not follow a volatile block; ' +
          'put all cached (stable) blocks first, then volatile state.',
      );
    }
    if (!b.cache) sawVolatile = true;
  }

  // Find the *last* cache=true block — that's where the breakpoint
  // goes.
  let lastCacheIdx = -1;
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].cache) lastCacheIdx = i;
  }

  return blocks.map((b, i) => {
    const out: Anthropic.TextBlockParam = { type: 'text', text: b.text };
    if (i === lastCacheIdx) {
      out.cache_control = { type: 'ephemeral', ttl: CACHE_TTL_1H };
    }
    return out;
  });
}

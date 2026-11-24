// src/lib/customCode/registry.ts
//
// Where a published custom code block (CustomCodeIsland) and the broker
// (broker.ts, the behaviour runtime's third lazy chunk) meet. Plan
// docs/plans/2026-11-02-sandboxed-custom-code.md, slice C3, decisions D60 onward.
//
// An island adds its block when it mounts; the broker, once the runtime has
// loaded it, serves every block added before and after. Neither imports the
// other: the island is in the page's client bundle, the broker is fetched only
// on a page that holds a block, and this module is all they share. Nothing here
// is reachable from the page's globals or from a frame.
//
// PURE and client-safe: no React, no DOM reads.

/** What the broker may check a declared state against: its type and bounds, never its value. Never `text`. */
export interface BlockState {
  type: 'boolean' | 'number' | 'choice';
  min?: number;
  max?: number;
  options?: string[];
}

/**
 * One block as the server accepted it (applyCustomCode): the frame's address,
 * built from the rendering site's id and the hash, never from stored text; the
 * declaration of the blob row; and the definition of every declared state where
 * the block stands on the page.
 */
export interface IslandBlock {
  src: string;
  title: string;
  reads: string[];
  writes: string[];
  emits: string[];
  sizing: 'fixed' | 'content';
  interactive: boolean;
  states: Record<string, BlockState>;
}

export interface BlockHandle {
  /** The block's own box: the frame goes in here, after the fallback. */
  el: HTMLElement;
  block: IslandBlock;
  /** True once the frame said hello (the fallback goes); false on any failure (the fallback stays, for good). */
  settle(shown: boolean): void;
}

/** Serves one block; returns what takes it away again. */
export type ServeBlock = (handle: BlockHandle) => () => void;

let serve: ServeBlock | null = null;
const waiting = new Set<BlockHandle>();
const served = new Map<BlockHandle, () => void>();

/** Adds a block. Returns what removes it, its frame included. */
export function addBlock(handle: BlockHandle): () => void {
  if (serve) served.set(handle, serve(handle));
  else waiting.add(handle);
  return () => {
    waiting.delete(handle);
    served.get(handle)?.();
    served.delete(handle);
  };
}

/**
 * Serves every block, those added before included. Returns what stops serving:
 * every frame goes and its fallback stays for good, as on any other failure.
 */
export function serveBlocks(fn: ServeBlock): () => void {
  serve = fn;
  for (const handle of waiting) served.set(handle, fn(handle));
  waiting.clear();
  return () => {
    if (serve !== fn) return;
    serve = null;
    const stops = [...served.values()];
    served.clear();
    stops.forEach((stop) => stop());
  };
}

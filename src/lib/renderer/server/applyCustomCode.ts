// applyCustomCode: decides which sandboxed custom code blocks of a published page
// get a frame, and what each frame may touch. Plan
// docs/plans/2026-11-02-sandboxed-custom-code.md, slice C3, decisions D60 onward.
//
// Runs on the hydrated tree, before applyBehaviour. For each node whose
// `props.customCode` names a block (customCode.ts) it checks, in document order:
//
//   - the hash is one of the site's live blobs (LiveCustomCode, read by the server
//     for this request: the site switch on, the blob not blocked, the kill switch
//     off and the box's origin configured);
//   - fewer than BOX_LIMITS.blocksPerPage blocks were accepted before it;
//   - every state its declaration reads or writes stands on the node's path as
//     the runtime will hold it (the parsed behaviour, readBehaviourTree), and is
//     `boolean`, `number` or `choice`, never `text`.
//
// An accepted node gets `customCodeRun`, the island's block (registry.ts): the
// frame's address built from the rendering site's id and the hash (boxPath, which
// throws on anything else), the declaration of the blob row, and the definition of
// each declared state. Every other block keeps only its fallback, with a reason in
// `problems`. Nothing stored can set `customCodeRun`: the snapshot adapter maps five
// fields, and this is not one of them.
//
// PURE: no React, no server-only. The blob read is the caller's (src/server/customCode).

import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { readBehaviourTree, type StateValue } from '@/lib/behaviour/format';
import { BOX_LIMITS, boxPath, type CustomCodeDeclaration } from '@/lib/customCode/contract';
import { hasCustomCode, parseCustomCode } from '@/lib/customCode/customCode';
import type { BlockState, IslandBlock } from '@/lib/customCode/registry';

/** What the server read for this request: the site's id, the box's origin and the declaration of every live blob the page names. */
export interface LiveCustomCode {
  siteId: string;
  origin: string;
  blobs: ReadonlyMap<string, CustomCodeDeclaration>;
}

export interface CustomCodeProblem {
  node: string;
  reason: string;
}

export interface CustomCodeResult {
  root: ComponentNode;
  /** How many blocks got a frame. */
  blocks: number;
  /** Some accepted block declares a write: the page can change without a trigger, so it needs the runtime's state. */
  writes: boolean;
  problems: CustomCodeProblem[];
}

/** Every hash the tree's blocks name, for the blob read. Proposals and invalid values name none. */
export function customCodeHashes(root: ComponentNode): string[] {
  const out = new Set<string>();
  const walk = (node: ComponentNode): void => {
    if (hasCustomCode(node.props)) {
      const parsed = parseCustomCode((node.props as Record<string, unknown>).customCode);
      if (parsed.ok && parsed.value.kind === 'block') out.add(parsed.value.sha256);
    }
    (node.children ?? []).forEach(walk);
  };
  walk(root);
  return [...out];
}

/** The state as the broker checks it: type and bounds, never the value. Null for `text`. */
function blockState(state: StateValue): BlockState | null {
  if (state.type === 'boolean') return { type: 'boolean' };
  if (state.type === 'choice') return { type: 'choice', options: [...state.options] };
  if (state.type === 'number') {
    return { type: 'number', ...(state.min !== undefined ? { min: state.min } : {}), ...(state.max !== undefined ? { max: state.max } : {}) };
  }
  return null;
}

export function applyCustomCode(root: ComponentNode, live: LiveCustomCode | null): CustomCodeResult {
  const problems: CustomCodeProblem[] = [];
  const hashes = customCodeHashes(root);
  if (hashes.length === 0) return { root, blocks: 0, writes: false, problems };
  if (!live) {
    problems.push({ node: 'page', reason: 'custom code does not run here (site switch off, kill switch on, no box origin, or a preview): every block shows its fallback' });
    return { root, blocks: 0, writes: false, problems };
  }
  // The states the runtime will hold, as the behaviour pass reads them: refused entries hold none.
  const behaviours = readBehaviourTree(root).behaviours;
  let blocks = 0;
  let writes = false;

  const accept = (node: ComponentNode, states: ReadonlyMap<string, StateValue>): IslandBlock | null => {
    const nodeId = node.id ?? 'unnamed';
    const parsed = parseCustomCode((node.props as Record<string, unknown>).customCode);
    if (!parsed.ok || parsed.value.kind !== 'block') return null;
    const declaration = live.blobs.get(parsed.value.sha256);
    if (!declaration) {
      problems.push({ node: nodeId, reason: 'no live blob of this site has this hash' });
      return null;
    }
    if (blocks >= BOX_LIMITS.blocksPerPage) {
      problems.push({ node: nodeId, reason: `a page runs at most ${BOX_LIMITS.blocksPerPage} blocks; this one shows its fallback` });
      return null;
    }
    const declared: Record<string, BlockState> = {};
    for (const id of [...declaration.reads, ...declaration.writes]) {
      const state = states.get(id);
      const shape = state ? blockState(state) : null;
      if (!shape) {
        problems.push({ node: nodeId, reason: state ? `the state ${id} is text, which a frame never reads or writes` : `the state ${id} does not stand above this block` });
        return null;
      }
      declared[id] = shape;
    }
    let src: string;
    try {
      src = `${live.origin}${boxPath(live.siteId, parsed.value.sha256)}`;
    } catch {
      problems.push({ node: nodeId, reason: 'the site id is not one the box can name' });
      return null;
    }
    blocks += 1;
    if (declaration.writes.length > 0) writes = true;
    return {
      src,
      title: parsed.value.title,
      reads: [...declaration.reads],
      writes: [...declaration.writes],
      emits: [...declaration.emits],
      sizing: declaration.sizing,
      interactive: declaration.interactive,
      states: declared,
    };
  };

  const visit = (node: ComponentNode, outer: ReadonlyMap<string, StateValue>): ComponentNode => {
    const own = behaviours.get(node)?.state;
    // A node's own state counts, as the runtime's lookup starts at the element itself.
    const states = own ? new Map([...outer, ...own.map((state): [string, StateValue] => [state.id, state])]) : outer;
    const run = hasCustomCode(node.props) ? accept(node, states) : null;
    const children = node.children?.map((child) => visit(child, states));
    if (!run && children?.every((child, index) => child === node.children?.[index])) return node;
    return { ...node, ...(children ? { children } : {}), ...(run ? { customCodeRun: run } : {}) };
  };

  return { root: visit(root, new Map()), blocks, writes, problems };
}

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
//   - the renderer will draw it as a box of its own in HTML (whereFrameCannotStand): not
//     inside a form or a shop control, whose islands get the node without its value
//     (D95), not inside a sticky bar, a map, a void or unnamed tag or a refused tag,
//     which draw no children, and not on or inside `svg` or `math`, where an HTML
//     frame is not drawn, nor on or inside a tag that draws no element child (a
//     select, an option, a textarea, a canvas, a video, a template, FRAMELESS_TAGS)
//     (D66);
//   - fewer than BOX_LIMITS.blocksPerPage blocks were accepted before it;
//   - every state its declaration reads or writes stands on the node's path as
//     the runtime will hold it (the parsed behaviour, readBehaviourTree), and is
//     `boolean`, `number` or `choice`, never `text`.
//
// An accepted node gets `customCodeRun`, the island's block (registry.ts): the
// frame's address built from the rendering site's id and the hash (boxPath, which
// throws on anything else), the declaration of the blob row, and the definition of
// each declared state. Every other block keeps only its fallback, with a reason in
// `problems`. Only this pass sets `customCodeRun`: a node that arrives carrying one
// (the snapshot adapter maps five fields and this is not one, but the renderer must not
// rest on that) loses it here, on every page, with live code on or off.
//
// PURE: renders nothing, no server-only. It reads the box's tag from customCodeBoxTag, the
// renderer's own rule, so the two cannot disagree. The blob read is the caller's (src/server/customCode).

import { INTERACTIVE_COMMERCE_KINDS, type ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { contentBelow, isBlockedTag, type ForeignContent } from '@/lib/renderer/blockedNodes';
import { isTextNodeType } from '@/lib/renderer/textNode';
import { isComponentPlaceholderType } from '@/lib/components/placement';
import { isVoidTag } from '@/lib/drag/voidTags';
import { formKindOf } from '@/lib/forms/definition';
import { isStickyCta } from '@/lib/stickyCta/stickyCta';
import { isMapEmbed } from '@/lib/mapEmbed/mapEmbed';
import { shopPartRoleOf } from '@/lib/commerce/parts';
import { customCodeBoxTag } from '@/lib/renderer/customCode/customCodeElement';
import { readBehaviourTree, type StateValue } from '@/lib/behaviour/format';
import { BOX_LIMITS, boxPath, type CustomCodeDeclaration } from '@/lib/customCode/contract';
import { hasCustomCode, parseCustomCode } from '@/lib/customCode/customCode';
import type { BlockState, IslandBlock } from '@/lib/customCode/registry';

/** A node's tag as renderComponentNode resolves it: the stored type, or none. */
function tagOf(node: ComponentNode): string | null {
  return typeof node.type === 'string' && node.type.length > 0 ? node.type : null;
}

/**
 * Why renderComponentNode does not draw this node in the ordinary way, in its order of
 * checks (a text or placeholder node, a refused tag, a form part, the sticky bar, a map),
 * or null. Such a node never reaches the custom code branch, and its children never
 * reach the walk.
 */
function drawnApart(node: ComponentNode, foreign: ForeignContent): string | null {
  if (isTextNodeType(node.type) || isComponentPlaceholderType(node.type)) return 'a text or placeholder node';
  if (isBlockedTag(tagOf(node), foreign)) return 'a refused tag';
  const props = node.props as Record<string, unknown> | undefined;
  if (formKindOf(props)) return 'a form';
  if (isStickyCta(props)) return 'the sticky bar';
  if (isMapEmbed(props)) return 'a map';
  return null;
}

/**
 * Why the children of this (drawn, not custom code) node are not drawn by the ordinary
 * walk, or null: a shop control's island gets them without their stored value (D95),
 * a shop part draws them inside its control only, and a void or unnamed tag none.
 */
function childrenApart(node: ComponentNode): string | null {
  const kind = (node.props as Record<string, unknown> | undefined)?.['data-component-kind'];
  if (typeof kind === 'string' && INTERACTIVE_COMMERCE_KINDS.has(kind)) return 'a shop control';
  if (shopPartRoleOf(node.props)) return 'a shop part';
  const tag = tagOf(node);
  if (!tag || isVoidTag(tag)) return 'a tag that draws no children';
  return null;
}

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

/**
 * Tags whose element children are not drawn as boxes on the page (review 3 of pull request #452, L2): a frame in
 * one measures 0 by 0 in Chromium, WebKit and Firefox (a canvas draws it in Firefox only), and only Chromium loads
 * it, so its hello would hide a fallback that was showing while nobody sees the frame. As D66 refuses svg and math.
 */
export const FRAMELESS_TAGS: ReadonlySet<string> = new Set([
  'select', 'option', 'optgroup', 'datalist', 'textarea', 'canvas', 'video', 'audio', 'template', 'noscript', 'colgroup',
]);

export function applyCustomCode(root: ComponentNode, live: LiveCustomCode | null): CustomCodeResult {
  const problems: CustomCodeProblem[] = [];
  const hashes = customCodeHashes(root);
  if (hashes.length > 0 && !live) {
    problems.push({ node: 'page', reason: 'custom code does not run here (site switch off, kill switch on, no box origin, or a preview): every block shows its fallback' });
  }
  const running = hashes.length > 0 ? live : null;
  // The states the runtime will hold, as the behaviour pass reads them: refused entries hold none.
  const behaviours = running ? readBehaviourTree(root).behaviours : null;
  let blocks = 0;
  let writes = false;

  const accept = (node: ComponentNode, states: ReadonlyMap<string, StateValue>, live: LiveCustomCode, apart: string | null): IslandBlock | null => {
    const nodeId = node.id ?? 'unnamed';
    const parsed = parseCustomCode((node.props as Record<string, unknown>).customCode);
    if (!parsed.ok || parsed.value.kind !== 'block') return null;
    // Where the renderer draws no island, a block takes no slot and brings no broker.
    if (apart) {
      problems.push({ node: nodeId, reason: `a frame is not drawn ${apart}; this block shows its fallback` });
      return null;
    }
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

  /**
   * `foreign` and `parentTag` are what the node stands in, as the renderer threads them;
   * `outside` says why the node's subtree is not drawn by the ordinary walk (an ancestor's
   * reason), or null.
   */
  const visit = (node: ComponentNode, outer: ReadonlyMap<string, StateValue>, foreign: ForeignContent, parentTag: string | null, outside: string | null): ComponentNode => {
    const own = behaviours?.get(node)?.state;
    // A node's own state counts, as the runtime's lookup starts at the element itself.
    const states = own ? new Map([...outer, ...own.map((state): [string, StateValue] => [state.id, state])]) : outer;
    const self = outside ?? (running ? drawnApart(node, foreign) : null);
    const isBlock = hasCustomCode(node.props);
    const tag = tagOf(node) ?? 'div';
    // A void-tag block under a table part, a select or an option has no box at all (D96).
    const boxTag = isBlock ? customCodeBoxTag(tag, foreign, parentTag) : tag;
    // A box that is itself `svg` or `math` holds its frame in foreign content as much as one inside them.
    const ownContent = contentBelow(tag, false);
    // A box, or any element, of a tag that draws no element child: a frame in it is never seen (D66).
    const frameless = boxTag !== null && FRAMELESS_TAGS.has(boxTag) ? `a ${boxTag}` : null;
    const where = self
      ? `${outside ? 'inside' : 'on'} ${self}`
      : foreign !== false ? `inside ${foreign}` : isBlock && ownContent !== false ? `on ${ownContent}`
      : boxTag === null ? `under a ${parentTag}, where a void tag gets no box`
      : isBlock && frameless ? `on ${frameless}, which draws no frame inside it` : null;
    const run = running && isBlock ? accept(node, states, running, where) : null;
    // The custom code branch draws a block's children in its box; any other node as its kind says.
    const below = self ?? (boxTag === null ? 'a block drawn as nothing' : frameless ?? (running && !isBlock ? childrenApart(node) : null));
    // A void block's box stands in what its own tag would: neither is svg or math. Its children stand in the box.
    const children = node.children?.map((child) => visit(child, states, contentBelow(tag, foreign), isBlock ? boxTag : tagOf(node), below));
    const same = !children || children.every((child, index) => child === node.children?.[index]);
    if (!run && node.customCodeRun === undefined && same) return node;
    const next: ComponentNode = { ...node, ...(children ? { children } : {}) };
    if (run) next.customCodeRun = run;
    else delete next.customCodeRun;
    return next;
  };

  return { root: visit(root, new Map(), false, null, null), blocks, writes, problems };
}

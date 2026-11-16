// src/lib/renderer/server/previewSafe.ts
//
// What a page loses when it is rendered as a branch's public preview (site
// branches, slice S8). The address of a preview is its secret, and a preview
// sends nothing, so a stored node may not undo either:
//
//   - `referrerpolicy` on a node (an image, a link, a frame) overrides the
//     `referrer-policy: no-referrer` every preview answer carries, and would
//     hand the address to the host the node points at. Dropped, so the header
//     decides.
//   - `action`, `formaction` and `ping` send to an address of the owner's
//     choosing: a plain form that posts to a newsletter service would really
//     subscribe a preview visitor while the band says forms are off. Dropped: a
//     submit then goes to the preview's own address, which refuses every post.
//   - A map box loads a frame of Google's, which is told the page it sits on
//     (the frame asks for it) and would learn the address. Replaced by a box of
//     the same style that says so.
//   - A custom code block (src/lib/customCode) never runs on a preview link
//     (decision D13 of docs/plans/2026-11-02-sandboxed-custom-code.md: the box
//     never names a preview host as a frame ancestor). Its `customCode` is taken
//     off, so the node renders as what it holds, its fallback, with no mark a
//     published island could act on.
//
// Platform forms and the checkout are made inert where they run
// (FormUnavailableContext, CheckoutUnavailableContext): they need their props.

import { isMapEmbed } from '@/lib/mapEmbed/mapEmbed';
import { withoutCustomCodeProp } from '@/lib/customCode/customCode';

interface SafeNode {
  type: string;
  props?: Record<string, unknown>;
  children?: SafeNode[];
}

const DROPPED: ReadonlySet<string> = new Set(['referrerpolicy', 'action', 'formaction', 'ping']);

/** What a map box says on a preview. */
export const PREVIEW_MAP_NOTICE = 'A map is shown here on the live site. It is not loaded in a preview.';

function safeProps(stored: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!stored) return stored;
  const props = withoutCustomCodeProp(stored);
  const names = Object.keys(props);
  if (!names.some((name) => DROPPED.has(name.toLowerCase()))) return props;
  return Object.fromEntries(names.filter((name) => !DROPPED.has(name.toLowerCase())).map((name) => [name, props[name]]));
}

/** The tree as a preview may render it. A new tree where something changes; the input is not mutated. */
export function previewSafeTree<N extends SafeNode>(root: N): N {
  const walk = (node: N): N => {
    if (isMapEmbed(node.props)) {
      const { style, className } = node.props ?? {};
      return {
        ...node,
        type: 'div',
        props: { ...(style !== undefined ? { style } : {}), ...(className !== undefined ? { className } : {}), role: 'note' },
        children: [{ type: 'p', props: { children: PREVIEW_MAP_NOTICE } }],
      } as unknown as N;
    }
    const props = safeProps(node.props);
    const children = Array.isArray(node.children) ? (node.children as N[]) : null;
    const nextChildren = children ? children.map(walk) : null;
    const changedChildren = !!children && nextChildren!.some((child, i) => child !== children[i]);
    if (props === node.props && !changedChildren) return node;
    return { ...node, ...(props !== node.props ? { props } : {}), ...(changedChildren ? { children: nextChildren } : {}) } as N;
  };
  return walk(root);
}

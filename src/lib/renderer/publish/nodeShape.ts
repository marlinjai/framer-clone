// src/lib/renderer/publish/nodeShape.ts
//
// What a stored tree must look like before anything walks it. A snapshot is opaque
// JSON to the save route, so one child that is a string or a null must cost that
// child, not the whole page. PURE: no React, no MST.

import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

let warned = false;

function warnOnce(): void {
  if (warned) return;
  warned = true;
  console.warn('[renderer] dropped a malformed part of a stored tree');
}

/**
 * The node with whatever does not have a node's shape removed, or null when it is
 * not a node at all. The same object when nothing goes, so a healthy page costs a
 * walk and no copy.
 */
export function wellFormedTree(value: unknown): ComponentNode | null {
  if (!isRecord(value)) {
    if (value !== undefined) warnOnce();
    return null;
  }
  let node = value;
  const without = (key: string) => {
    warnOnce();
    const { [key]: _dropped, ...rest } = node;
    node = rest;
  };
  if (node.props !== undefined && node.props !== null && !isRecord(node.props)) without('props');
  if (node.bindings !== undefined && node.bindings !== null && !isRecord(node.bindings)) without('bindings');
  if (Array.isArray(node.children)) {
    const children = node.children.map(wellFormedTree);
    const kept = children.filter((child): child is ComponentNode => child !== null);
    if (kept.length !== children.length || kept.some((child, index) => child !== (node.children as unknown[])[index])) {
      node = { ...node, children: kept };
    }
  } else if (node.children !== undefined && node.children !== null) {
    without('children');
  }
  return node as unknown as ComponentNode;
}

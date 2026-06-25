/* eslint-disable @typescript-eslint/no-explicit-any */
// renderComponentNode: the SSR-safe server renderer.
//
// A pure tree-walk over a HYDRATED `ComponentNode` tree (the output of
// `hydrateBindings`, whose data components are already expanded into concrete
// primitive subtrees). For each node:
//
//   - The four INTERACTIVE commerce kinds (variant-selector / add-to-cart /
//     cart-view / checkout-button) are emitted as a `<CommerceIsland>` client
//     boundary. hydrateBindings leaves these verbatim (runtime islands); they
//     hydrate client-side against the same-origin /api/commerce/* reads.
//   - Every other node maps `node.type` to an HTML tag via the SERVER-importable
//     COMPONENT_REGISTRY (`htmlType`) and emits `React.createElement(tag, props,
//     children)`. node.type is already an intrinsic tag for editor primitives;
//     the registry lookup additionally resolves a registry-id type to its tag.
//   - Unknown / empty node types degrade GRACEFULLY (render nothing), never throw.
//
// NO MST, NO observer(), NO hooks, NO window. The client dispatch
// (createComponentElement) reads `window.__componentRegistry`, which does not
// exist server-side; this renderer deliberately does not use that path. This
// module is import-safe in BOTH the server (the RSC route) and the client bundle
// (CommerceIsland reuses it to render island descendants), so it carries no
// `server-only` and no `'use client'`.

import React from 'react';
import { COMPONENT_REGISTRY } from '@/lib/componentRegistry';
import { isVoidTag } from '@/lib/drag/voidTags';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import type { BindingScope } from '@/lib/bindings/resolver/scope';
import { createScope } from '@/lib/bindings/resolver/scope';
import CommerceIsland, { type CommerceIslandProps } from './CommerceIsland';

/** The four interactive commerce kinds emitted as client islands (never baked
 *  server-side). Mirrors INTERACTIVE_COMMERCE_KINDS in hydrateBindings. */
const INTERACTIVE_COMMERCE_KINDS: ReadonlySet<string> = new Set([
  'variant-selector',
  'add-to-cart',
  'cart-view',
  'checkout-button',
]);

// Props that are internal to the snapshot/binding model and must NOT reach the
// DOM (React would render them as stray attributes). `children` is consumed via
// the children argument; `query` is the structured data-component query object;
// `bindings` never lives in props but is denied defensively.
const NON_DOM_PROPS: ReadonlySet<string> = new Set(['children', 'query', 'bindings']);

/**
 * Resolve a node's HTML tag. Editor primitives store `type` as the intrinsic
 * tag already (createIntrinsicComponent uses the registry `htmlType`); when a
 * `type` instead names a registry ENTRY id, resolve it to that entry's
 * `htmlType`. An empty / non-string type has no tag (caller renders nothing).
 */
function resolveHtmlTag(type: unknown): string | null {
  if (typeof type !== 'string' || type.length === 0) return null;
  const entry = COMPONENT_REGISTRY[type];
  return entry ? entry.htmlType : type;
}

/**
 * Collapse a responsive style map to a single concrete value. CSS values are
 * strings / numbers, so any plain-object style value is a responsive map
 * (`{ base, <breakpointId>: ... }`). The published page renders at one effective
 * breakpoint, so we take `base` when present, else the first declared value.
 */
function flattenStyleValue(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const map = value as Record<string, unknown>;
  if ('base' in map) return map.base;
  const first = Object.values(map)[0];
  return first;
}

/** Flatten a style object's responsive-map values to concrete values. */
function flattenStyle(style: unknown): Record<string, unknown> | undefined {
  if (!style || typeof style !== 'object' || Array.isArray(style)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(style as Record<string, unknown>)) {
    out[key] = flattenStyleValue(value);
  }
  return out;
}

/**
 * Build the DOM-safe prop object for a node (NO React key): drop internal props
 * and flatten the responsive style map. The resolved binding values are already
 * baked onto `node.props` by hydrateBindings. Exported so the client island
 * shell can pass the same wrapper props to the existing island components.
 */
export function nodeDomProps(node: ComponentNode): Record<string, unknown> {
  const source = (node.props ?? {}) as Record<string, unknown>;
  const props: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(source)) {
    if (NON_DOM_PROPS.has(name)) continue;
    if (name === 'style') {
      const style = flattenStyle(value);
      if (style && Object.keys(style).length > 0) props.style = style;
      continue;
    }
    props[name] = value;
  }
  return props;
}

/** As `nodeDomProps`, with a stable React key stamped for element emission. */
function domPropsOf(node: ComponentNode, key: React.Key): Record<string, unknown> {
  return { key, ...nodeDomProps(node) };
}

/** Resolve a node's wrapper tag for island mounting (defaults to `div`). */
export function nodeHostTag(node: ComponentNode): string {
  return resolveHtmlTag(node.type) ?? 'div';
}

/** The raw-text child of a node (a string/number `props.children`), or null. */
function rawTextChild(node: ComponentNode): React.ReactNode {
  const child = (node.props as any)?.children;
  if (typeof child === 'string' || typeof child === 'number') return child;
  return null;
}

/**
 * Render one hydrated ComponentNode to a React element. `scope` is threaded to
 * any interactive island so its descendants re-resolve `{{variant.*}}` /
 * `{{availability.*}}` client-side. `key` disambiguates list siblings.
 */
export function renderComponentNode(
  node: ComponentNode,
  scope: BindingScope = createScope(),
  key: React.Key = node.id ?? 0,
): React.ReactNode {
  const dataKind = (node.props as any)?.['data-component-kind'];

  // Interactive commerce kinds -> a client island boundary. The whole node
  // (props + verbatim children) crosses the RSC boundary as plain data.
  if (typeof dataKind === 'string' && INTERACTIVE_COMMERCE_KINDS.has(dataKind)) {
    return (
      <CommerceIsland
        key={key}
        kind={dataKind as CommerceIslandProps['kind']}
        node={node}
        scope={scope}
      />
    );
  }

  const tag = resolveHtmlTag(node.type);
  // Unknown / empty type: degrade gracefully (render nothing), never throw.
  if (!tag) return null;

  const props = domPropsOf(node, key);

  // Void tags (img / br / input / ...) must not receive children.
  if (isVoidTag(tag)) {
    return React.createElement(tag, props);
  }

  const childNodes = node.children ?? [];
  const children: React.ReactNode =
    childNodes.length > 0
      ? childNodes.map((child, index) =>
          renderComponentNode(child, scope, child.id ?? index),
        )
      : rawTextChild(node);

  return React.createElement(tag, props, children);
}

export default renderComponentNode;

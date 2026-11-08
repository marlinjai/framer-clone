/* eslint-disable @typescript-eslint/no-explicit-any */
// renderComponentNode: the SSR-safe server renderer.
//
// A pure tree-walk over a HYDRATED `ComponentNode` tree (the output of
// `hydrateBindings`, whose data components are already expanded into concrete
// primitive subtrees). For each node:
//
//   - A text node (src/lib/renderer/textNode.ts) is its text, with no element.
//   - The four INTERACTIVE commerce kinds (variant-selector / add-to-cart /
//     cart-view / checkout-button) are emitted as a `<CommerceIsland>` client
//     boundary. hydrateBindings leaves these verbatim (runtime islands); they
//     hydrate client-side against the same-origin /api/commerce/* reads.
//   - Every other node emits `React.createElement(node.type, props, children)`:
//     a stored type is the tag itself, as on the canvas (see resolveHtmlTag).
//   - Unknown / empty node types degrade GRACEFULLY (render nothing), never throw.
//
// NO MST, NO observer(), NO hooks, NO window. The client dispatch
// (createComponentElement) reads `window.__componentRegistry`, which does not
// exist server-side; this renderer deliberately does not use that path. This
// module is import-safe in BOTH the server (the RSC route) and the client bundle
// (CommerceIsland reuses it to render island descendants), so it carries no
// `server-only` and no `'use client'`.

import React from 'react';
import { isVoidTag } from '@/lib/drag/voidTags';
import { contentBelow, type ForeignContent, isBlockedProp, isBlockedTag, renderedInlineStyle, withoutClobberingId, withoutFormOverrides } from '@/lib/renderer/blockedNodes';
import { isLegacyRulesAttribute } from '@/lib/rules/rules';
import { isComponentPlaceholderType } from '@/lib/components/placement';
import { isTextNodeType, ownTextThenChildren, renderOwnText, runLinksAllowedIn } from '@/lib/renderer/textNode';
import { createRunElement } from '@/lib/renderer/runElements';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import type { BindingScope } from '@/lib/bindings/resolver/scope';
import { createScope } from '@/lib/bindings/resolver/scope';
import CommerceIsland, { type CommerceIslandProps } from './CommerceIsland';
import FormIsland, { FormFieldIsland, FormSubmitIsland } from '../forms/FormIsland';
import { formKindOf } from '@/lib/forms/definition';
import { isStickyCta } from '@/lib/stickyCta/stickyCta';
import { createStickyCtaElement } from '../stickyCta/stickyCtaElement';
import { isMapEmbed, MAP_EMBED_PROP_KEYS, stripMapEmbedProps } from '@/lib/mapEmbed/mapEmbed';
import MapEmbedIsland from '../mapEmbed/MapEmbedIsland';
import { shopPartRoleOf } from '@/lib/commerce/parts';
import { applyBindings } from '@/lib/bindings/resolver/applyBindings';
import { ShopPartElement } from '@/lib/commerce/shopRuntime';

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
// `bindings` never lives in props but is denied defensively; `effects` is
// turned into attributes by applyEffects and denied here defensively too, as
// `behaviour` is, which is data for the behaviour runtime under any value.
// `rules` is the same unless it is a string, which stays the legacy `<table>`
// attribute it has always been: anything else would render as `[object Object]`.
const NON_DOM_PROPS: ReadonlySet<string> = new Set(['children', 'query', 'bindings', 'effects', 'behaviour']);

/**
 * Resolve a node's HTML tag. A stored `type` IS the tag: every write path stores
 * a registry entry's `htmlType` (the Link component is an `a`, the Form a marked
 * `div`), and createComponentElement emits `type` unchanged. It is never read as
 * a registry id, because `form` and `link` are both, and the two renderers must
 * agree. An empty / non-string type has no tag (caller renders nothing).
 */
function resolveHtmlTag(type: unknown): string | null {
  return typeof type === 'string' && type.length > 0 ? type : null;
}

/**
 * Defensive fallback only. The published page moves every responsive style map
 * into its stylesheet first (applyResponsiveStyles, called by
 * renderPublishedPage), so a map reaches this point only when the walk is used
 * on a tree that skipped that pass. CSS values are strings / numbers, so any
 * plain-object style value is a responsive map (`{ base, <breakpointId>: ... }`);
 * take `base` when present, else the first declared value, so React never
 * receives an object as a style value.
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
    if (NON_DOM_PROPS.has(name) || isBlockedProp(name, value)) continue;
    if (name === 'rules' && !isLegacyRulesAttribute(value)) continue;
    if (name === 'style') {
      const flat = flattenStyle(value);
      const style = flat && renderedInlineStyle(flat);
      if (style && Object.keys(style).length > 0) props.style = style;
      continue;
    }
    props[name] = value;
  }
  // `form=` reaches a live form from anywhere, and only the form knows what is inside it.
  return withoutClobberingId(node.type, props.form === undefined ? props : withoutFormOverrides(props));
}

/** As `nodeDomProps`, with a stable React key stamped for element emission. */
function domPropsOf(node: ComponentNode, key: React.Key): Record<string, unknown> {
  return { key, ...nodeDomProps(node) };
}


/** Resolve a node's wrapper tag for island mounting (defaults to `div`). */
export function nodeHostTag(node: ComponentNode): string {
  return resolveHtmlTag(node.type) ?? 'div';
}

/**
 * The text of a node with no element: a string or number `props.children`, or
 * formatted text as its runs. `inLink` leaves a run's address out inside a link or
 * a button, where a link would be invalid and the HTML parser would close the
 * outer one.
 */
function rawTextChild(node: ComponentNode, inLink: boolean): React.ReactNode {
  return renderOwnText((node.props as any)?.children, createRunElement, !inLink) as React.ReactNode;
}

/**
 * What goes inside a node's element: its own text, then its child nodes in
 * order. Exported for the form island, which renders its own wrapper. `inLink`
 * says the node sits inside a link or a button, its own tag included.
 */
export function renderNodeChildren(
  node: ComponentNode,
  scope: BindingScope,
  foreign: ForeignContent = false,
  inLink = !runLinksAllowedIn(node.type),
): React.ReactNode {
  const rendered = (node.children ?? []).map((child, index) =>
    renderComponentNode(child, scope, child.id ?? index, foreign, inLink),
  );
  return ownTextThenChildren((node.props as any)?.children, rendered, createRunElement, !inLink) as React.ReactNode;
}

/** A node's child nodes without its own text (a shop part draws its text itself). */
function renderNodeChildrenOnly(node: ComponentNode, scope: BindingScope, foreign: ForeignContent, inLink: boolean): React.ReactNode {
  const children = node.children ?? [];
  if (children.length === 0) return undefined;
  return children.map((child, index) => renderComponentNode(child, scope, child.id ?? index, foreign, inLink));
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
  foreign: ForeignContent = false,
  inLink = false,
): React.ReactNode {
  // No element at all, so nothing below (a tag, an island, a marker) applies.
  if (isTextNodeType(node.type)) return rawTextChild(node, inLink);

  // Expansion leaves none but a `#missing` one, and `#component` cannot be a tag.
  if (isComponentPlaceholderType(node.type)) return null;

  // Checked first: an island below would otherwise mount with this host tag.
  if (isBlockedTag(resolveHtmlTag(node.type), foreign)) return null;

  // Forms (published site essentials, decision 4): the form container is a
  // client island that owns its fields' state; fields and the submit button
  // read it from context (src/lib/renderer/forms/FormIsland.tsx). The render
  // time feeds the no-JavaScript fill-time check of the submit endpoint.
  const formKind = formKindOf(node.props as Record<string, unknown> | undefined);
  if (formKind === 'form') {
    return <FormIsland key={key} node={node} scope={scope} renderedAt={Date.now()} />;
  }
  if (formKind === 'form-field') return <FormFieldIsland key={key} node={node} />;
  if (formKind === 'form-submit') return <FormSubmitIsland key={key} node={node} />;

  // The sticky call to action bar draws its own link; renderPublishedPage
  // moved it to the end of the page and its stylesheet pins it on phones.
  if (isStickyCta(node.props)) {
    return createStickyCtaElement(nodeDomProps(node), 'published', key, node.props as Record<string, unknown>);
  }

  // A Google Maps embed: a placeholder until the visitor consents, then the frame,
  // drawn by its island from an address it rebuilds (src/lib/mapEmbed/mapEmbed.ts).
  if (isMapEmbed(node.props)) {
    const source = (node.props ?? {}) as Record<string, unknown>;
    const config = Object.fromEntries(MAP_EMBED_PROP_KEYS.filter((name) => name in source).map((name) => [name, source[name]]));
    return <MapEmbedIsland key={key} domProps={stripMapEmbedProps(nodeDomProps(node))} config={config} />;
  }

  // A shop part (src/lib/commerce/parts.ts): drawn as its control's island says
  // (shown or not, its text, its behaviour). Outside its control it draws nothing.
  const shopRole = shopPartRoleOf(node.props);
  if (shopRole) {
    const partTag = resolveHtmlTag(node.type) ?? 'div';
    // Inside an island nothing hydrated its text binding: a label bound to the
    // product ({{product.title}}) reads the frames the island sits in here.
    const partText = node.bindings?.children ? applyBindings(node, node.props ?? {}, scope).resolvedProps.children : (node.props as any)?.children;
    return (
      <ShopPartElement
        key={key}
        role={shopRole}
        tag={partTag}
        domProps={nodeDomProps(node)}
        storedText={partText}
        content={isVoidTag(partTag) ? undefined : renderNodeChildrenOnly(node, scope, contentBelow(partTag, foreign), inLink || !runLinksAllowedIn(partTag))}
        surface="preview"
        linksAllowed={!inLink}
      />
    );
  }

  const dataKind = (node.props as any)?.['data-component-kind'];

  // Interactive commerce kinds -> a client island boundary. The whole node
  // (props + verbatim children) crosses the RSC boundary as plain data.
  if (typeof dataKind === 'string' && INTERACTIVE_COMMERCE_KINDS.has(dataKind)) {
    return (
      <CommerceIsland
        key={key}
        kind={dataKind as CommerceIslandProps['kind']}
        node={node}
        // The product, variant and availability of the source the island sits in (hydrateBindings
        // records them on the node): a variant selector inside a product detail reads its product here.
        scope={node.islandFrames ? createScope([...scope.frames, ...node.islandFrames]) : scope}
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

  return React.createElement(tag, props, renderNodeChildren(node, scope, contentBelow(tag, foreign), inLink || !runLinksAllowedIn(tag)));
}

export default renderComponentNode;

/* eslint-disable @typescript-eslint/no-explicit-any */
// CommerceIsland: the client boundary that mounts ONE of the four interactive
// commerce islands on a published page.
//
// hydrateBindings leaves the four interactive kinds (variant-selector /
// add-to-cart / cart-view / checkout-button) VERBATIM as runtime islands; the
// server renderer (renderComponentNode) emits this client component in their
// place. We REUSE the existing island components from src/lib/renderer/commerce/*
// unchanged: they read only `node.props` / `node.children` (never MST-reactive
// fields), so a plain serializable ComponentNode satisfies them.
//
// The commerce data source + cart providers are mounted ONCE at the page level
// by CommercePageProviders, so this boundary only dispatches by kind. The
// selection context (SelectedVariantContext) is published by VariantSelector
// itself; an add-to-cart nested inside a variant-selector node is re-rendered
// through `renderNode` and therefore sits inside that provider.
//
// Surface is 'preview' (the published-site behavior): an errored data slot
// shows the visitor a plain sentence rather than an editor error chip.
//
// Loading and error states (plan docs/plans/2026-10-23-published-site-essentials.md,
// decision 7):
//   - PENDING: until the island has mounted in the browser (the cart lives in
//     localStorage and every read is client-side), it renders a sized,
//     aria-busy placeholder in the node's own host element and classes, so the
//     layout does not jump and nothing claims "your cart is empty" before the
//     cart was read. Sizes per kind: ISLAND_PENDING_SIZE.
//   - ERROR: a render failure inside an island is caught by CommerceErrorBoundary,
//     which shows a visible message with a "Try again" control instead of
//     blanking the page section (and logs the error).
'use client';

import React from 'react';
import type { ComponentInstance } from '@/models/ComponentModel';
import type { BindingScope } from '@/lib/bindings/resolver/scope';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import VariantSelector from '@/lib/renderer/commerce/VariantSelector';
import AddToCartButton from '@/lib/renderer/commerce/AddToCartButton';
import CartView from '@/lib/renderer/commerce/CartView';
import CheckoutButton from '@/lib/renderer/commerce/CheckoutButton';
import { CommerceErrorBoundary } from '@/lib/renderer/commerce/CommerceErrorBoundary';
import { renderComponentNode, nodeDomProps, nodeHostTag } from './renderComponentNode';

export interface CommerceIslandProps {
  /** One of the four interactive commerce kinds. */
  kind: 'variant-selector' | 'add-to-cart' | 'cart-view' | 'checkout-button';
  /** The verbatim island ComponentNode (plain serializable data). */
  node: ComponentNode;
  /** Binding scope threaded from the server walk (page frame + any data frames). */
  scope: BindingScope;
}

/** The placeholder's minimum size per island kind, so the page does not jump on mount. */
export const ISLAND_PENDING_SIZE: Record<CommerceIslandProps['kind'], { minHeight: number; minWidth?: number }> = {
  'variant-selector': { minHeight: 72 },
  'add-to-cart': { minHeight: 38, minWidth: 128 },
  'cart-view': { minHeight: 120 },
  'checkout-button': { minHeight: 38, minWidth: 128 },
};

const PENDING_LABEL: Record<CommerceIslandProps['kind'], string> = {
  'variant-selector': 'Loading product options',
  'add-to-cart': 'Loading',
  'cart-view': 'Loading your cart',
  'checkout-button': 'Loading',
};

/** True once mounted in the browser (false on the server and in the first client render). */
function useMounted(): boolean {
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  return mounted;
}

export default function CommerceIsland({ kind, node, scope }: CommerceIslandProps) {
  const hostType = nodeHostTag(node);
  const hostProps = nodeDomProps(node);
  const mounted = useMounted();
  if (!mounted && kind in ISLAND_PENDING_SIZE) {
    const size = ISLAND_PENDING_SIZE[kind];
    const wrapperProps = { ...hostProps } as Record<string, unknown>;
    delete wrapperProps.children;
    return React.createElement(
      hostType as any,
      { ...wrapperProps, 'data-island-pending': kind, 'aria-busy': true },
      <span
        role="status"
        aria-label={PENDING_LABEL[kind]}
        style={{
          display: 'block',
          minHeight: `${size.minHeight}px`,
          ...(size.minWidth ? { minWidth: `${size.minWidth}px` } : {}),
          borderRadius: '6px',
          background: 'rgba(127, 127, 127, 0.12)',
        }}
      />,
      // Without JavaScript the island never mounts: say so instead of "loading" forever.
      <noscript key="noscript">
        <span style={{ display: 'block', fontSize: '13px' }}>Turn on JavaScript to use the shop.</span>
      </noscript>,
    );
  }
  return (
    <CommerceErrorBoundary kind={kind} hostType={hostType} hostProps={hostProps}>
      <IslandBody kind={kind} node={node} scope={scope} hostType={hostType} hostProps={hostProps} />
    </CommerceErrorBoundary>
  );
}

function IslandBody({
  kind,
  node,
  scope,
  hostType,
  hostProps,
}: CommerceIslandProps & { hostType: string; hostProps: Record<string, unknown> }) {
  // The island components index into `node.children`; normalize to an array so a
  // verbatim node with no children does not crash VariantSelector's map.
  const islandNode = {
    ...node,
    children: node.children ?? [],
  } as unknown as ComponentInstance;

  // Recurse back into the server walk for island descendants (e.g. an
  // add-to-cart inside a variant-selector), keeping the binding scope intact so
  // {{variant.*}} / {{availability.*}} re-resolve to the visitor's selection.
  const renderNode = (child: ComponentInstance, childScope: BindingScope) =>
    renderComponentNode(child as unknown as ComponentNode, childScope, (child as any).id);

  switch (kind) {
    case 'variant-selector':
      return (
        <VariantSelector
          node={islandNode}
          scope={scope}
          renderNode={renderNode}
          hostType={hostType}
          hostProps={hostProps}
          mode="preview"
        />
      );
    case 'add-to-cart':
      return (
        <AddToCartButton
          node={islandNode}
          scope={scope}
          hostType={hostType}
          hostProps={hostProps}
          mode="preview"
        />
      );
    case 'cart-view':
      return (
        <CartView
          node={islandNode}
          scope={scope}
          hostType={hostType}
          hostProps={hostProps}
          mode="preview"
        />
      );
    case 'checkout-button':
      return (
        <CheckoutButton
          node={islandNode}
          scope={scope}
          hostType={hostType}
          hostProps={hostProps}
        />
      );
    default:
      // Unknown kind: degrade gracefully (render nothing), never throw.
      return null;
  }
}

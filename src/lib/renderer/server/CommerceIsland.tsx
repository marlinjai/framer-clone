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
// renders nothing rather than an editor error chip.
'use client';

import React from 'react';
import type { ComponentInstance } from '@/models/ComponentModel';
import type { BindingScope } from '@/lib/bindings/resolver/scope';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import VariantSelector from '@/lib/renderer/commerce/VariantSelector';
import AddToCartButton from '@/lib/renderer/commerce/AddToCartButton';
import CartView from '@/lib/renderer/commerce/CartView';
import CheckoutButton from '@/lib/renderer/commerce/CheckoutButton';
import { renderComponentNode, nodeDomProps, nodeHostTag } from './renderComponentNode';

export interface CommerceIslandProps {
  /** One of the four interactive commerce kinds. */
  kind: 'variant-selector' | 'add-to-cart' | 'cart-view' | 'checkout-button';
  /** The verbatim island ComponentNode (plain serializable data). */
  node: ComponentNode;
  /** Binding scope threaded from the server walk (page frame + any data frames). */
  scope: BindingScope;
}

export default function CommerceIsland({ kind, node, scope }: CommerceIslandProps) {
  const hostType = nodeHostTag(node);
  const hostProps = nodeDomProps(node);
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

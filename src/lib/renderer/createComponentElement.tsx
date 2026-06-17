/* eslint-disable @typescript-eslint/no-explicit-any */
// Shared HOST / FUNCTION / void-tag dispatch used by both renderers.
//
// Editor and headless renderers build their own `finalProps` (the editor adds
// event handlers; headless does not) but the actual emit step is identical:
// void tags must not receive children, host elements forward children,
// function components are looked up in the runtime registry.
//
// Identity attributes (`data-component-id`, `data-inner-component-id`) are
// injected here so every renderer (editor, headless preview, future static
// HTML emitter) ships the same DOM identifiers. Lumitra Studio cross-domain
// matching, drag resolution, and selection overlays all key off these.
import React from 'react';
import { ComponentInstance } from '@/models/ComponentModel';
import { isVoidTag } from '@/lib/drag';
import type { BindingScope } from '@/lib/bindings/resolver/scope';
import { createScope } from '@/lib/bindings/resolver/scope';
import CollectionRenderer, {
  type RenderNode,
} from '@/lib/renderer/data/CollectionRenderer';
import RecordViewRenderer from '@/lib/renderer/data/RecordViewRenderer';
import TableViewRenderer from '@/lib/renderer/data/TableViewRenderer';
import type { DataComponentKind } from '@/lib/componentRegistry';
import ProductListRenderer from '@/lib/renderer/commerce/ProductListRenderer';
import ProductDetailRenderer from '@/lib/renderer/commerce/ProductDetailRenderer';
import VariantSelector from '@/lib/renderer/commerce/VariantSelector';
import AddToCartButton from '@/lib/renderer/commerce/AddToCartButton';
import CartView from '@/lib/renderer/commerce/CartView';
import CheckoutButton from '@/lib/renderer/commerce/CheckoutButton';

// The six Track C commerce kinds. Disjoint from the CMS kinds, so the commerce
// branch in createComponentElement can claim them without touching the CMS path.
const COMMERCE_KINDS: ReadonlySet<DataComponentKind> = new Set<DataComponentKind>([
  'product-list',
  'product-detail',
  'variant-selector',
  'add-to-cart',
  'cart-view',
  'checkout-button',
]);

function isCommerceKind(kind: DataComponentKind): boolean {
  return COMMERCE_KINDS.has(kind);
}

const COMMERCE_KIND_LABELS: Record<string, string> = {
  'product-list': 'Product list',
  'product-detail': 'Product detail',
  'variant-selector': 'Variant selector',
  'add-to-cart': 'Add to cart',
  'cart-view': 'Cart',
  'checkout-button': 'Checkout',
};

function commerceKindLabel(kind: DataComponentKind): string {
  return COMMERCE_KIND_LABELS[kind] ?? 'Commerce component';
}

const COMMERCE_PLACEHOLDER_STYLE: React.CSSProperties = {
  color: '#9ca3af',
  fontSize: '12px',
  fontFamily: 'Inter, sans-serif',
  pointerEvents: 'none',
  userSelect: 'none',
};

export interface CreateComponentElementOptions {
  // When present, the dispatch attaches `data-component-id` and
  // `data-inner-component-id` to the emitted element. FUNCTION components
  // receive these as props and must spread them onto their root element to
  // make the attributes visible in the DOM (an unwritten contract for entries
  // in `window.__componentRegistry`).
  identity?: { breakpointId: string; componentId: string };

  // Binding scope active for this node. Threaded by both host renderers so
  // BOUND data components (Collection / RecordView) can resolve their source
  // and push row frames. Defaults to an empty scope when omitted.
  scope?: BindingScope;

  // Recursion callback into the active host renderer (editor vs headless).
  // The data renderers use it to render the per-row template against a
  // row-scoped binding chain, which keeps editor and headless output
  // identical. Required for data-component dispatch; ordinary nodes ignore it.
  renderNode?: RenderNode;

  // Rendering surface for the data renderers' error split: 'editor' surfaces
  // an inline error chip with the real message, 'preview' (preview/headless/
  // static emit) renders nothing for an errored slot. Defaults to 'preview'
  // (the safe SSR/published-site behavior).
  mode?: 'editor' | 'preview';
}

export function createComponentElement(
  component: ComponentInstance,
  finalProps: Record<string, unknown>,
  children: React.ReactNode[],
  rawTextChildren?: React.ReactNode,
  options?: CreateComponentElementOptions,
): React.ReactNode {
  const identity = options?.identity;
  const propsWithIdentity: Record<string, unknown> = identity
    ? {
        ...finalProps,
        'data-component-id': `${identity.breakpointId}-${identity.componentId}`,
        'data-inner-component-id': identity.componentId,
      }
    : finalProps;

  if (component.isHostElement) {
    if (isVoidTag(component.type as string)) {
      const props = { ...propsWithIdentity };
      if ('children' in props) delete (props as any).children;
      return React.createElement(component.type as any, props);
    }

    // Data-component dispatch. Registry entries with `dataComponentKind`
    // carry a `data-component-kind` HTML attribute on their default props; we
    // use it here as the dispatch marker.
    const dataKind = propsWithIdentity['data-component-kind'] as
      | DataComponentKind
      | undefined;

    // Commerce (Track C) dispatch. The six storefront kinds route to their own
    // renderers, which OWN their children construction (per-product templates,
    // per-line cart rows). Two kinds are SOURCE components gated on a binding;
    // the other four are context-driven (scope / cart / selection) and render
    // unconditionally. An UNBOUND source component (or a source kind reached
    // without a recursion callback) falls through to the dashed-box placeholder
    // below rather than silently rendering nothing.
    if (dataKind && isCommerceKind(dataKind)) {
      const scope = options?.scope ?? createScope();
      const renderNode = options?.renderNode;
      const mode = options?.mode ?? 'preview';
      const hostType = component.type as string;

      // Context-driven controls: always render (no data-source binding gate).
      if (dataKind === 'cart-view') {
        return (
          <CartView
            node={component}
            scope={scope}
            hostType={hostType}
            hostProps={propsWithIdentity}
            mode={mode}
          />
        );
      }
      if (dataKind === 'checkout-button') {
        return (
          <CheckoutButton
            node={component}
            scope={scope}
            hostType={hostType}
            hostProps={propsWithIdentity}
          />
        );
      }
      if (dataKind === 'add-to-cart') {
        return (
          <AddToCartButton
            node={component}
            scope={scope}
            hostType={hostType}
            hostProps={propsWithIdentity}
            mode={mode}
          />
        );
      }
      if (dataKind === 'variant-selector' && renderNode) {
        return (
          <VariantSelector
            node={component}
            scope={scope}
            renderNode={renderNode}
            hostType={hostType}
            hostProps={propsWithIdentity}
            mode={mode}
          />
        );
      }

      // Source components: dispatch only when BOUND (a `products` / `product`
      // read-binding present) and a recursion callback is available; otherwise
      // fall through to the unbound dashed-box placeholder.
      if (dataKind === 'product-list' && component.hasBindings && renderNode) {
        return (
          <ProductListRenderer
            node={component}
            scope={scope}
            renderNode={renderNode}
            hostType={hostType}
            hostProps={propsWithIdentity}
            mode={mode}
          />
        );
      }
      if (dataKind === 'product-detail' && component.hasBindings && renderNode) {
        return (
          <ProductDetailRenderer
            node={component}
            scope={scope}
            renderNode={renderNode}
            hostType={hostType}
            hostProps={propsWithIdentity}
            mode={mode}
          />
        );
      }

      // UNBOUND (or no renderNode): a dashed-box label so designers see the node
      // exists and needs configuration. Never a silent empty success.
      const wrapperProps = { ...propsWithIdentity };
      delete (wrapperProps as any).children;
      const placeholder = React.createElement(
        'span',
        { style: COMMERCE_PLACEHOLDER_STYLE },
        `${commerceKindLabel(dataKind)} (no binding)`,
      );
      return React.createElement(component.type as any, wrapperProps, placeholder);
    }

    // BOUND data nodes dispatch to the real data renderers, which own their
    // own (per-row) children construction and ignore the generic `children`
    // built by the host renderer. `table-view` now routes to TableViewRenderer
    // (slice2-tableview-renderer): the host wrapper carries identity attrs and
    // container styling while the read-only TableView renders inside it.
    if (dataKind && component.hasBindings) {
      const scope = options?.scope ?? createScope();
      const renderNode = options?.renderNode;
      const mode = options?.mode ?? 'preview';
      if (renderNode && dataKind === 'collection') {
        return (
          <CollectionRenderer
            node={component}
            scope={scope}
            renderNode={renderNode}
            hostType={component.type as string}
            hostProps={propsWithIdentity}
            mode={mode}
          />
        );
      }
      if (renderNode && dataKind === 'record-view') {
        return (
          <RecordViewRenderer
            node={component}
            scope={scope}
            renderNode={renderNode}
            hostType={component.type as string}
            hostProps={propsWithIdentity}
            mode={mode}
          />
        );
      }
      if (dataKind === 'table-view') {
        const wrapperProps = { ...propsWithIdentity };
        delete (wrapperProps as any).children;
        return React.createElement(
          component.type as any,
          wrapperProps,
          <TableViewRenderer node={component} scope={scope} />,
        );
      }
    }

    // Unbound data node: render a dashed-box label (the Wave 1 stub) so
    // designers see immediately that the node exists and needs configuration.
    if (dataKind && !component.hasBindings && children.length === 0) {
      const label =
        dataKind === 'collection'
          ? 'Collection'
          : dataKind === 'record-view'
            ? 'Record view'
            : 'Table view';
      const placeholder = React.createElement(
        'span',
        {
          style: {
            color: '#9ca3af',
            fontSize: '12px',
            fontFamily: 'Inter, sans-serif',
            pointerEvents: 'none',
            userSelect: 'none',
          },
        },
        `${label} (no binding)`,
      );
      return React.createElement(component.type as any, propsWithIdentity, placeholder);
    }

    const content: React.ReactNode = children.length ? children : rawTextChildren;
    return React.createElement(component.type as any, propsWithIdentity, content);
  }

  const Impl = (window as any).__componentRegistry?.[component.type];
  if (Impl) {
    return <Impl {...propsWithIdentity}>{children}</Impl>;
  }

  return null;
}

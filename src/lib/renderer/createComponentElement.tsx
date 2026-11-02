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
import { getParent, hasParent, isStateTreeNode } from 'mobx-state-tree';
import { ComponentInstance } from '@/models/ComponentModel';
import { isVoidTag } from '@/lib/drag';
import {
  contentBelow,
  type ForeignContent,
  dependsOnSvgContent,
  isBlockedTag,
  withoutBlockedProps,
  withoutClobberingId,
  refuseSubmit,
  withoutEditorSurfaceProps,
} from '@/lib/renderer/blockedNodes';
import { isTextNodeType, ownTextThenChildren, renderableText } from '@/lib/renderer/textNode';
import { isComponentPlaceholderType } from '@/lib/components/placement';
import { boundValue } from '@/lib/components/expand';
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
import { CommerceErrorBoundary, type CommerceControlKind } from '@/lib/renderer/commerce/CommerceErrorBoundary';
import { createEditorFormElement, formKindOfComponent } from '@/lib/renderer/forms/editorFormElement';
import { isStickyCta } from '@/lib/stickyCta/stickyCta';
import { formKindOf } from '@/lib/forms/definition';
import { createStickyCtaElement } from '@/lib/renderer/stickyCta/stickyCtaElement';

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
  fontFamily: 'system-ui, sans-serif',
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

/** The host ancestors of a node, nearest first. MST nodes only; a tree outside MST has no parent to ask. */
function ancestorsOf(component: ComponentInstance): { type?: unknown; props?: unknown }[] {
  const out: { type?: unknown; props?: unknown }[] = [];
  let current: unknown = component;
  for (let i = 0; i < 256 && isStateTreeNode(current as object) && hasParent(current as object); i++) {
    current = getParent(current as object);
    if (!Array.isArray(current)) out.push(current as { type?: unknown; props?: unknown });
  }
  return out;
}

/** What this node stands in for the HTML parser, when its tag depends on that. */
function foreignContentOf(component: ComponentInstance): ForeignContent {
  if (!dependsOnSvgContent(String(component.type))) return false;
  const types = ancestorsOf(component).map((node) => node.type).filter((type): type is string => typeof type === 'string');
  return types.reduceRight<ForeignContent>((content, type) => contentBelow(type, content), false);
}

/** A stored plain form under a live form: the parser drops it, and React would make it, see FormIsland. */
function isFormInLiveForm(component: ComponentInstance): boolean {
  if (String(component.type).toLowerCase() !== 'form') return false;
  return ancestorsOf(component).some((node) => formKindOf(node.props as Record<string, unknown> | undefined) === 'form');
}

export function createComponentElement(
  component: ComponentInstance,
  finalProps: Record<string, unknown>,
  children: React.ReactNode[],
  rawTextChildren?: React.ReactNode,
  options?: CreateComponentElementOptions,
): React.ReactNode {
  // A bound `visible` that resolves to exactly false takes the node out, as on the
  // published page. Anything else keeps it: a binding that fails shows content.
  if (options?.scope && boundValue(component.bindings?.visible, options.scope) === false) return null;

  // A text node emits no element, so it carries no identity attributes either:
  // the canvas selects its parent element (EditorUIStore.selectComponent).
  if (isTextNodeType(component.type)) return renderableText(rawTextChildren);

  // A `#` type cannot be a tag, and createElement would throw on it.
  if (isComponentPlaceholderType(component.type)) return null;

  // Only a host's type is a tag: otherwise it names an entry of the registry below.
  if (component.isHostElement && isBlockedTag(component.type, foreignContentOf(component))) return null;

  const content = ownTextThenChildren(rawTextChildren, children) as React.ReactNode;
  const identity = options?.identity;
  const surfaceProps = withoutEditorSurfaceProps(component.type, withoutClobberingId(component.type, withoutBlockedProps(finalProps)));
  const safeProps =
    String(component.type).toLowerCase() === 'form' ? { ...surfaceProps, onSubmit: refuseSubmit } : surfaceProps;
  const propsWithIdentity: Record<string, unknown> = identity
    ? {
        ...safeProps,
        'data-component-id': `${identity.breakpointId}-${identity.componentId}`,
        'data-inner-component-id': identity.componentId,
      }
    : safeProps;

  if (component.isHostElement) {
    // The sticky call to action bar draws its own link (src/lib/stickyCta).
    // On the canvas it is a labelled normal block; the preview pins it
    // (HeadlessPageRenderer), the published page through its stylesheet.
    if (isStickyCta(component.props)) {
      return createStickyCtaElement(propsWithIdentity, options?.mode === 'editor' ? 'editor' : 'preview', undefined, finalProps);
    }

    // Form components (data-form-kind): static on the canvas and in the preview,
    // never submitting. The published page renders them as a client island.
    const formKind = formKindOfComponent(component);
    if (formKind) {
      return createEditorFormElement(formKind, component, propsWithIdentity, content);
    }

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
      // Each sits in its own error boundary, so a control that fails shows a
      // message in its place instead of taking down the canvas (or the
      // preview) around it.
      const guarded = (kind: CommerceControlKind, control: React.ReactNode) => (
        <CommerceErrorBoundary kind={kind} hostType={hostType} hostProps={propsWithIdentity}>
          {control}
        </CommerceErrorBoundary>
      );
      if (dataKind === 'cart-view') {
        return guarded(
          'cart-view',
          <CartView
            node={component}
            scope={scope}
            hostType={hostType}
            hostProps={propsWithIdentity}
            mode={mode}
          />,
        );
      }
      if (dataKind === 'checkout-button') {
        return guarded(
          'checkout-button',
          <CheckoutButton
            node={component}
            scope={scope}
            hostType={hostType}
            hostProps={propsWithIdentity}
          />,
        );
      }
      if (dataKind === 'add-to-cart') {
        return guarded(
          'add-to-cart',
          <AddToCartButton
            node={component}
            scope={scope}
            hostType={hostType}
            hostProps={propsWithIdentity}
            mode={mode}
          />,
        );
      }
      if (dataKind === 'variant-selector' && renderNode) {
        return guarded(
          'variant-selector',
          <VariantSelector
            node={component}
            scope={scope}
            renderNode={renderNode}
            hostType={hostType}
            hostProps={propsWithIdentity}
            mode={mode}
          />,
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
            fontFamily: 'system-ui, sans-serif',
            pointerEvents: 'none',
            userSelect: 'none',
          },
        },
        `${label} (no binding)`,
      );
      return React.createElement(component.type as any, propsWithIdentity, placeholder);
    }

    return React.createElement((isFormInLiveForm(component) ? 'div' : component.type) as any, propsWithIdentity, content);
  }

  const Impl = (window as any).__componentRegistry?.[component.type];
  if (Impl) {
    return <Impl {...propsWithIdentity}>{content}</Impl>;
  }

  return null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
// ProductDetailRenderer: the storefront runtime for a BOUND `product-detail`
// data component. The storefront analog of the CMS RecordViewRenderer: one
// resolved record, its children rendered against it.
//
// Resolves a SINGLE product from `{{page.params.handle}}` (the dynamic-route
// param) via `useCommerceDataSource().getProductByHandle`, then resolves that
// product's DEFAULT (first) variant, folds the variant's first price into a
// variant frame, and resolves the variant's advisory availability. It pushes a
// product frame, a variant frame (`{{variant.*}}`, `{{variant.price.*}}`), and
// an availability frame (`{{availability.*}}`) and renders ALL of the node's
// children against them, so descendants resolve `{{product.field}}`,
// `{{variant.price.amountCents}}`, and `{{availability.availableQuantity}}` to
// this product's values.
//
// A missing/unresolved handle, or a `getProductByHandle` that returns null
// (non-existent product) hits the empty path; a failed fetch hits the error
// path. The loading / empty / error / content decision is routed through the
// shared pure `resolveDataState` helper. In editor mode an ERROR shows an
// inline chip with the real message; in preview/headless mode an ERROR renders
// nothing for the slot (no broken layout, no throw during SSR/static emit).
// Errors surface; they are NEVER rendered as a silent success. READ-ONLY: this
// renderer never writes stock, money, or any commerce mutation.
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import type { ComponentInstance } from '@/models/ComponentModel';
import type { BindingScope } from '@/lib/bindings/resolver/scope';
import {
  lookup,
  pushAvailabilityFrame,
  pushProductFrame,
  pushVariantFrame,
} from '@/lib/bindings/resolver/scope';
import type { Row } from '@/lib/bindings/dataSource/types';
import { useCommerceDataSource } from '@/lib/commerce/context';
import type {
  AvailabilityDTO,
  PriceDTO,
  ProductDTO,
  ProductVariantDTO,
} from '@/lib/commerce/types';
import type { RenderNode } from '@/lib/renderer/data/CollectionRenderer';
import {
  resolveDataState,
  type DataStateMode,
} from '@/lib/renderer/data/resolveDataState';

const NOTE_STYLE: React.CSSProperties = {
  color: '#9ca3af',
  fontSize: '12px',
  fontFamily: 'Inter, sans-serif',
  pointerEvents: 'none',
  userSelect: 'none',
};

// Editor-only error chip: visually distinct, carrying the REAL error message
// (the contract: errors surface, never swallow).
const ERROR_CHIP_STYLE: React.CSSProperties = {
  display: 'inline-block',
  color: '#b91c1c',
  background: '#fef2f2',
  border: '1px solid #fecaca',
  borderRadius: '4px',
  padding: '2px 6px',
  fontSize: '12px',
  fontFamily: 'Inter, sans-serif',
  pointerEvents: 'none',
  userSelect: 'none',
};

/** Read a string-valued node prop (e.g. loadingContent / emptyContent),
 *  falling back to `fallback` when absent or not a non-empty string. */
function stringProp(
  props: Record<string, unknown> | undefined,
  key: string,
  fallback: string,
): string {
  const raw = props?.[key];
  return typeof raw === 'string' && raw.length > 0 ? raw : fallback;
}

type FetchState =
  | { status: 'loading' }
  | {
      status: 'ready';
      product: ProductDTO;
      variant: ProductVariantDTO | null;
      price: PriceDTO | undefined;
      availability: AvailabilityDTO | null;
    }
  | { status: 'empty' }
  | { status: 'error'; message: string };

export interface ProductDetailRendererProps {
  node: ComponentInstance;
  scope: BindingScope;
  renderNode: RenderNode;
  /** Host tag for the container wrapper (e.g. `div`). */
  hostType: string;
  /** Already-resolved wrapper props (identity attrs + style + marker). */
  hostProps: Record<string, unknown>;
  /** Rendering surface: editor surfaces error chips, preview renders nothing. */
  mode?: DataStateMode;
}

const ProductDetailRenderer = observer(
  ({ node, scope, renderNode, hostType, hostProps, mode = 'preview' }: ProductDetailRendererProps) => {
    const dataSource = useCommerceDataSource();

    // Product handle from the dynamic-route param: {{page.params.handle}}.
    const rawHandle = lookup(scope, ['page', 'params', 'handle']);
    const handle = typeof rawHandle === 'string' && rawHandle.length > 0 ? rawHandle : null;

    const [state, setState] = React.useState<FetchState>({ status: 'loading' });

    React.useEffect(() => {
      if (!handle) return;
      let active = true;
      const load = () => {
        dataSource
          .getProductByHandle(handle)
          .then(async (product) => {
            if (!active) return;
            if (!product) {
              setState({ status: 'empty' });
              return;
            }
            // Resolve the DEFAULT (first) variant, then fold its first price in
            // and resolve its advisory availability (aggregated across
            // locations). A product with no variants resolves with nulls: the
            // product still renders, price/availability just do not.
            const variants = await dataSource.listVariants(product.id);
            const variant = variants.length > 0 ? variants[0] : null;
            let price: PriceDTO | undefined;
            let availability: AvailabilityDTO | null = null;
            if (variant) {
              const prices = await dataSource.getPrices(variant.id);
              price = prices.length > 0 ? prices[0] : undefined;
              availability = await dataSource.getAvailability(variant.id);
            }
            if (!active) return;
            setState({ status: 'ready', product, variant, price, availability });
          })
          .catch((err: unknown) => {
            if (active) {
              setState({
                status: 'error',
                message: err instanceof Error ? err.message : String(err),
              });
            }
          });
      };
      load();
      // Polling reactivity: re-fetch whenever the provider signals a change for
      // any product (null scope: the productId is not known until resolved).
      const unsubscribe = dataSource.subscribe(null, load);
      return () => {
        active = false;
        unsubscribe();
      };
    }, [dataSource, handle]);

    const wrapperProps = { ...hostProps };
    delete (wrapperProps as any).children;

    const note = (text: string, style: React.CSSProperties = NOTE_STYLE) =>
      React.createElement(
        hostType as any,
        wrapperProps,
        React.createElement('span', { style }, text),
      );

    // Configuration guard (not a fetch state, so outside resolveDataState).
    // No handle in scope (e.g. editor canvas with no route param): empty path.
    if (!handle) return note('Product detail: no product selected');

    // Route the loading/empty/error/content decision through the shared helper.
    // A resolved product is one row; a non-existent product is the empty array.
    const productRows: Row[] | null =
      state.status === 'ready'
        ? [{ id: state.product.id, values: {} }]
        : state.status === 'empty'
          ? []
          : null;

    const directive = resolveDataState({
      isLoading: state.status === 'loading',
      rows: productRows,
      error: state.status === 'error' ? new Error(state.message) : null,
      mode,
    });

    if (directive.kind === 'loading') {
      return note(stringProp(node.props as Record<string, unknown> | undefined, 'loadingContent', 'Loading...'));
    }

    if (directive.kind === 'error') {
      // Editor: an inline chip carrying the real message. Preview/headless:
      // render nothing for the slot (empty wrapper, no broken layout, no throw).
      return directive.message
        ? note(`Failed to load product: ${directive.message}`, ERROR_CHIP_STYLE)
        : React.createElement(hostType as any, wrapperProps);
    }

    if (directive.kind === 'empty') {
      return note(stringProp(node.props as Record<string, unknown> | undefined, 'emptyContent', 'Product not found'));
    }

    // CONTENT: a resolved product. (Guarded for type narrowing; kind 'content'
    // implies a ready product.)
    if (state.status !== 'ready') return React.createElement(hostType as any, wrapperProps);

    // Push product, then the default variant (with its folded price), then the
    // advisory availability, so descendants resolve {{product.*}},
    // {{variant.price.*}}, and {{availability.*}}.
    let productScope = pushProductFrame(scope, state.product);
    if (state.variant) {
      productScope = pushVariantFrame(productScope, state.variant, state.price);
    }
    if (state.availability) {
      productScope = pushAvailabilityFrame(productScope, state.availability);
    }

    const children = node.children.map((child: ComponentInstance) => (
      <React.Fragment key={child.id}>{renderNode(child, productScope)}</React.Fragment>
    ));

    return React.createElement(hostType as any, wrapperProps, children);
  },
);

ProductDetailRenderer.displayName = 'ProductDetailRenderer';
export default ProductDetailRenderer;

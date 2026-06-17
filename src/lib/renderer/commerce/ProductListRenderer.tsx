/* eslint-disable @typescript-eslint/no-explicit-any */
// ProductListRenderer: the storefront runtime for a BOUND `product-list` data
// component. The storefront analog of the CMS CollectionRenderer (Events to
// gallery): one template, N products.
//
// Reads the node's `products` read-binding (the marker that this node is bound
// to the product catalog) plus an OPTIONAL structured `CommerceQuery` on
// `props.query`, calls `useCommerceDataSource().listProducts(query)`, and
// repeats the node's FIRST child (children[0]) once per returned product. Each
// instance is rendered against a scope with a product frame pushed on top, so
// every descendant `{{product.field}}` resolves to that iteration's product.
//
// The renderer OWNS its children construction (it never uses the generic
// `children` the host renderer builds for ordinary nodes) so each repeat gets
// its own `{{product.*}}` scope. It renders the host wrapper element itself so
// identity attributes and the container styling survive.
//
// The loading / empty / error / content decision is routed through the shared
// pure `resolveDataState` helper so the "errors surface, never swallow"
// contract is defined once. In editor mode an ERROR shows an inline chip with
// the real message; in preview/headless mode an ERROR renders nothing for the
// slot (no broken layout, no throw during SSR/static emit). A failed
// `listProducts` or a missing `products` binding ALWAYS reaches the error/empty
// path, never a silent success. READ-ONLY: this renderer never writes stock,
// money, or any commerce mutation.
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import type { ComponentInstance } from '@/models/ComponentModel';
import type { ReadBinding } from '@/lib/bindings/types';
import type { BindingScope } from '@/lib/bindings/resolver/scope';
import { pushProductFrame } from '@/lib/bindings/resolver/scope';
import type { Row } from '@/lib/bindings/dataSource/types';
import { useCommerceDataSource } from '@/lib/commerce/context';
import type { CommerceQuery, ProductDTO } from '@/lib/commerce/types';
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

// Editor-only error chip: visually distinct so a designer sees the failure,
// carrying the REAL error message (the contract: errors surface, never swallow).
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

/**
 * Is this slot a usable products read-binding?
 *
 * The `products` slot is a MARKER that the node is bound to the product
 * catalog: unlike the CMS `collection` slot there is no source id to resolve
 * (`listProducts` lists the whole catalog), so presence of a read-binding is
 * all that gates the fetch. A missing or non-read binding is the configuration
 * guard (treated as the error/empty path, never a silent success).
 */
function hasProductsBinding(binding: ReadBinding | undefined): boolean {
  return !!binding && binding.mode === 'read';
}

type FetchState =
  | { status: 'loading' }
  | { status: 'ready'; products: ProductDTO[] }
  | { status: 'error'; message: string };

export interface ProductListRendererProps {
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

const ProductListRenderer = observer(
  ({ node, scope, renderNode, hostType, hostProps, mode = 'preview' }: ProductListRendererProps) => {
    const dataSource = useCommerceDataSource();

    const bound = hasProductsBinding(node.bindings?.products as ReadBinding | undefined);
    // Structured filter/sort/limit live as a CommerceQuery object on props.query
    // (NOT a template expression). Read the raw structured value off the node.
    const query = (node.props as any)?.query as CommerceQuery | undefined;
    // Stable dependency key so the effect refetches when the query changes by
    // value (the object identity churns on every MST snapshot).
    const queryKey = query ? JSON.stringify(query) : '';

    const [state, setState] = React.useState<FetchState>({ status: 'loading' });

    React.useEffect(() => {
      if (!bound) return;
      let active = true;
      const load = () => {
        dataSource
          .listProducts(query)
          .then((page) => {
            if (active) setState({ status: 'ready', products: page.products });
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
      // any product (null scope: the list is not tied to a single product).
      const unsubscribe = dataSource.subscribe(null, load);
      return () => {
        active = false;
        unsubscribe();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dataSource, bound, queryKey]);

    const wrapperProps = { ...hostProps };
    delete (wrapperProps as any).children;

    const note = (text: string, style: React.CSSProperties = NOTE_STYLE) =>
      React.createElement(
        hostType as any,
        wrapperProps,
        React.createElement('span', { style }, text),
      );

    // Unresolved / missing products binding: surface the error path, never a
    // silent empty success. (A configuration guard, not a fetch state, so it
    // stays outside resolveDataState.)
    if (!bound) {
      return note('Product list: no products source bound');
    }

    // Route the loading/empty/error/content decision through the shared helper.
    // resolveDataState only inspects the array length, so map products to the
    // minimal Row shape it expects (id carried for a stable, real count).
    const productRows: Row[] | null =
      state.status === 'ready'
        ? state.products.map((p) => ({ id: p.id, values: {} }))
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
        ? note(`Failed to load products: ${directive.message}`, ERROR_CHIP_STYLE)
        : React.createElement(hostType as any, wrapperProps);
    }

    if (directive.kind === 'empty') {
      return note(stringProp(node.props as Record<string, unknown> | undefined, 'emptyContent', 'No products'));
    }

    // CONTENT: products present and non-empty.
    const products = state.status === 'ready' ? state.products : [];
    const template = node.children.length > 0 ? node.children[0] : null;

    if (!template) {
      // Bound and populated but nothing to repeat: surface a configuration
      // note rather than rendering an empty success.
      return note('Product list: add a child to use as the product template');
    }

    const items = products.map((product) => {
      const productScope = pushProductFrame(scope, product);
      return <React.Fragment key={product.id}>{renderNode(template, productScope)}</React.Fragment>;
    });

    return React.createElement(hostType as any, wrapperProps, items);
  },
);

ProductListRenderer.displayName = 'ProductListRenderer';
export default ProductListRenderer;

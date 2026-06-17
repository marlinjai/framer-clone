/* eslint-disable @typescript-eslint/no-explicit-any */
// VariantSelector: an interactive storefront control that renders one picker per
// product option, lets the visitor choose a value per option, resolves the
// matching variant by walking the variant<->option_value matrix, and re-pushes
// the SELECTED variant (and its advisory availability) into the binding scope so
// descendant `{{variant.*}}` / `{{availability.*}}` re-resolve to the chosen
// variant. It also publishes the selection through SelectedVariantContext so the
// next spec's add-to-cart control can read the current variant.
//
// SELECTION IS CLIENT-ONLY. Picking a value updates React state only: it is
// NEVER written to MST and NEVER sent to the server. Which Size/Color a visitor
// is eyeing is ephemeral UI state, not a stock or money fact.
//
// AVAILABILITY IS ADVISORY ONLY. `getAvailability` reflects the fire-and-forget
// inventory poll and can be stale the instant it is read. The text it drives
// (In stock / Only N left / Out of stock) is information for the visitor, NOT
// permission to sell: the b3 guarded reserve-at-checkout is the SOLE gate on
// whether stock can actually be taken. Errors from `getAvailability` surface
// (an editor chip / a visible note); they are NEVER swallowed into a silent
// "looks-available" state. READ-ONLY: this component never writes stock, money,
// or any commerce mutation.
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import type { ComponentInstance } from '@/models/ComponentModel';
import type { BindingScope } from '@/lib/bindings/resolver/scope';
import {
  lookup,
  pushAvailabilityFrame,
  pushVariantFrame,
} from '@/lib/bindings/resolver/scope';
import { useCommerceDataSource } from '@/lib/commerce/context';
import type {
  AvailabilityDTO,
  ProductDTO,
  ProductVariantDTO,
} from '@/lib/commerce/types';
import {
  SelectedVariantContext,
  isValueSelectable,
  useVariantSelection,
} from '@/lib/commerce/selection';
import type { RenderNode } from '@/lib/renderer/data/CollectionRenderer';
import type { DataStateMode } from '@/lib/renderer/data/resolveDataState';

const NOTE_STYLE: React.CSSProperties = {
  color: '#9ca3af',
  fontSize: '12px',
  fontFamily: 'Inter, sans-serif',
};

// Editor-only error chip carrying the REAL error message (the contract: errors
// surface, never swallow). Notably an availability fetch failure shows here and
// is NEVER collapsed into a silent "in stock".
const ERROR_CHIP_STYLE: React.CSSProperties = {
  display: 'inline-block',
  color: '#b91c1c',
  background: '#fef2f2',
  border: '1px solid #fecaca',
  borderRadius: '4px',
  padding: '2px 6px',
  fontSize: '12px',
  fontFamily: 'Inter, sans-serif',
};

const OPTION_GROUP_STYLE: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '6px',
  alignItems: 'center',
};

/** Low-stock threshold (advisory only) below which the text names the count. */
export const LOW_STOCK_THRESHOLD = 5;

/**
 * Map an advisory available quantity to display text.
 *
 * ADVISORY ONLY: this reflects the fire-and-forget availability poll, NOT
 * permission to sell. The number can be stale the instant it is read; the b3
 * guarded reserve-at-checkout is the SOLE authority on whether stock can be
 * taken. This text never gates the sale.
 */
export function advisoryAvailabilityText(availableQuantity: number): string {
  if (availableQuantity <= 0) return 'Out of stock';
  if (availableQuantity <= LOW_STOCK_THRESHOLD) return `Only ${availableQuantity} left`;
  return 'In stock';
}

type AvailabilityState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; availability: AvailabilityDTO }
  | { status: 'error'; message: string };

export interface VariantSelectorProps {
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

const VariantSelector = observer(
  ({ node, scope, renderNode, hostType, hostProps, mode = 'preview' }: VariantSelectorProps) => {
    const dataSource = useCommerceDataSource();

    // The product comes from the surrounding product frame (pushed by the
    // ProductDetailRenderer this lives inside). No product frame in scope (e.g.
    // an editor canvas with no product) is the configuration guard below.
    const product = lookup(scope, ['product']) as ProductDTO | undefined;
    const productId = product?.id ?? null;

    // The full variant matrix for this product (the product frame only carries
    // variantIds). Fetched read-only via the data source.
    const [variants, setVariants] = React.useState<ProductVariantDTO[]>([]);
    React.useEffect(() => {
      if (!productId) {
        setVariants([]);
        return;
      }
      let active = true;
      dataSource
        .listVariants(productId)
        .then((rows) => {
          if (active) setVariants(rows);
        })
        .catch(() => {
          // A failed variant fetch leaves the matrix empty: every combo then
          // resolves to no variant (an honest "unselectable" rather than a
          // fabricated selection). Nothing is silently marked available.
          if (active) setVariants([]);
        });
      return () => {
        active = false;
      };
    }, [dataSource, productId]);

    // Client-only selection state (React state; NEVER MST, NEVER the server).
    // Hooks must run unconditionally, so this is called before any early return;
    // a missing product yields an empty-option selection that resolves to null.
    const emptyProduct: ProductDTO = React.useMemo(
      () =>
        product ?? {
          id: '',
          handle: '',
          title: '',
          description: null,
          options: [],
          variantIds: [],
        },
      [product],
    );
    const { selection, variant, setOptionValue } = useVariantSelection(emptyProduct, variants);

    // Advisory availability for the SELECTED variant. Re-fetched read-only on
    // every selection change. Errors surface; they are never swallowed.
    const selectedVariantId = variant?.id ?? null;
    const [availability, setAvailability] = React.useState<AvailabilityState>({ status: 'idle' });
    React.useEffect(() => {
      if (!selectedVariantId) {
        setAvailability({ status: 'idle' });
        return;
      }
      let active = true;
      setAvailability({ status: 'loading' });
      dataSource
        .getAvailability(selectedVariantId)
        .then((dto) => {
          if (active) setAvailability({ status: 'ready', availability: dto });
        })
        .catch((err: unknown) => {
          if (active) {
            setAvailability({
              status: 'error',
              message: err instanceof Error ? err.message : String(err),
            });
          }
        });
      return () => {
        active = false;
      };
    }, [dataSource, selectedVariantId]);

    const wrapperProps = { ...hostProps };
    delete (wrapperProps as any).children;

    // Configuration guard: no product in scope (not a fetch state).
    if (!product) {
      return React.createElement(
        hostType as any,
        wrapperProps,
        React.createElement('span', { style: NOTE_STYLE }, 'Variant selector: no product in scope'),
      );
    }

    // One control per option axis. Each value is a button; a value whose
    // combination resolves to no variant is disabled (greyed-out, unselectable).
    const optionControls = product.options.map((option) => (
      <div
        key={option.id}
        role="group"
        aria-label={option.title}
        data-variant-option={option.id}
        style={OPTION_GROUP_STYLE}
      >
        <span style={NOTE_STYLE}>{option.title}</span>
        {option.values.map((value) => {
          const selectable = isValueSelectable(variants, selection, option.id, value.id);
          const selected = selection[option.id] === value.id;
          return (
            <button
              key={value.id}
              type="button"
              data-variant-value={value.id}
              aria-pressed={selected}
              disabled={!selectable}
              onClick={() => setOptionValue(option.id, value.id)}
              style={{
                padding: '4px 10px',
                border: selected ? '1px solid #111827' : '1px solid #d1d5db',
                borderRadius: '4px',
                background: selected ? '#111827' : '#ffffff',
                color: selected ? '#ffffff' : '#111827',
                cursor: selectable ? 'pointer' : 'not-allowed',
                opacity: selectable ? 1 : 0.4,
              }}
            >
              {value.label}
            </button>
          );
        })}
      </div>
    ));

    // Advisory availability text for the selected variant. ADVISORY ONLY: this
    // is the poll result, NOT permission to sell (reserve-at-checkout is the
    // gate). An error surfaces the real message; it is never a silent "in stock".
    let availabilityNode: React.ReactNode = null;
    if (availability.status === 'loading') {
      availabilityNode = (
        <span data-variant-availability="loading" style={NOTE_STYLE}>
          Checking availability...
        </span>
      );
    } else if (availability.status === 'error') {
      availabilityNode =
        mode === 'editor' ? (
          <span data-variant-availability="error" style={ERROR_CHIP_STYLE}>
            Availability check failed: {availability.message}
          </span>
        ) : (
          // Preview/headless: do NOT render a fake availability. Surface nothing
          // for the slot rather than a silent "looks available" claim.
          <span data-variant-availability="error" style={{ display: 'none' }} />
        );
    } else if (availability.status === 'ready') {
      availabilityNode = (
        <span data-variant-availability="ready" style={NOTE_STYLE}>
          {advisoryAvailabilityText(availability.availability.availableQuantity)}
        </span>
      );
    }

    // Re-push the SELECTED variant (and its advisory availability) so descendant
    // `{{variant.*}}` / `{{availability.*}}` re-resolve to the chosen variant.
    let childScope = scope;
    if (variant) {
      childScope = pushVariantFrame(childScope, variant);
      if (availability.status === 'ready') {
        childScope = pushAvailabilityFrame(childScope, availability.availability);
      }
    }

    const children = node.children.map((child: ComponentInstance) => (
      <React.Fragment key={child.id}>{renderNode(child, childScope)}</React.Fragment>
    ));

    // The selection state is published through context so the add-to-cart spec
    // can read the current variant. This is client-only state, never persisted.
    const selectionState = { selection, variant, setOptionValue };

    return React.createElement(
      hostType as any,
      wrapperProps,
      <SelectedVariantContext.Provider value={selectionState}>
        {optionControls}
        {availabilityNode}
        {children}
      </SelectedVariantContext.Provider>,
    );
  },
);

VariantSelector.displayName = 'VariantSelector';
export default VariantSelector;

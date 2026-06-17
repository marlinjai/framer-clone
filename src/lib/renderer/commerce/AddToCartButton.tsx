/* eslint-disable @typescript-eslint/no-explicit-any */
// AddToCartButton: a storefront control that adds the currently SELECTED variant
// (read from the VariantSelector's `useSelectedVariant()`) to the client-side
// cart (`useCart().add`).
//
// CLIENT-ONLY. Clicking it mutates the client cart (selection state) and
// persists to localStorage. It NEVER writes to the server, never reserves
// stock, never authors money. The cart is a shopping list of intentions; the
// authoritative reservation happens later at order-create.
//
// THE DISABLE IS A UX HINT, NOT THE AUTHORITY. The button disables when there
// is no selected variant, or when the variant's ADVISORY availability reads
// zero (or its advisory fetch has not resolved). Advisory availability is the
// fire-and-forget inventory poll (see AvailabilityDTO): it can be stale the
// instant it is read and is NEVER permission to sell. The b3 guarded
// reserve-at-checkout is the SOLE authority on whether stock can actually be
// taken; this disable only spares the visitor an obviously-futile click.
//
// The advisory-availability fetch is routed through the shared pure
// `resolveDataState` helper, so a fetch error surfaces (an editor chip / a
// silent-but-still-disabled preview) and is NEVER swallowed into a fake
// "available" state.
'use client';
import React from 'react';
import type { ComponentInstance } from '@/models/ComponentModel';
import type { BindingScope } from '@/lib/bindings/resolver/scope';
import type { Row } from '@/lib/bindings/dataSource/types';
import { useCommerceDataSource } from '@/lib/commerce/context';
import { useSelectedVariant } from '@/lib/commerce/selection';
import { useCart } from '@/lib/commerce/cart';
import {
  resolveDataState,
  type DataStateMode,
} from '@/lib/renderer/data/resolveDataState';

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

type AvailabilityState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; availableQuantity: number }
  | { status: 'error'; message: string };

export interface AddToCartButtonProps {
  node: ComponentInstance;
  /** Kept for dispatch-call parity; this control reads selection from context. */
  scope: BindingScope;
  /** Host tag for the wrapper (e.g. `div`). */
  hostType?: string;
  /** Already-resolved wrapper props (identity attrs + style + marker). */
  hostProps?: Record<string, unknown>;
  /** Rendering surface: editor surfaces error chips, preview renders nothing. */
  mode?: DataStateMode;
}

/** Read a positive-integer quantity from a node prop, defaulting to 1. */
function quantityProp(props: Record<string, unknown> | undefined): number {
  const raw = props?.quantity;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return raw;
  return 1;
}

/** Read a string node prop, falling back when absent or empty. */
function stringProp(
  props: Record<string, unknown> | undefined,
  key: string,
  fallback: string,
): string {
  const raw = props?.[key];
  return typeof raw === 'string' && raw.length > 0 ? raw : fallback;
}

function AddToCartButton({
  node,
  hostType = 'div',
  hostProps = {},
  mode = 'preview',
}: AddToCartButtonProps) {
  const dataSource = useCommerceDataSource();
  const { variant } = useSelectedVariant();
  const cart = useCart();

  const selectedVariantId = variant?.id ?? null;

  // Advisory availability for the SELECTED variant, re-fetched read-only on
  // every selection change. Errors surface; they are never swallowed into a
  // silent "available".
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
        if (active) setAvailability({ status: 'ready', availableQuantity: dto.availableQuantity });
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

  // Route the advisory fetch through the shared resolver. A ready availability
  // is one row; an idle (no selection) state is the empty path; an error is the
  // error path. The directive drives the error chip; the disable below is a
  // separate UX-hint decision.
  const rows: Row[] | null =
    availability.status === 'ready'
      ? [{ id: selectedVariantId ?? '', values: {} }]
      : availability.status === 'error'
        ? null
        : [];
  const directive = resolveDataState({
    isLoading: availability.status === 'loading',
    rows,
    error: availability.status === 'error' ? new Error(availability.message) : null,
    mode,
  });

  // UX-HINT DISABLE (never the authority): no selected variant, or the advisory
  // availability is not a positive-quantity "content" state. The reserve at
  // checkout is the real gate; a stale advisory zero only spares a futile click.
  const advisoryQuantity = availability.status === 'ready' ? availability.availableQuantity : 0;
  const disabled = !variant || directive.kind !== 'content' || advisoryQuantity <= 0;

  const quantity = quantityProp(node.props as Record<string, unknown> | undefined);
  const label = stringProp(node.props as Record<string, unknown> | undefined, 'label', 'Add to cart');

  const onClick = () => {
    // Guard mirrors the disable: never add when there is no resolved variant.
    // This is a client cart mutation plus a localStorage persist, NOT a server
    // write and NOT a stock reservation.
    if (!variant) return;
    cart.add(variant.id, quantity);
  };

  const wrapperProps = { ...hostProps };
  delete (wrapperProps as any).children;

  // An availability fetch error surfaces: an editor chip with the real message,
  // nothing in preview/headless. It NEVER becomes a silent "available".
  const errorNode: React.ReactNode =
    directive.kind === 'error' && directive.message ? (
      <span data-add-to-cart-error style={ERROR_CHIP_STYLE}>
        Availability check failed: {directive.message}
      </span>
    ) : null;

  return React.createElement(
    hostType as any,
    wrapperProps,
    <button
      type="button"
      data-add-to-cart
      disabled={disabled}
      aria-disabled={disabled}
      onClick={onClick}
      style={{
        padding: '8px 16px',
        border: '1px solid #111827',
        borderRadius: '6px',
        background: disabled ? '#9ca3af' : '#111827',
        color: '#ffffff',
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontFamily: 'Inter, sans-serif',
        fontSize: '14px',
      }}
    >
      {label}
    </button>,
    errorNode,
  );
}

export default AddToCartButton;

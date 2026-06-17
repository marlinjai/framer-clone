/* eslint-disable @typescript-eslint/no-explicit-any */
// CartView: renders the client-side cart. For each {variantId, quantity} line it
// resolves the variant and its price DTOs FOR DISPLAY, shows a quantity control
// and a remove control, surfaces an ADVISORY-availability warning when the
// advertised availability has dropped below the wanted quantity, and shows a
// DISPLAY-ONLY estimated subtotal.
//
// EVERYTHING HERE IS DISPLAY ONLY. The subtotal is an estimate (see
// `computeDisplaySubtotalCents`): the authoritative total is computed
// server-side at order-create inside Track B's atomic transaction and is never
// trusted from the client. No money is authored here beyond summing the
// integer-cents display prices the data source returns.
//
// THE AVAILABILITY WARNING IS ADVISORY, NOT AUTHORITATIVE, AND NEVER
// AUTO-REMOVES A LINE. Advisory availability is the fire-and-forget inventory
// poll (see AvailabilityDTO); it can be stale the instant it is read and is
// never permission to sell. When it reads below the line's quantity we WARN the
// visitor but keep the line: the b3 guarded reserve-at-checkout is the sole
// authority on what can actually be taken.
//
// READ-ONLY against the server: every per-line fetch is a read routed through
// the shared pure `resolveDataState` helper, so errors surface (an editor chip /
// a silent preview) and are never swallowed. Quantity changes and removals are
// CLIENT cart mutations plus a localStorage persist: no server write happens.
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import type { ComponentInstance } from '@/models/ComponentModel';
import type { BindingScope } from '@/lib/bindings/resolver/scope';
import type { Row } from '@/lib/bindings/dataSource/types';
import { useCommerceDataSource } from '@/lib/commerce/context';
import type {
  AvailabilityDTO,
  PriceDTO,
  ProductVariantDTO,
} from '@/lib/commerce/types';
import { computeDisplaySubtotalCents, useCart, type CartLine } from '@/lib/commerce/cart';
import {
  resolveDataState,
  type DataStateMode,
} from '@/lib/renderer/data/resolveDataState';

const NOTE_STYLE: React.CSSProperties = {
  color: '#9ca3af',
  fontSize: '12px',
  fontFamily: 'Inter, sans-serif',
};

const WARNING_STYLE: React.CSSProperties = {
  color: '#b45309',
  background: '#fffbeb',
  border: '1px solid #fde68a',
  borderRadius: '4px',
  padding: '2px 6px',
  fontSize: '12px',
  fontFamily: 'Inter, sans-serif',
};

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

const LINE_STYLE: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '8px',
  alignItems: 'center',
  padding: '6px 0',
  fontFamily: 'Inter, sans-serif',
  fontSize: '14px',
};

/** Per-line resolved data (read-only). */
type LineData =
  | { status: 'loading' }
  | {
      status: 'ready';
      variant: ProductVariantDTO;
      price: PriceDTO | undefined;
      availability: AvailabilityDTO;
    }
  | { status: 'empty' }
  | { status: 'error'; message: string };

export interface CartViewProps {
  node: ComponentInstance;
  /** Kept for dispatch-call parity; CartView reads its lines from the cart context. */
  scope: BindingScope;
  /** Host tag for the wrapper (e.g. `div`). */
  hostType?: string;
  /** Already-resolved wrapper props (identity attrs + style + marker). */
  hostProps?: Record<string, unknown>;
  /** Rendering surface: editor surfaces error chips, preview renders nothing. */
  mode?: DataStateMode;
}

/**
 * Format an integer-cents amount for DISPLAY ONLY. Never an authoritative price:
 * the figure shown here is an estimate (see CartView header). Falls back to a
 * plain "<major> <CURRENCY>" string if the runtime cannot format the currency.
 */
function formatDisplayMoney(amountCents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
    }).format(amountCents / 100);
  } catch {
    return `${(amountCents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
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

const CartView = observer(
  ({ node, hostType = 'div', hostProps = {}, mode = 'preview' }: CartViewProps) => {
    const dataSource = useCommerceDataSource();
    const cart = useCart();
    const { lines } = cart;

    // The set of variants whose data we need. The fetch keys off the id list
    // only (a quantity change re-renders and recomputes the warning/subtotal
    // from already-resolved data without a refetch).
    const variantIdsKey = lines.map((line) => line.variantId).join('|');

    const [lineData, setLineData] = React.useState<Record<string, LineData>>({});

    React.useEffect(() => {
      const ids = variantIdsKey ? variantIdsKey.split('|') : [];
      if (ids.length === 0) {
        setLineData({});
        return;
      }
      let active = true;

      // Seed a loading placeholder for new ids and prune ids no longer present.
      setLineData((prev) => {
        const next: Record<string, LineData> = {};
        for (const id of ids) next[id] = prev[id] ?? { status: 'loading' };
        return next;
      });

      // Read variant + price + advisory availability for one line. A missing
      // variant is the EMPTY path; a thrown fetch is the ERROR path (surfaced,
      // never a silent success). All three calls are READS.
      const loadOne = async (id: string): Promise<{ id: string; data: LineData }> => {
        try {
          const variant = await dataSource.getVariant(id);
          if (!variant) return { id, data: { status: 'empty' } };
          const [prices, availability] = await Promise.all([
            dataSource.getPrices(id),
            dataSource.getAvailability(id),
          ]);
          return {
            id,
            data: {
              status: 'ready',
              variant,
              price: prices.length > 0 ? prices[0] : undefined,
              availability,
            },
          };
        } catch (err) {
          return {
            id,
            data: {
              status: 'error',
              message: err instanceof Error ? err.message : String(err),
            },
          };
        }
      };

      const load = () => {
        ids.forEach((id) => {
          loadOne(id).then(({ id: resolvedId, data }) => {
            if (active) setLineData((prev) => ({ ...prev, [resolvedId]: data }));
          });
        });
      };

      load();
      // Re-read on any provider change so a dropped advisory availability shows
      // up (the warning is advisory; the line is never auto-removed).
      const unsubscribe = dataSource.subscribe(null, load);
      return () => {
        active = false;
        unsubscribe();
      };
    }, [dataSource, variantIdsKey]);

    const wrapperProps = { ...hostProps };
    delete (wrapperProps as any).children;

    const nodeProps = node.props as Record<string, unknown> | undefined;

    // Empty cart: an honest note, not a fetch state.
    if (lines.length === 0) {
      return React.createElement(
        hostType as any,
        wrapperProps,
        <span data-cart-empty style={NOTE_STYLE}>
          {stringProp(nodeProps, 'emptyContent', 'Your cart is empty')}
        </span>,
      );
    }

    // Build the DISPLAY-ONLY price map from resolved lines, then the estimate.
    // A line whose price has not resolved simply does not contribute (no
    // fabricated money). The subtotal is an ESTIMATE: never authoritative.
    const prices: Record<string, PriceDTO> = {};
    let displayCurrency: string | null = null;
    for (const line of lines) {
      const data = lineData[line.variantId];
      if (data?.status === 'ready' && data.price) {
        prices[line.variantId] = data.price;
        if (!displayCurrency) displayCurrency = data.price.currency;
      }
    }
    const subtotalCents = computeDisplaySubtotalCents(lines, prices);

    const renderLine = (line: CartLine): React.ReactNode => {
      const data = lineData[line.variantId] ?? { status: 'loading' as const };

      // Route the per-line fetch through the shared resolver.
      const rows: Row[] | null =
        data.status === 'ready'
          ? [{ id: line.variantId, values: {} }]
          : data.status === 'empty'
            ? []
            : null;
      const directive = resolveDataState({
        isLoading: data.status === 'loading',
        rows,
        error: data.status === 'error' ? new Error(data.message) : null,
        mode,
      });

      const removeButton = (
        <button
          type="button"
          data-cart-remove={line.variantId}
          onClick={() => cart.remove(line.variantId)}
          style={{
            padding: '2px 8px',
            border: '1px solid #d1d5db',
            borderRadius: '4px',
            background: '#ffffff',
            color: '#111827',
            cursor: 'pointer',
            fontSize: '12px',
          }}
        >
          Remove
        </button>
      );

      if (directive.kind === 'loading') {
        return (
          <div key={line.variantId} data-cart-line={line.variantId} style={LINE_STYLE}>
            <span style={NOTE_STYLE}>Loading...</span>
          </div>
        );
      }

      if (directive.kind === 'error') {
        // Editor: a chip with the real message. Preview/headless: surface
        // nothing for the slot (never a silent success), but keep the remove
        // control so the visitor is not stuck with an unrenderable line.
        return (
          <div key={line.variantId} data-cart-line={line.variantId} style={LINE_STYLE}>
            {directive.message ? (
              <span data-cart-line-error style={ERROR_CHIP_STYLE}>
                Failed to load item: {directive.message}
              </span>
            ) : null}
            {removeButton}
          </div>
        );
      }

      if (directive.kind === 'empty') {
        // The variant no longer resolves. Surface honestly; do NOT auto-remove
        // (the visitor decides).
        return (
          <div key={line.variantId} data-cart-line={line.variantId} style={LINE_STYLE}>
            <span data-cart-line-unavailable style={WARNING_STYLE}>
              This item is no longer available.
            </span>
            {removeButton}
          </div>
        );
      }

      // CONTENT: a resolved, ready line. (Guard for type narrowing.)
      if (data.status !== 'ready') {
        return <div key={line.variantId} data-cart-line={line.variantId} style={LINE_STYLE} />;
      }

      const title = data.variant.title ?? data.variant.id;
      const priceLabel = data.price
        ? formatDisplayMoney(data.price.amountCents, data.price.currency)
        : 'Price unavailable';

      // ADVISORY warning: advertised availability is below the wanted quantity.
      // Advisory only, never authoritative; the line is NOT auto-removed.
      const advisoryShort = data.availability.availableQuantity < line.quantity;

      return (
        <div key={line.variantId} data-cart-line={line.variantId} style={LINE_STYLE}>
          <span data-cart-line-title>{title}</span>
          <span data-cart-line-price style={NOTE_STYLE}>
            {priceLabel}
          </span>
          <label style={NOTE_STYLE}>
            Qty{' '}
            <input
              type="number"
              min={1}
              step={1}
              data-cart-qty={line.variantId}
              value={line.quantity}
              onChange={(event) => {
                const next = parseInt(event.target.value, 10);
                if (Number.isNaN(next)) return;
                // CLIENT cart mutation + localStorage persist; no server write.
                cart.setQuantity(line.variantId, next);
              }}
              style={{
                width: '56px',
                padding: '2px 4px',
                border: '1px solid #d1d5db',
                borderRadius: '4px',
              }}
            />
          </label>
          {removeButton}
          {advisoryShort ? (
            <span data-cart-availability-warning={line.variantId} style={WARNING_STYLE}>
              Only {data.availability.availableQuantity} advertised as available (estimate).
            </span>
          ) : null}
        </div>
      );
    };

    const subtotalLabel =
      displayCurrency != null
        ? formatDisplayMoney(subtotalCents, displayCurrency)
        : `${(subtotalCents / 100).toFixed(2)}`;

    return React.createElement(
      hostType as any,
      wrapperProps,
      <div data-cart-lines>{lines.map(renderLine)}</div>,
      // DISPLAY-ONLY estimate. NOT AUTHORITATIVE: the real total is computed
      // server-side at order-create and is never trusted from the client.
      <div
        data-cart-subtotal
        data-cart-subtotal-cents={subtotalCents}
        style={{ fontFamily: 'Inter, sans-serif', fontSize: '14px', fontWeight: 600 }}
      >
        Estimated subtotal: {subtotalLabel}
      </div>,
      <div data-cart-subtotal-note style={NOTE_STYLE}>
        Estimate only. The final total is calculated at checkout.
      </div>,
    );
  },
);

CartView.displayName = 'CartView';
export default CartView;

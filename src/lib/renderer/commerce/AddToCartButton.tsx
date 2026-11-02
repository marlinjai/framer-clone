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
//
// What the visitor sees is designed in the editor (docs/plans/2026-11-02-designable-shop-controls.md):
// the button, its label, its sold out label and the error message are child
// nodes of the control with a role marker (src/lib/commerce/parts.ts). This file
// owns the behaviour; `addToCartPart` answers, for one state, what each part
// does, for the live control and for the canvas, which previews each state with
// sample data.
'use client';
import React from 'react';
import type { ComponentInstance } from '@/models/ComponentModel';
import type { BindingScope } from '@/lib/bindings/resolver/scope';
import type { Row } from '@/lib/bindings/dataSource/types';
import { useCommerceDataSource } from '@/lib/commerce/context';
import { useOptionalSelectedVariant } from '@/lib/commerce/selection';
import { useCart } from '@/lib/commerce/cart';
import { ADD_TO_CART_PREVIEW_STATES, type ShopLocale } from '@/lib/commerce/parts';
import { ShopDesignContext, ShopLocaleContext, ShopRuntimeContext, type ShopPartRender, type ShopRuntime } from '@/lib/commerce/shopRuntime';
import {
  resolveDataState,
  type DataStateMode,
} from '@/lib/renderer/data/resolveDataState';
import { ShopControlContent } from './ShopControlContent';

type AvailabilityState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; availableQuantity: number; limited: boolean }
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
  /** The control's children as the surface drew them (canvas, Preview); absent on a published page. */
  children?: React.ReactNode;
  /** `canvas`: the design surface, a preview state with sample data and no behaviour. */
  surface?: 'live' | 'canvas';
}

/** Read a positive-integer quantity from a node prop, defaulting to 1. */
function quantityProp(props: Record<string, unknown> | undefined): number {
  const raw = props?.quantity;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return raw;
  return 1;
}

export default function AddToCartButton(props: AddToCartButtonProps) {
  return props.surface === 'canvas' ? <AddToCartCanvas {...props} /> : <AddToCartLive {...props} />;
}

function AddToCartLive({ node, scope, hostType = 'div', hostProps = {}, mode = 'preview', children }: AddToCartButtonProps) {
  const dataSource = useCommerceDataSource();
  const locale = React.useContext(ShopLocaleContext);
  // Optional read: outside a VariantSelector (a misconfigured tree, or a
  // server-side render where no variant is selected yet) this is null and the
  // control degrades to its disabled no-selection state instead of throwing and
  // 500-ing the published page.
  const variant = useOptionalSelectedVariant()?.variant ?? null;
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
        if (active) setAvailability({ status: 'ready', availableQuantity: dto.availableQuantity, limited: dto.limited });
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
  // error path. The directive drives the error message; the disable below is a
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
  // An untracked or back-orderable variant (`limited: false`) is never sold out.
  const soldOut =
    availability.status === 'ready' && availability.limited && availability.availableQuantity <= 0;

  const quantity = quantityProp(node.props as Record<string, unknown> | undefined);

  const onClick = () => {
    // Guard mirrors the disable: never add when there is no resolved variant.
    // This is a client cart mutation plus a localStorage persist, NOT a server
    // write and NOT a stock reservation.
    if (!variant) return;
    cart.add(variant.id, quantity);
  };

  // An availability fetch error surfaces: in the editor with the real message,
  // for the visitor as the shop's plain sentence (never the internal message).
  // It NEVER becomes a silent "available".
  const runtime = addToCartRuntime({
    locale,
    hasVariant: !!variant,
    checking: directive.kind === 'loading',
    content: directive.kind === 'content',
    soldOut,
    error: directive.kind === 'error' ? { message: directive.message ?? null } : null,
    onClick,
  });

  const wrapperProps = { ...hostProps };
  delete (wrapperProps as Record<string, unknown>).children;
  return React.createElement(
    hostType,
    wrapperProps,
    <ShopRuntimeContext.Provider value={runtime}>
      <ShopControlContent node={node} kind="add-to-cart" locale={locale} drawn={children} scope={scope} />
    </ShopRuntimeContext.Provider>,
  );
}

interface AddToCartView {
  locale: ShopLocale;
  hasVariant: boolean;
  /** The advisory availability is being read. */
  checking: boolean;
  /** The advisory availability has been read. */
  content: boolean;
  soldOut: boolean;
  /** The check failed; `message` is the real one in the editor, null for a visitor. */
  error: { message: string | null } | null;
  /** Null on the canvas, where nothing does anything. */
  onClick: (() => void) | null;
}

function addToCartRuntime(view: AddToCartView): ShopRuntime {
  return {
    kind: 'add-to-cart',
    locale: view.locale,
    surface: view.onClick ? 'live' : 'canvas',
    part: (role) => addToCartPart(role, view),
  };
}

function addToCartPart(role: string, view: AddToCartView): ShopPartRender {
  const disabled = !view.hasVariant || !view.content || view.soldOut;
  switch (role) {
    case 'addToCart.button':
      return {
        visible: true,
        props: {
          type: 'button',
          'data-add-to-cart': '',
          disabled,
          'aria-disabled': disabled,
          'aria-busy': view.checking || undefined,
          ...(view.onClick ? { onClick: view.onClick } : {}),
        },
      };
    case 'addToCart.button-label':
      return { visible: !view.soldOut };
    case 'addToCart.button-soldout':
      return { visible: view.soldOut };
    case 'addToCart.error':
      if (!view.error) return { visible: false };
      return {
        visible: true,
        props: { 'data-add-to-cart-error': '', role: 'status' },
        // The editor sees the real reason; a visitor reads the shop's sentence.
        ...(view.error.message ? { text: `Availability check failed: ${view.error.message}` } : {}),
      };
    default:
      return { visible: false };
  }
}

/** The view the canvas shows for a preview state id. */
export function sampleAddToCartView(id: string, locale: ShopLocale): AddToCartView {
  const base: AddToCartView = { locale, hasVariant: true, checking: false, content: true, soldOut: false, error: null, onClick: null };
  switch (id) {
    case 'no-variant':
      return { ...base, hasVariant: false, content: false };
    case 'checking':
      return { ...base, checking: true, content: false };
    case 'sold-out':
      return { ...base, soldOut: true };
    case 'error':
      return { ...base, content: false, error: { message: null } };
    default:
      return base;
  }
}

/** Whether a preview state shows a part and every part around it (outermost first). */
export function addToCartStateShows(id: string, roles: readonly string[], locale: ShopLocale): boolean {
  const view = sampleAddToCartView(id, locale);
  return roles.every((role) => addToCartPart(role, view).visible);
}

/** The first preview state that shows a part. */
export function addToCartStateShowing(roles: readonly string[], locale: ShopLocale): string | undefined {
  return ADD_TO_CART_PREVIEW_STATES.find(({ id }) => addToCartStateShows(id, roles, locale))?.id;
}

/** The control on the canvas: its children as the canvas drew them, in the picked state, with no behaviour. */
function AddToCartCanvas({ node, hostType = 'div', hostProps = {}, children }: AddToCartButtonProps) {
  const locale = React.useContext(ShopLocaleContext);
  const design = React.useContext(ShopDesignContext);
  const id = typeof node.id === 'string' ? node.id : '';
  const runtime = addToCartRuntime(sampleAddToCartView(design?.stateOf(id) ?? 'ready', locale));
  const wrapperProps = { ...hostProps };
  delete (wrapperProps as Record<string, unknown>).children;
  return React.createElement(
    hostType,
    wrapperProps,
    <ShopRuntimeContext.Provider value={runtime}>
      <ShopControlContent node={node} kind="add-to-cart" locale={locale} drawn={children ?? null} />
    </ShopRuntimeContext.Provider>,
  );
}

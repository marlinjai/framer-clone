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
// `resolveDataState` helper, so a fetch error surfaces (the shop's plain
// sentence for the visitor, the real reason in the console, the button still
// disabled) and is NEVER swallowed into a fake "available" state.
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
import { MAX_LINE_QUANTITY, useCart } from '@/lib/commerce/cart';
import { ADD_TO_CART_PREVIEW_STATES, type ShopLocale } from '@/lib/commerce/parts';
import { ShopDesignContext, ShopLocaleContext, ShopRuntimeContext, type ShopPartRender, type ShopRuntime } from '@/lib/commerce/shopRuntime';
import { resolveDataState } from '@/lib/renderer/data/resolveDataState';
import { ShopControlContent } from './ShopControlContent';

type AvailabilityState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; availableQuantity: number; limited: boolean }
  | { status: 'error' };

/** A check's answer, keyed by the variant it is for, so a previous choice's answer never shows. */
type CheckedAvailability = { variantId: string } & ({ status: 'ready'; availableQuantity: number; limited: boolean } | { status: 'error' });

export interface AddToCartButtonProps {
  node: ComponentInstance;
  /** Kept for dispatch-call parity; this control reads selection from context. */
  scope: BindingScope;
  /** Host tag for the wrapper (e.g. `div`). */
  hostType?: string;
  /** Already-resolved wrapper props (identity attrs + style + marker). */
  hostProps?: Record<string, unknown>;
  /** The control's children as the surface drew them (canvas, Preview); absent on a published page. */
  children?: React.ReactNode;
  /** `canvas`: the design surface, a preview state with sample data and no behaviour. */
  surface?: 'live' | 'canvas';
}

/** Read a positive-integer quantity from a node prop, defaulting to 1, at most what a cart line holds. */
function quantityProp(props: Record<string, unknown> | undefined): number {
  const raw = props?.quantity;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return Math.min(MAX_LINE_QUANTITY, raw);
  return 1;
}

export default function AddToCartButton(props: AddToCartButtonProps) {
  return props.surface === 'canvas' ? <AddToCartCanvas {...props} /> : <AddToCartLive {...props} />;
}

function AddToCartLive({ node, scope, hostType = 'div', hostProps = {}, children }: AddToCartButtonProps) {
  const dataSource = useCommerceDataSource();
  const locale = React.useContext(ShopLocaleContext);
  // Optional read: outside a VariantSelector (a misconfigured tree, or a
  // server-side render where no variant is selected yet) this is null and the
  // control degrades to its disabled no-selection state instead of throwing and
  // 500-ing the published page.
  const selected = useOptionalSelectedVariant();
  const variant = selected?.variant ?? null;
  // A variant selector that reads prices says whether the chosen variant's is known:
  // none is added without one, and the button waits while it is read.
  const priceStatus = variant ? selected?.price : undefined;
  const cart = useCart();

  const selectedVariantId = variant?.id ?? null;

  // Advisory availability for the SELECTED variant, re-fetched read-only on
  // every selection change. Errors surface; they are never swallowed into a
  // silent "available".
  const [checked, setChecked] = React.useState<CheckedAvailability | null>(null);
  React.useEffect(() => {
    if (!selectedVariantId) return;
    let active = true;
    dataSource
      .getAvailability(selectedVariantId)
      .then((dto) => {
        if (active) setChecked({ variantId: selectedVariantId, status: 'ready', availableQuantity: dto.availableQuantity, limited: dto.limited });
      })
      .catch((err: unknown) => {
        if (!active) return;
        // The visitor reads the shop's sentence; the real reason is logged, never swallowed.
        console.error(`AddToCartButton: the availability of variant ${selectedVariantId} could not be checked`, err);
        setChecked({ variantId: selectedVariantId, status: 'error' });
      });
    return () => {
      active = false;
    };
  }, [dataSource, selectedVariantId]);
  // Only the selected variant's answer counts: another's means its check is still running.
  const availability: AvailabilityState = !selectedVariantId
    ? { status: 'idle' }
    : checked?.variantId !== selectedVariantId
      ? { status: 'loading' }
      : checked.status === 'ready'
        ? { status: 'ready', availableQuantity: checked.availableQuantity, limited: checked.limited }
        : { status: 'error' };

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
    error: availability.status === 'error' ? new Error('the availability could not be checked') : null,
    // A visitor's surface (the published page, the editor's Preview): no internal message.
    mode: 'preview',
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
    if (!variant || priceStatus === 'loading' || priceStatus === 'missing') return;
    cart.add(variant.id, quantity);
  };

  // An availability fetch error surfaces as the shop's plain sentence (never the
  // internal message). It NEVER becomes a silent "available".
  const runtime = addToCartRuntime({
    locale,
    hasVariant: !!variant,
    checking: directive.kind === 'loading' || priceStatus === 'loading',
    unpriced: priceStatus === 'missing',
    content: directive.kind === 'content',
    soldOut,
    error: directive.kind === 'error',
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
  /** The advisory availability (or the chosen variant's price) is being read. */
  checking: boolean;
  /** The chosen variant's price could not be read, or it has none: it is not added. */
  unpriced: boolean;
  /** The advisory availability has been read. */
  content: boolean;
  soldOut: boolean;
  /** The check failed. */
  error: boolean;
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
  const disabled = !view.hasVariant || !view.content || view.soldOut || view.checking || view.unpriced;
  switch (role) {
    case 'addToCart.button':
      return {
        visible: true,
        // Native `disabled` tells assistive technology the button cannot be
        // pressed, so no `aria-disabled` is drawn; the designer's copy of either
        // (and of `tabindex`) never reaches the page (SHOP_RUNTIME_OWNED_PROPS).
        props: {
          type: 'button',
          'data-add-to-cart': '',
          disabled,
          'aria-busy': view.checking || undefined,
          ...(view.onClick ? { onClick: view.onClick } : {}),
        },
      };
    case 'addToCart.button-label':
      return { visible: !view.soldOut };
    case 'addToCart.button-soldout':
      return { visible: view.soldOut };
    case 'addToCart.error':
      // Announced when it shows: its status region is on the page before it (ShopPartRender.live).
      if (!view.error) return { visible: false, live: true };
      return { visible: true, live: true, props: { 'data-add-to-cart-error': '' } };
    default:
      return { visible: false };
  }
}

/** The view the canvas shows for a preview state id. */
export function sampleAddToCartView(id: string, locale: ShopLocale): AddToCartView {
  const base: AddToCartView = { locale, hasVariant: true, checking: false, unpriced: false, content: true, soldOut: false, error: false, onClick: null };
  switch (id) {
    case 'no-variant':
      return { ...base, hasVariant: false, content: false };
    case 'checking':
      return { ...base, checking: true, content: false };
    case 'sold-out':
      return { ...base, soldOut: true };
    case 'error':
      return { ...base, content: false, error: true };
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

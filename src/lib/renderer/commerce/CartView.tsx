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
//
// What the visitor sees is designed in the editor (docs/plans/2026-11-02-designable-shop-controls.md):
// the empty message, a line template (name, price, quantity, remove, the warning
// and the per line states), the subtotal and its notice are child nodes of the
// control with a role marker (src/lib/commerce/parts.ts). The line template is
// drawn once per cart line, each copy reading its own line. This file owns the
// data and the behaviour; `cartPart` answers, for one state, what each part does,
// for the live control and for the canvas, which previews each state with sample
// lines.
'use client';
import React from 'react';
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
import { lineTitle } from '@/lib/commerce/lineTitle';
import {
  resolveDataState,
  type DataStateMode,
} from '@/lib/renderer/data/resolveDataState';
import { CART_PREVIEW_STATES, type ShopLocale } from '@/lib/commerce/parts';
import { ShopDesignContext, ShopLocaleContext, ShopRuntimeContext, type ShopPartRender, type ShopRuntime } from '@/lib/commerce/shopRuntime';
import { ShopControlContent } from './ShopControlContent';

/** Per-line resolved data (read-only). */
type LineData =
  | { status: 'loading' }
  | {
      status: 'ready';
      variant: ProductVariantDTO;
      /** The product's title, or null when the product could not be read (the line still shows). */
      productTitle: string | null;
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
  /** The control's children as the surface drew them (canvas, Preview); absent on a published page. */
  children?: React.ReactNode;
  /** `canvas`: the design surface, a preview state with sample lines and no behaviour. */
  surface?: 'live' | 'canvas';
}

/**
 * Format an integer-cents amount for DISPLAY ONLY. Never an authoritative price:
 * the figure shown here is an estimate (see CartView header). Falls back to a
 * plain "<major> <CURRENCY>" string if the runtime cannot format the currency.
 */
function formatDisplayMoney(amountCents: number, currency: string, locale: ShopLocale = 'en'): string {
  try {
    return new Intl.NumberFormat(locale === 'de' ? 'de-DE' : undefined, {
      style: 'currency',
      currency,
    }).format(amountCents / 100);
  } catch {
    return `${(amountCents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

export default function CartView(props: CartViewProps) {
  return props.surface === 'canvas' ? <CartCanvas {...props} /> : <CartLive {...props} />;
}

function CartLive({ node, scope, hostType = 'div', hostProps = {}, mode = 'preview', children }: CartViewProps) {
  const dataSource = useCommerceDataSource();
  const locale = React.useContext(ShopLocaleContext);
  const idBase = React.useId();
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

    // Read variant + product + price + advisory availability for one line. A
    // missing variant is the EMPTY path; a thrown fetch is the ERROR path
    // (surfaced, never a silent success). All four calls are READS. The product
    // only names the line, so a product that cannot be read leaves the line
    // named by its variant instead of failing it.
    const loadOne = async (id: string): Promise<{ id: string; data: LineData }> => {
      try {
        const variant = await dataSource.getVariant(id);
        if (!variant) return { id, data: { status: 'empty' } };
        const [product, prices, availability] = await Promise.all([
          dataSource.getProduct(variant.productId).catch((err: unknown) => {
            console.error(`CartView: the product of variant ${id} could not be read; the line is named by its variant`, err);
            return null;
          }),
          dataSource.getPrices(id),
          dataSource.getAvailability(id),
        ]);
        return {
          id,
          data: {
            status: 'ready',
            variant,
            productTitle: product?.title ?? null,
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

  const lineView = (line: CartLine): LineView => {
    const data = lineData[line.variantId] ?? { status: 'loading' as const };
    // Route the per-line fetch through the shared resolver.
    const rows: Row[] | null =
      data.status === 'ready' ? [{ id: line.variantId, values: {} }] : data.status === 'empty' ? [] : null;
    const directive = resolveDataState({
      isLoading: data.status === 'loading',
      rows,
      error: data.status === 'error' ? new Error(data.message) : null,
      mode,
    });
    if (directive.kind === 'loading') return { kind: 'loading' };
    // Editor: the real message. Preview / published: the shop's plain sentence
    // (never the internal message, never a silent success), with the remove control.
    if (directive.kind === 'error') return { kind: 'error', message: directive.message ?? null };
    // The variant no longer resolves. Surface honestly; do NOT auto-remove (the visitor decides).
    if (directive.kind === 'empty' || data.status !== 'ready') return { kind: 'unavailable' };
    return {
      kind: 'ready',
      // Named as on the receipt (src/lib/commerce/lineTitle.ts), never by an id.
      title: lineTitle(data.productTitle, data.variant.title, data.variant.sku, 'Item'),
      price: data.price ? formatDisplayMoney(data.price.amountCents, data.price.currency, locale) : locale === 'de' ? 'Preis nicht verfügbar' : 'Price unavailable',
      // ADVISORY warning: advertised availability is below the wanted quantity.
      // Advisory only, never authoritative; the line is NOT auto-removed.
      shortOf: data.availability.limited && data.availability.availableQuantity < line.quantity ? data.availability.availableQuantity : null,
    };
  };

  // DISPLAY-ONLY estimate. NOT AUTHORITATIVE: the real total is computed
  // server-side at order-create and is never trusted from the client.
  const subtotal =
    displayCurrency != null ? formatDisplayMoney(subtotalCents, displayCurrency, locale) : `${(subtotalCents / 100).toFixed(2)}`;

  const runtime = cartRuntime({
    locale,
    lines: lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity, view: lineView(line) })),
    subtotal,
    subtotalCents,
    idBase,
    handlers: {
      // CLIENT cart mutations + localStorage persist; no server write.
      setQuantity: (variantId, quantity) => cart.setQuantity(variantId, quantity),
      remove: (variantId) => cart.remove(variantId),
    },
  });

  const wrapperProps = { ...hostProps };
  delete (wrapperProps as Record<string, unknown>).children;
  return React.createElement(
    hostType,
    wrapperProps,
    <ShopRuntimeContext.Provider value={runtime}>
      <ShopControlContent node={node} kind="cart-view" locale={locale} drawn={children} scope={scope} />
    </ShopRuntimeContext.Provider>,
  );
}

/** What one line shows. */
type LineView =
  | { kind: 'loading' }
  | { kind: 'error'; message: string | null }
  | { kind: 'unavailable' }
  | { kind: 'ready'; title: string; price: string; shortOf: number | null };

interface CartViewModel {
  locale: ShopLocale;
  lines: { variantId: string; quantity: number; view: LineView }[];
  subtotal: string;
  subtotalCents: number;
  /** Unique to the control, for the ids that tie a quantity input to its label. */
  idBase: string;
  /** Null on the canvas, where nothing does anything. */
  handlers: { setQuantity: (variantId: string, quantity: number) => void; remove: (variantId: string) => void } | null;
}

function cartRuntime(model: CartViewModel): ShopRuntime {
  return {
    kind: 'cart-view',
    locale: model.locale,
    surface: model.handlers ? 'live' : 'canvas',
    part: (role) => cartPart(role, model),
  };
}

function cartPart(role: string, model: CartViewModel): ShopPartRender {
  const empty = model.lines.length === 0;
  switch (role) {
    case 'cart.empty':
      // An honest note, not a fetch state.
      return empty ? { visible: true, props: { 'data-cart-empty': '' } } : { visible: false };
    case 'cart.lines':
      return empty ? { visible: false } : { visible: true, props: { 'data-cart-lines': '' } };
    case 'cart.line':
      if (empty) return { visible: false };
      return {
        visible: true,
        items: model.lines.map((line) => ({
          key: line.variantId,
          tokens: {},
          props: { 'data-cart-line': line.variantId },
          runtime: lineRuntime(line, model),
        })),
      };
    case 'cart.subtotal':
      return empty
        ? { visible: false }
        : { visible: true, tokens: { subtotal: model.subtotal }, props: { 'data-cart-subtotal': '', 'data-cart-subtotal-cents': model.subtotalCents } };
    case 'cart.subtotal-note':
      return empty ? { visible: false } : { visible: true, props: { 'data-cart-subtotal-note': '' } };
    default:
      // A line's own parts outside a line have nothing to show.
      return { visible: false };
  }
}

/** The runtime one copy of the line template reads. */
function lineRuntime(line: CartViewModel['lines'][number], model: CartViewModel): ShopRuntime {
  return {
    kind: 'cart-view',
    locale: model.locale,
    surface: model.handlers ? 'live' : 'canvas',
    part: (role) => linePart(role, line, model),
  };
}

function linePart(role: string, line: CartViewModel['lines'][number], model: CartViewModel): ShopPartRender {
  const { view, variantId } = line;
  const handlers = model.handlers;
  const ready = view.kind === 'ready';
  switch (role) {
    case 'cart.line-title':
      return ready ? { visible: true, tokens: { title: view.title }, props: { 'data-cart-line-title': '' } } : { visible: false };
    case 'cart.line-price':
      return ready ? { visible: true, tokens: { price: view.price }, props: { 'data-cart-line-price': '' } } : { visible: false };
    // Each quantity input is named by its label, whatever the layout: the label points
    // at the input, the input at the label's text.
    case 'cart.line-qty':
      return ready ? { visible: true, props: { htmlFor: `${model.idBase}-${variantId}-qty` } } : { visible: false };
    case 'cart.line-qty-text':
      return ready ? { visible: true, props: { id: `${model.idBase}-${variantId}-qty-label` } } : { visible: false };
    case 'cart.line-qty-input':
      if (!ready) return { visible: false };
      return {
        visible: true,
        props: {
          id: `${model.idBase}-${variantId}-qty`,
          'aria-labelledby': `${model.idBase}-${variantId}-qty-label`,
          type: 'number',
          min: 1,
          step: 1,
          'data-cart-qty': variantId,
          value: line.quantity,
          ...(handlers
            ? {
                onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
                  const next = parseInt(event.target.value, 10);
                  if (Number.isNaN(next)) return;
                  handlers.setQuantity(variantId, next);
                },
              }
            : { readOnly: true, tabIndex: -1 }),
        },
      };
    case 'cart.line-remove':
      // Every settled line can be removed, so a visitor is never stuck with one.
      if (view.kind === 'loading') return { visible: false };
      return {
        visible: true,
        props: { type: 'button', 'data-cart-remove': variantId, ...(handlers ? { onClick: () => handlers.remove(variantId) } : {}) },
      };
    case 'cart.line-warning':
      return ready && view.shortOf !== null
        ? { visible: true, tokens: { available: String(view.shortOf) }, props: { 'data-cart-availability-warning': variantId } }
        : { visible: false };
    case 'cart.line-loading':
      return { visible: view.kind === 'loading' };
    case 'cart.line-unavailable':
      return view.kind === 'unavailable' ? { visible: true, props: { 'data-cart-line-unavailable': '' } } : { visible: false };
    case 'cart.line-error':
      if (view.kind !== 'error') return { visible: false };
      return {
        visible: true,
        props: { 'data-cart-line-error': '', role: 'status' },
        ...(view.message ? { text: `Failed to load item: ${view.message}` } : {}),
      };
    default:
      return { visible: false };
  }
}

const SAMPLE = {
  en: { tee: 'Classic Tee, Small / Red', mug: 'Enamel Mug', price: (cents: number) => formatDisplayMoney(cents, 'EUR', 'en') },
  de: { tee: 'Klassisches T-Shirt, S / Rot', mug: 'Emaille-Becher', price: (cents: number) => formatDisplayMoney(cents, 'EUR', 'de') },
} as const;

/** The model the canvas shows for a preview state id, with sample lines. */
export function sampleCartModel(id: string, locale: ShopLocale): CartViewModel {
  const text = SAMPLE[locale];
  const tee = { variantId: 'sample-tee', quantity: 2, view: { kind: 'ready', title: text.tee, price: text.price(2500), shortOf: null } as LineView };
  const mug = { variantId: 'sample-mug', quantity: 1, view: { kind: 'ready', title: text.mug, price: text.price(1490), shortOf: null } as LineView };
  const model = (lines: CartViewModel['lines'], cents: number): CartViewModel => ({
    locale,
    lines,
    subtotal: text.price(cents),
    subtotalCents: cents,
    idBase: 'cart-sample',
    handlers: null,
  });
  switch (id) {
    case 'empty':
      return model([], 0);
    case 'loading':
      return model([{ ...tee, view: { kind: 'loading' } }, { ...mug, view: { kind: 'loading' } }], 0);
    case 'low-stock':
      return model([{ ...tee, view: { ...(tee.view as Extract<LineView, { kind: 'ready' }>), shortOf: 1 } }, mug], 6490);
    case 'unavailable':
      return model([tee, { ...mug, view: { kind: 'unavailable' } }], 5000);
    case 'error':
      return model([tee, { ...mug, view: { kind: 'error', message: null } }], 5000);
    default:
      return model([tee, mug], 6490);
  }
}

/** Whether a preview state shows a part and every part around it (outermost first); a line part shows in any line. */
export function cartStateShows(id: string, roles: readonly string[], locale: ShopLocale): boolean {
  const model = sampleCartModel(id, locale);
  return roles.every((role) => {
    if (cartPart(role, model).visible) return true;
    return model.lines.some((line) => linePart(role, line, model).visible);
  });
}

/** The first preview state that shows a part. */
export function cartStateShowing(roles: readonly string[], locale: ShopLocale): string | undefined {
  return CART_PREVIEW_STATES.find(({ id }) => cartStateShows(id, roles, locale))?.id;
}

/** The control on the canvas: its children as the canvas drew them, in the picked state, with sample lines. */
function CartCanvas({ node, hostType = 'div', hostProps = {}, children }: CartViewProps) {
  const locale = React.useContext(ShopLocaleContext);
  const design = React.useContext(ShopDesignContext);
  const id = typeof node.id === 'string' ? node.id : '';
  const runtime = cartRuntime(sampleCartModel(design?.stateOf(id) ?? 'ready', locale));
  const wrapperProps = { ...hostProps };
  delete (wrapperProps as Record<string, unknown>).children;
  return React.createElement(
    hostType,
    wrapperProps,
    <ShopRuntimeContext.Provider value={runtime}>
      <ShopControlContent node={node} kind="cart-view" locale={locale} drawn={children ?? null} />
    </ShopRuntimeContext.Provider>,
  );
}

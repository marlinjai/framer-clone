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
// the shared pure `resolveDataState` helper, so errors surface and are never
// swallowed: the visitor reads the shop's plain sentence on the failed line (both
// live surfaces, the published page and the editor's Preview, are a visitor's),
// and the real message goes to the console. Quantity changes and removals are
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
import { cartLineQuantity, computeDisplaySubtotalCents, useCart, type CartLine } from '@/lib/commerce/cart';
import { lineTitle } from '@/lib/commerce/lineTitle';
import { resolveDataState } from '@/lib/renderer/data/resolveDataState';
import { CART_PREVIEW_STATES, shopPartText, type ShopLocale } from '@/lib/commerce/parts';
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
  | { status: 'error' };

export interface CartViewProps {
  node: ComponentInstance;
  /** Kept for dispatch-call parity; CartView reads its lines from the cart context. */
  scope: BindingScope;
  /** Host tag for the wrapper (e.g. `div`). */
  hostType?: string;
  /** Already-resolved wrapper props (identity attrs + style + marker). */
  hostProps?: Record<string, unknown>;
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

/** The cart's own words around the figures, in the site language. */
const CART_TEXTS = {
  en: {
    priceUnavailable: 'Price unavailable',
    // Said after the estimate notice while a line is not counted in the subtotal.
    partial: 'Items still loading or not available are not counted.',
  },
  de: {
    priceUnavailable: 'Preis nicht verfügbar',
    partial: 'Noch ladende oder nicht verfügbare Artikel sind nicht eingerechnet.',
  },
} as const satisfies Readonly<Record<ShopLocale, Readonly<Record<string, string>>>>;

/** The subtotal shown before any price is known: never a bare 0.00 without its currency. */
const NO_SUBTOTAL = '-';

/**
 * The subtotal as the visitor reads it: the formatted estimate, or a placeholder
 * when no line's price is known yet. DISPLAY ONLY, never authoritative.
 */
function subtotalText(cents: number, currency: string | null, locale: ShopLocale): string {
  return currency != null ? formatDisplayMoney(cents, currency, locale) : NO_SUBTOTAL;
}

export default function CartView(props: CartViewProps) {
  return props.surface === 'canvas' ? <CartCanvas {...props} /> : <CartLive {...props} />;
}

function CartLive({ node, scope, hostType = 'div', hostProps = {}, children }: CartViewProps) {
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
  // What the visitor has typed into a quantity field while editing it, per line: a
  // blank or a lone minus sign stays in the field instead of the stored quantity
  // snapping back under the next keystroke. No entry: the field shows the stored quantity.
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});

  // A draft lives only while its field does: the field is drawn for a line that is
  // ready, so a line removed, failed or loading again takes its draft with it (the
  // input unmounts without a blur), and a line that loads again shows its stored
  // quantity. A ready line re-read in the background keeps the edit in progress.
  React.useEffect(() => {
    setDrafts((prev) => {
      const kept = Object.fromEntries(Object.entries(prev).filter(([id]) => lineData[id]?.status === 'ready'));
      return Object.keys(kept).length === Object.keys(prev).length ? prev : kept;
    });
  }, [lineData]);

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
        // The visitor reads the shop's sentence on the line; the real reason is logged, never swallowed.
        console.error(`CartView: the line of variant ${id} could not be loaded`, err);
        return { id, data: { status: 'error' } };
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
  // A line still loading, failed, no longer sold or without a price is not counted: the subtotal says so.
  let partial = false;
  for (const line of lines) {
    const data = lineData[line.variantId];
    if (data?.status === 'ready' && data.price) {
      prices[line.variantId] = data.price;
      if (!displayCurrency) displayCurrency = data.price.currency;
    } else {
      partial = true;
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
      error: data.status === 'error' ? new Error('the line could not be loaded') : null,
      // A visitor's surface: the error carries no internal message.
      mode: 'preview',
    });
    if (directive.kind === 'loading') return { kind: 'loading' };
    // The shop's plain sentence (never the internal message, never a silent
    // success), with the remove control.
    if (directive.kind === 'error') return { kind: 'error' };
    // The variant no longer resolves. Surface honestly; do NOT auto-remove (the visitor decides).
    if (directive.kind === 'empty' || data.status !== 'ready') return { kind: 'unavailable' };
    return {
      kind: 'ready',
      // Named as on the receipt (src/lib/commerce/lineTitle.ts), never by an id.
      title: lineTitle(data.productTitle, data.variant.title, data.variant.sku, 'Item'),
      price: data.price ? formatDisplayMoney(data.price.amountCents, data.price.currency, locale) : CART_TEXTS[locale].priceUnavailable,
      // ADVISORY warning: advertised availability is below the wanted quantity.
      // Advisory only, never authoritative; the line is NOT auto-removed.
      shortOf: data.availability.limited && data.availability.availableQuantity < line.quantity ? data.availability.availableQuantity : null,
    };
  };

  // DISPLAY-ONLY estimate. NOT AUTHORITATIVE: the real total is computed
  // server-side at order-create and is never trusted from the client.
  const subtotal = subtotalText(subtotalCents, displayCurrency, locale);

  // Where the keyboard goes when a line is removed: the next line's remove button,
  // else the previous one's, else (the cart now empty) the empty message. When other
  // lines remain but none has a remove button drawn (all still loading), the lines
  // themselves (or the subtotal), so the focus never falls to the page body.
  const host = React.useRef<HTMLElement | null>(null);
  const focusEmpty = React.useRef(false);
  React.useEffect(() => {
    if (!focusEmpty.current || lines.length > 0) return;
    focusEmpty.current = false;
    host.current?.querySelector<HTMLElement>('[data-cart-empty]')?.focus();
  }, [lines.length]);
  const removeLine = (variantId: string) => {
    const at = lines.findIndex((line) => line.variantId === variantId);
    const buttons = [...(host.current?.querySelectorAll<HTMLElement>('[data-cart-remove]') ?? [])];
    const button = (id: string) => buttons.find((candidate) => candidate.getAttribute('data-cart-remove') === id);
    const target = [...lines.slice(at + 1), ...lines.slice(0, Math.max(at, 0)).reverse()].map((line) => button(line.variantId)).find(Boolean);
    // The other lines keep their elements (keyed by variant), so focus moves before the line goes.
    // A button the design hides (display: none, visibility: hidden) is drawn but takes no
    // focus, so the move is checked, and one that did not land falls back as below.
    target?.focus();
    const moved = !!target && target.ownerDocument.activeElement === target;
    if (!moved) {
      if (lines.length === 1) focusEmpty.current = true;
      else host.current?.querySelector<HTMLElement>('[data-cart-lines], [data-cart-subtotal]')?.focus();
    }
    cart.remove(variantId);
  };

  const runtime = cartRuntime({
    locale,
    lines: lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity, view: lineView(line) })),
    subtotal,
    subtotalCents,
    partial,
    idBase,
    handlers: {
      // CLIENT cart mutations + localStorage persist; no server write.
      setQuantity: (variantId, quantity) => cart.setQuantity(variantId, quantity),
      remove: removeLine,
      draft: (variantId, value) =>
        setDrafts((prev) => {
          if (value !== null) return { ...prev, [variantId]: value };
          const next = { ...prev };
          delete next[variantId];
          return next;
        }),
    },
    drafts,
  });

  const outerRef = (hostProps as { ref?: unknown }).ref;
  const hostRef = React.useCallback(
    (element: HTMLElement | null) => {
      host.current = element;
      if (typeof outerRef === 'function') (outerRef as (element: HTMLElement | null) => void)(element);
      else if (outerRef && typeof outerRef === 'object' && 'current' in outerRef) (outerRef as { current: HTMLElement | null }).current = element;
    },
    [outerRef],
  );
  const wrapperProps: Record<string, unknown> = { ...hostProps, ref: hostRef };
  delete wrapperProps.children;
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
  | { kind: 'error' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; title: string; price: string; shortOf: number | null };

interface CartViewModel {
  locale: ShopLocale;
  lines: { variantId: string; quantity: number; view: LineView }[];
  subtotal: string;
  subtotalCents: number;
  /** A line is not counted in the subtotal (loading, failed, no longer sold or without a price). */
  partial: boolean;
  /** Unique to the control, for the ids that tie a quantity input to its label and a line's controls to its title. */
  idBase: string;
  /** Null on the canvas, where nothing does anything. */
  handlers: {
    setQuantity: (variantId: string, quantity: number) => void;
    remove: (variantId: string) => void;
    /** Keeps what is typed in a line's quantity field while it is edited; null ends the edit. */
    draft: (variantId: string, value: string | null) => void;
  } | null;
  /** What is typed in each quantity field being edited (see CartLive). */
  drafts?: Readonly<Record<string, string>>;
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
      // An honest note, not a fetch state. Live it takes the focus when the last line is removed.
      return empty ? { visible: true, props: { 'data-cart-empty': '', ...(model.handlers ? { tabIndex: -1 } : {}) } } : { visible: false };
    case 'cart.lines':
      // Live it takes the focus when a removed line leaves no remove button to go to.
      return empty ? { visible: false } : { visible: true, props: { 'data-cart-lines': '', ...(model.handlers ? { tabIndex: -1 } : {}) } };
    case 'cart.line':
      if (empty) return { visible: false };
      return {
        visible: true,
        items: model.lines.map((line, index) => ({
          key: line.variantId,
          tokens: {},
          props: { 'data-cart-line': line.variantId },
          runtime: lineRuntime(line, model, index),
        })),
      };
    case 'cart.subtotal':
      return empty
        ? { visible: false }
        : {
            visible: true,
            tokens: { subtotal: model.subtotal },
            props: { 'data-cart-subtotal': '', ...(model.handlers ? { tabIndex: -1 } : {}), 'data-cart-subtotal-cents': model.subtotalCents, 'data-cart-subtotal-partial': model.partial ? '' : undefined },
          };
    case 'cart.subtotal-note':
      if (empty) return { visible: false };
      // A subtotal that leaves a line out says so, after the fixed estimate notice.
      return {
        visible: true,
        props: { 'data-cart-subtotal-note': '' },
        ...(model.partial ? { text: `${String(shopPartText(role, undefined, model.locale))} ${CART_TEXTS[model.locale].partial}` } : {}),
      };
    default:
      // A line's own parts outside a line have nothing to show.
      return { visible: false };
  }
}

/** The runtime one copy of the line template reads. */
function lineRuntime(line: CartViewModel['lines'][number], model: CartViewModel, index: number): ShopRuntime {
  return {
    kind: 'cart-view',
    locale: model.locale,
    surface: model.handlers ? 'live' : 'canvas',
    part: (role) => linePart(role, line, model, index),
  };
}

function linePart(role: string, line: CartViewModel['lines'][number], model: CartViewModel, index: number): ShopPartRender {
  const { view, variantId } = line;
  const handlers = model.handlers;
  const ready = view.kind === 'ready';
  // What a screen reader names a line's remove button and quantity input by, beside
  // their own words: the line's title, or the sentence a line without one shows. Unique
  // per control (idBase) and per line (index), so copies and controls never share one.
  const describedBy = `${model.idBase}-line-${index}-about`;
  switch (role) {
    case 'cart.line-title':
      return ready ? { visible: true, tokens: { title: view.title }, props: { 'data-cart-line-title': '', id: describedBy } } : { visible: false };
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
          'aria-describedby': describedBy,
          'data-cart-qty': variantId,
          // While the visitor edits the field it shows what they typed; otherwise the stored quantity.
          value: model.drafts?.[variantId] ?? String(line.quantity),
          disabled: false,
          ...(handlers
            ? {
                readOnly: false,
                tabIndex: undefined,
                onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
                  // The field keeps what is typed, a blank too, so clearing "2" and
                  // typing "5" gives 5. Only a number changes the line; zero or less
                  // is one. Removing a line is the remove button's, never the input's.
                  // Read as a number ("1e3" is 1000, "2.7" is 2), from one up to what the order
                  // route can store; a blank or an unreadable entry changes nothing.
                  handlers.draft(variantId, event.target.value);
                  const next = cartLineQuantity(event.target.value);
                  if (next !== null) handlers.setQuantity(variantId, next);
                },
                // Leaving the field ends the edit: a blank or unreadable entry shows the stored quantity again.
                onBlur: () => handlers.draft(variantId, null),
              }
            : { readOnly: true, tabIndex: -1 }),
        },
      };
    case 'cart.line-remove':
      // Every settled line can be removed, so a visitor is never stuck with one; a
      // line no longer sold or failed to load keeps its remove button in sight
      // whatever the design says, since its quantity cannot go below one.
      if (view.kind === 'loading') return { visible: false };
      return {
        visible: true,
        ...(view.kind === 'unavailable' || view.kind === 'error' ? { keepInSight: true as const } : {}),
        props: { type: 'button', disabled: false, 'aria-describedby': describedBy, 'data-cart-remove': variantId, ...(handlers ? { onClick: () => handlers.remove(variantId) } : {}) },
      };
    case 'cart.line-warning':
      return ready && view.shortOf !== null
        ? { visible: true, tokens: { available: String(view.shortOf) }, props: { 'data-cart-availability-warning': variantId } }
        : { visible: false };
    case 'cart.line-loading':
      return { visible: view.kind === 'loading' };
    case 'cart.line-unavailable':
      return view.kind === 'unavailable' ? { visible: true, props: { 'data-cart-line-unavailable': '', id: describedBy } } : { visible: false };
    case 'cart.line-error':
      if (view.kind !== 'error') return { visible: false };
      return { visible: true, props: { 'data-cart-line-error': '', role: 'status', id: describedBy } };
    default:
      return { visible: false };
  }
}

const SAMPLE = {
  en: { tee: 'Classic Tee, Small / Red', mug: 'Enamel Mug', price: (cents: number) => formatDisplayMoney(cents, 'EUR', 'en') },
  de: { tee: 'Klassisches T-Shirt, S / Rot', mug: 'Emaille-Becher', price: (cents: number) => formatDisplayMoney(cents, 'EUR', 'de') },
} as const;

/** The model the canvas shows for a preview state id, with sample lines. */
export function sampleCartModel(id: string, locale: ShopLocale, idBase = 'cart-sample'): CartViewModel {
  const text = SAMPLE[locale];
  const tee = { variantId: 'sample-tee', quantity: 2, view: { kind: 'ready', title: text.tee, price: text.price(2500), shortOf: null } as LineView };
  const mug = { variantId: 'sample-mug', quantity: 1, view: { kind: 'ready', title: text.mug, price: text.price(1490), shortOf: null } as LineView };
  // The subtotal as the live cart words it: a placeholder before any price, a note while a line is not counted.
  const model = (lines: CartViewModel['lines'], cents: number): CartViewModel => ({
    locale,
    lines,
    subtotal: subtotalText(cents, lines.some((line) => line.view.kind === 'ready') ? 'EUR' : null, locale),
    subtotalCents: cents,
    partial: lines.some((line) => line.view.kind !== 'ready'),
    idBase,
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
      return model([tee, { ...mug, view: { kind: 'error' } }], 5000);
    default:
      return model([tee, mug], 6490);
  }
}

/** Whether a preview state shows a part and every part around it (outermost first); a line part shows in any line. */
export function cartStateShows(id: string, roles: readonly string[], locale: ShopLocale): boolean {
  const model = sampleCartModel(id, locale);
  return roles.every((role) => {
    if (cartPart(role, model).visible) return true;
    return model.lines.some((line, index) => linePart(role, line, model, index).visible);
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
  // Two carts on one canvas never share an id.
  const idBase = React.useId();
  const id = typeof node.id === 'string' ? node.id : '';
  const runtime = cartRuntime(sampleCartModel(design?.stateOf(id) ?? 'ready', locale, idBase));
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

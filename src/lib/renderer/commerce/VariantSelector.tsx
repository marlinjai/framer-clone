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
// (the shop's failed check message, the reason in the console); they are NEVER
// swallowed into a silent "looks-available" state. READ-ONLY: this component never writes stock, money,
// or any commerce mutation.
//
// What the visitor sees is designed in the editor (docs/plans/2026-11-02-designable-shop-controls.md):
// an option template (a radio group: its name and a choice drawn once per value,
// with the selected and unavailable looks as stored rules), the availability messages
// and the no-product note are child nodes of the control with a role marker
// (src/lib/commerce/parts.ts), beside whatever the designer adds (an add to cart,
// a price bound to the variant). This file owns the data and the selection;
// `variantPart` answers what each part does, for the live control and for the
// canvas, which previews each state with a sample product.
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import type { ComponentInstance } from '@/models/ComponentModel';
import type { BindingScope } from '@/lib/bindings/resolver/scope';
import {
  lookup,
  pushAvailabilityFrame,
  pushPendingAvailabilityFrame,
  pushVariantFrame,
} from '@/lib/bindings/resolver/scope';
import { useCommerceDataSource } from '@/lib/commerce/context';
import type {
  AvailabilityDTO,
  PriceDTO,
  ProductDTO,
  ProductVariantDTO,
} from '@/lib/commerce/types';
import {
  SelectedVariantContext,
  isValueSelectable,
  useVariantSelection,
} from '@/lib/commerce/selection';
import type { RenderNode } from '@/lib/renderer/data/CollectionRenderer';
import { VARIANT_PREVIEW_STATES, type ShopLocale } from '@/lib/commerce/parts';
import { ShopDesignContext, ShopLocaleContext, ShopRuntimeContext, type ShopPartRender, type ShopRuntime } from '@/lib/commerce/shopRuntime';
import { ShopControlContent } from './ShopControlContent';

/** Low-stock threshold (advisory only) at or below which the text names the count. */
export const LOW_STOCK_THRESHOLD = 5;

/** The variants of the product in scope, keyed by that product so another product's never show. */
type VariantsState =
  | { productId: string; status: 'loading' }
  | { productId: string; status: 'ready'; variants: ProductVariantDTO[] }
  | { productId: string; status: 'error' };

/** The advisory availability of one variant, keyed by it so a previous choice's never shows. */
type AvailabilityState =
  | { variantId: string; status: 'ready'; availability: AvailabilityDTO }
  | { variantId: string; status: 'error' };

/** The first price of one variant, keyed by it. */
interface PriceState {
  variantId: string;
  price: PriceDTO | undefined;
}

const NO_VARIANTS: ProductVariantDTO[] = [];

export interface VariantSelectorProps {
  node: ComponentInstance;
  scope: BindingScope;
  renderNode: RenderNode;
  /** Host tag for the container wrapper (e.g. `div`). */
  hostType: string;
  /** Already-resolved wrapper props (identity attrs + style + marker). */
  hostProps: Record<string, unknown>;
  /** `canvas`: the design surface, the parts in a picked state with a sample product. */
  surface?: 'live' | 'canvas';
}

const VariantSelector = observer(
  ({ node, scope, renderNode, hostType, hostProps, surface = 'live' }: VariantSelectorProps) => {
    const dataSource = useCommerceDataSource();
    const locale = React.useContext(ShopLocaleContext);
    const design = React.useContext(ShopDesignContext);

    // The product comes from the surrounding product frame (pushed by the
    // ProductDetailRenderer this lives inside). No product frame in scope (e.g.
    // an editor canvas with no product) is the configuration guard below.
    const product = lookup(scope, ['product']) as ProductDTO | undefined;
    const productId = product?.id ?? null;

    // The full variant matrix for this product (the product frame only carries
    // variantIds). Fetched read-only via the data source.
    const [variantsState, setVariantsState] = React.useState<VariantsState | null>(null);
    React.useEffect(() => {
      if (!productId) return;
      let active = true;
      setVariantsState({ productId, status: 'loading' });
      dataSource
        .listVariants(productId)
        .then((rows) => {
          if (active) setVariantsState({ productId, status: 'ready', variants: rows });
        })
        .catch((err: unknown) => {
          if (!active) return;
          // A failed variant fetch selects nothing (no fabricated selection) and is
          // said: the visitor reads the failed check message, the console the reason.
          console.error(`VariantSelector: the variants of product ${productId} could not be loaded`, err);
          setVariantsState({ productId, status: 'error' });
        });
      return () => {
        active = false;
      };
    }, [dataSource, productId]);
    const current = variantsState && variantsState.productId === productId ? variantsState : null;
    const variants = current?.status === 'ready' ? current.variants : NO_VARIANTS;

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

    // Advisory availability and the price of the SELECTED variant, re-fetched
    // read-only on every selection change. Errors surface; they are never swallowed.
    const selectedVariantId = variant?.id ?? null;
    const [availabilityState, setAvailabilityState] = React.useState<AvailabilityState | null>(null);
    const [priceState, setPriceState] = React.useState<PriceState | null>(null);
    React.useEffect(() => {
      if (!selectedVariantId) return;
      let active = true;
      dataSource
        .getAvailability(selectedVariantId)
        .then((dto) => {
          if (active) setAvailabilityState({ variantId: selectedVariantId, status: 'ready', availability: dto });
        })
        .catch((err: unknown) => {
          if (!active) return;
          console.error(`VariantSelector: the availability of variant ${selectedVariantId} could not be checked`, err);
          setAvailabilityState({ variantId: selectedVariantId, status: 'error' });
        });
      // The chosen variant's own price, so a price bound to the variant follows the choice.
      Promise.resolve()
        .then(() => dataSource.getPrices(selectedVariantId))
        .then((prices) => {
          if (active) setPriceState({ variantId: selectedVariantId, price: prices[0] });
        })
        .catch((err: unknown) => {
          if (!active) return;
          console.error(`VariantSelector: the price of variant ${selectedVariantId} could not be read`, err);
          setPriceState({ variantId: selectedVariantId, price: undefined });
        });
      return () => {
        active = false;
      };
    }, [dataSource, selectedVariantId]);
    // Only the selected variant's answers count: another's are a check still running.
    const availability = selectedVariantId && availabilityState?.variantId === selectedVariantId ? availabilityState : null;
    const price = selectedVariantId && priceState?.variantId === selectedVariantId ? priceState.price : undefined;

    const wrapperProps = { ...hostProps };
    delete (wrapperProps as any).children;

    // What the parts show. A value no variant has is disabled; any other is a
    // choice (picking it clears an earlier choice no variant combines with it).
    // The availability text is ADVISORY ONLY, NOT permission to sell: the poll
    // result (reserve-at-checkout is the gate). A failure surfaces as the shop's
    // plain sentence; it is never a silent "in stock".
    const liveView: VariantView = {
      locale,
      product: product
        ? product.options.map((option) => ({
            id: option.id,
            title: option.title,
            values: option.values.map((value) => ({
              id: value.id,
              label: value.label,
              selected: selection[option.id] === value.id,
              selectable: isValueSelectable(variants, option.id, value.id),
            })),
          }))
        : null,
      catalog: !current || current.status === 'loading' ? 'loading' : current.status === 'error' ? 'failed' : variants.length === 0 ? 'none' : 'ready',
      availability:
        current?.status === 'error'
          ? { status: 'error' }
          : !selectedVariantId
            ? { status: 'idle' }
            : !availability
              ? { status: 'loading' }
              : availability.status === 'ready'
                ? { status: 'ready', quantity: availability.availability.availableQuantity, limited: availability.availability.limited }
                : { status: 'error' },
      onSelect: setOptionValue,
    };
    const id = typeof node.id === 'string' ? node.id : '';
    const view = surface === 'canvas' ? sampleVariantView(design?.stateOf(id) ?? 'in-stock', locale) : liveView;
    const runtime = variantRuntime(view);

    // Re-push the SELECTED variant (with its price and advisory availability) so
    // descendant `{{variant.*}}` / `{{availability.*}}` re-resolve to the choice.
    // The canvas pushes its sample choice, so a price bound to the variant shows
    // in the state picked (the real price when a product frame carries one).
    let childScope = scope;
    if (surface === 'canvas') {
      const sample = sampleChoice(view, product?.id ?? 'sample-product', lookup(scope, ['variant', 'price']) as PriceDTO | undefined);
      if (sample) {
        childScope = pushVariantFrame(childScope, sample.variant, sample.price);
        if (sample.availability) childScope = pushAvailabilityFrame(childScope, sample.availability);
      }
    } else if (variant) {
      childScope = pushVariantFrame(childScope, variant, price);
      // The chosen variant's own answer, keyed by it; while its check runs (or after
      // it failed) a frame that knows nothing, so the product's default variant's
      // availability never shows for this choice.
      childScope =
        availability?.status === 'ready'
          ? pushAvailabilityFrame(childScope, availability.availability)
          : pushPendingAvailabilityFrame(childScope);
    }

    // The control's children (its parts and whatever the designer put beside them,
    // such as an add to cart) through the surface's renderer, under the selected
    // variant's scope. ShopControlContent adds a default copy of any required part
    // the tree lacks (before them: the selector's parts come first) and the
    // platform's guard rule.
    const children = Array.from(node.children ?? []).map((child: ComponentInstance) => (
      <React.Fragment key={child.id}>{renderNode(child, childScope)}</React.Fragment>
    ));

    // The selection state is published through context so the add-to-cart spec
    // can read the current variant. This is client-only state, never persisted.
    const selectionState = { selection, variant, setOptionValue };

    return React.createElement(
      hostType as any,
      wrapperProps,
      <SelectedVariantContext.Provider value={selectionState}>
        <ShopRuntimeContext.Provider value={runtime}>
          <ShopControlContent node={node} kind="variant-selector" locale={locale} drawn={children} scope={childScope} />
        </ShopRuntimeContext.Provider>
      </SelectedVariantContext.Provider>,
    );
  },
);

VariantSelector.displayName = 'VariantSelector';
export default VariantSelector;

// ---------------------------------------------------------------------------
// What each part does
// ---------------------------------------------------------------------------

interface VariantValueView {
  id: string;
  label: string;
  selected: boolean;
  selectable: boolean;
}

interface VariantView {
  locale: ShopLocale;
  /** The product's options, or null when no product is in scope. */
  product: { id: string; title: string; values: VariantValueView[] }[] | null;
  /** The product's variants: being loaded, loaded, failed to load, or none to sell. */
  catalog: 'loading' | 'ready' | 'failed' | 'none';
  availability:
    | { status: 'idle' | 'loading' | 'error' }
    | { status: 'ready'; quantity: number; limited: boolean };
  /** Null on the canvas, where nothing does anything. */
  onSelect: ((optionId: string, valueId: string) => void) | null;
}

function variantRuntime(view: VariantView): ShopRuntime {
  return {
    kind: 'variant-selector',
    locale: view.locale,
    surface: view.onSelect ? 'live' : 'canvas',
    part: (role) => variantPart(role, view),
  };
}

/** A message shown later: its own status region in every state, its props only while it shows. */
function shownLater(visible: boolean, props?: Record<string, unknown>): ShopPartRender {
  return visible ? { visible: true, live: true, ...(props ? { props } : {}) } : { visible: false, live: true };
}

function variantPart(role: string, view: VariantView): ShopPartRender {
  const { availability } = view;
  const ready = availability.status === 'ready' ? availability : null;
  const hasProduct = view.product !== null;
  switch (role) {
    case 'variant.no-product':
      return { visible: !hasProduct };
    // The options load after the page: their wait and a product with nothing to
    // sell are said, each in its own status region (ShopPartRender.live).
    case 'variant.loading':
      return shownLater(hasProduct && view.catalog === 'loading', { 'data-variant-catalog': 'loading' });
    case 'variant.unavailable':
      return shownLater(hasProduct && view.catalog === 'none', { 'data-variant-catalog': 'none' });
    case 'variant.options':
      return { visible: hasProduct && view.catalog === 'ready' };
    case 'variant.option':
      if (!view.product || view.catalog !== 'ready') return { visible: false };
      return {
        visible: true,
        items: view.product.map((option) => ({
          key: option.id,
          tokens: { option: option.title },
          // One radio group per option, named by the option.
          props: { role: 'radiogroup', 'aria-label': option.title, 'data-variant-option': option.id },
          runtime: optionRuntime(option, view),
        })),
      };
    // Every availability message shows later (after a choice, when the check
    // answers), so each is its own status region, on the page before its text and
    // after it, and a screen reader announces the answer (ShopPartRender.live).
    case 'variant.checking':
      return shownLater(availability.status === 'loading', { 'data-variant-availability': 'loading' });
    case 'variant.in-stock':
      return shownLater(!!ready && ready.limited && ready.quantity > LOW_STOCK_THRESHOLD, { 'data-variant-availability': 'ready' });
    case 'variant.low-stock':
      return ready && ready.limited && ready.quantity > 0 && ready.quantity <= LOW_STOCK_THRESHOLD
        ? { ...shownLater(true, { 'data-variant-availability': 'ready' }), tokens: { count: String(ready.quantity) } }
        : shownLater(false);
    case 'variant.out-of-stock':
      return shownLater(!!ready && ready.limited && ready.quantity <= 0, { 'data-variant-availability': 'ready' });
    case 'variant.available':
      // Untracked stock (a service) or an allowed back-order: the quantity is no limit.
      return shownLater(!!ready && !ready.limited, { 'data-variant-availability': 'ready' });
    case 'variant.availability-error':
      return shownLater(availability.status === 'error', { 'data-variant-availability': 'error' });
    default:
      // An option's own parts outside an option have nothing to show.
      return { visible: false };
  }
}

/**
 * The radio keys of one option's choices (the WAI-ARIA radio group pattern): the
 * arrows move to the next or previous choice that can be made and select it,
 * wrapping around, Home and End go to the first and the last. Space presses the
 * focused choice as any button (its click selects it).
 */
function onRadioKey(
  event: React.KeyboardEvent<HTMLElement>,
  option: NonNullable<VariantView['product']>[number],
  onSelect: (optionId: string, valueId: string) => void,
) {
  const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
  if (step === 0 && event.key !== 'Home' && event.key !== 'End') return;
  const group = event.currentTarget.closest('[role="radiogroup"]');
  if (!group) return;
  // The group's radios in order, one per value of the option (the copies keep the values' order).
  const radios = Array.from(group.querySelectorAll<HTMLElement>('[role="radio"]')).filter((radio) => radio.closest('[role="radiogroup"]') === group);
  if (radios.length !== option.values.length) return;
  const choosable = option.values.map((value, index) => ({ value, radio: radios[index] })).filter(({ value }) => value.selectable);
  if (choosable.length === 0) return;
  const at = choosable.findIndex(({ radio }) => radio === event.currentTarget);
  const next =
    event.key === 'Home'
      ? choosable[0]
      : event.key === 'End'
        ? choosable[choosable.length - 1]
        : choosable[(at + step + choosable.length) % choosable.length];
  event.preventDefault();
  next.radio.focus();
  onSelect(option.id, next.value.id);
}

/** The runtime one copy of the option template reads: its name and its choices. */
function optionRuntime(option: NonNullable<VariantView['product']>[number], view: VariantView): ShopRuntime {
  // One tab stop per group: the chosen value, else the first that can be chosen.
  const tabStop = option.values.find((value) => value.selected && value.selectable) ?? option.values.find((value) => value.selectable);
  const onSelect = view.onSelect;
  return {
    kind: 'variant-selector',
    locale: view.locale,
    surface: onSelect ? 'live' : 'canvas',
    part: (role) => {
      if (role === 'variant.option-label') return { visible: true, tokens: { option: option.title } };
      if (role !== 'variant.value') return { visible: false };
      return {
        visible: true,
        items: option.values.map((value) => ({
          key: value.id,
          tokens: { value: value.label },
          // A native button with the radio role: it keeps the button's focus and
          // Space press. Native `disabled` tells assistive technology a choice no
          // variant has cannot be made, so no `aria-disabled` is drawn; the
          // designer's copy of either (and of `tabindex`) never reaches the page and
          // is never stored (SHOP_RUNTIME_OWNED_PROPS).
          props: {
            type: 'button',
            role: 'radio',
            'aria-checked': value.selected,
            'data-variant-value': value.id,
            disabled: !value.selectable,
            tabIndex: value === tabStop ? 0 : -1,
            ...(onSelect
              ? {
                  onClick: () => onSelect(option.id, value.id),
                  onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => onRadioKey(event, option, onSelect),
                }
              : {}),
          },
        })),
      };
    },
  };
}

const SAMPLE_OPTIONS = {
  en: [
    { id: 'size', title: 'Size', values: ['S', 'M', 'L'] },
    { id: 'color', title: 'Color', values: ['Red', 'Blue'] },
  ],
  de: [
    { id: 'size', title: 'Größe', values: ['S', 'M', 'L'] },
    { id: 'color', title: 'Farbe', values: ['Rot', 'Blau'] },
  ],
} as const;

/** The view the canvas shows for a preview state id, with a sample product. */
export function sampleVariantView(id: string, locale: ShopLocale): VariantView {
  const catalog: VariantView['catalog'] = id === 'loading-options' ? 'loading' : id === 'not-available' ? 'none' : 'ready';
  const chosen = catalog === 'ready' && id !== 'nothing-chosen' && id !== 'no-product';
  const product = SAMPLE_OPTIONS[locale].map((option) => ({
    id: option.id,
    title: option.title,
    values: option.values.map((label, index) => ({
      id: `${option.id}-${index}`,
      label,
      selected: chosen && index === (option.id === 'size' ? 1 : 0),
      // Only a value no variant has is greyed out, as on a page.
      selectable: !(id === 'choice-unavailable' && option.id === 'size' && index === 2),
    })),
  }));
  const availability: VariantView['availability'] =
    id === 'checking'
      ? { status: 'loading' }
      : id === 'low-stock'
        ? { status: 'ready', quantity: 3, limited: true }
        : id === 'out-of-stock'
          ? { status: 'ready', quantity: 0, limited: true }
          : id === 'available'
            ? { status: 'ready', quantity: 0, limited: false }
            : id === 'error'
              ? { status: 'error' }
              : chosen
                ? { status: 'ready', quantity: 24, limited: true }
                : { status: 'idle' };
  return { locale, product: id === 'no-product' ? null : product, catalog, availability, onSelect: null };
}

/** The sample choice of a canvas view as a variant, a price and an availability; null when nothing is chosen. */
function sampleChoice(
  view: VariantView,
  productId: string,
  outerPrice: PriceDTO | undefined,
): { variant: ProductVariantDTO; price: PriceDTO; availability?: AvailabilityDTO } | null {
  const picked = (view.product ?? []).map((option) => option.values.find((value) => value.selected)).filter((value) => value !== undefined);
  if (!view.product || picked.length !== view.product.length) return null;
  const variantId = 'sample-variant';
  const variant: ProductVariantDTO = {
    id: variantId,
    productId,
    title: picked.map((value) => value!.label).join(' / '),
    optionValues: view.product.map((option, index) => ({ optionId: option.id, valueId: picked[index]!.id, label: picked[index]!.label })),
  };
  const price: PriceDTO = outerPrice ?? { variantId, amountCents: 2900, currency: 'EUR' };
  const ready = view.availability.status === 'ready' ? view.availability : null;
  return {
    variant,
    price,
    ...(ready ? { availability: { variantId, locationId: 'sample', availableQuantity: ready.quantity, limited: ready.limited, stale: false } } : {}),
  };
}

/** Whether a preview state shows a part and every part around it; an option's part shows in any option. */
export function variantStateShows(id: string, roles: readonly string[], locale: ShopLocale): boolean {
  const view = sampleVariantView(id, locale);
  return roles.every((role) => {
    if (variantPart(role, view).visible) return true;
    return view.catalog === 'ready' && (view.product ?? []).some((option) => optionRuntime(option, view).part(role).visible);
  });
}

/** The first preview state that shows a part. */
export function variantStateShowing(roles: readonly string[], locale: ShopLocale): string | undefined {
  return VARIANT_PREVIEW_STATES.find(({ id }) => variantStateShows(id, roles, locale))?.id;
}

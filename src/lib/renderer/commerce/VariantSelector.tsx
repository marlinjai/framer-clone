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
//
// What the visitor sees is designed in the editor (docs/plans/2026-11-02-designable-shop-controls.md):
// an option template (its name and a choice button drawn once per value, with
// the selected and unavailable looks as stored rules), the availability messages
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
import { VARIANT_PREVIEW_STATES, missingShopParts, type ShopLocale } from '@/lib/commerce/parts';
import { ShopDesignContext, ShopLocaleContext, ShopRuntimeContext, type ShopPartRender, type ShopRuntime } from '@/lib/commerce/shopRuntime';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { renderNodeChildren } from '@/lib/renderer/server/renderComponentNode';

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
export function advisoryAvailabilityText(availableQuantity: number, limited = true): string {
  // Untracked stock (a service) or an allowed back-order: the quantity is no limit.
  if (!limited) return 'Available';
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
  /** `canvas`: the design surface, the parts in a picked state with a sample product. */
  surface?: 'live' | 'canvas';
}

const VariantSelector = observer(
  ({ node, scope, renderNode, hostType, hostProps, mode = 'preview', surface = 'live' }: VariantSelectorProps) => {
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

    // What the parts show. A value whose combination resolves to no variant is
    // disabled (unselectable). The availability text is ADVISORY ONLY: the poll
    // result, NOT permission to sell (reserve-at-checkout is the gate). An error
    // surfaces (the real message in the editor, a plain sentence for a visitor);
    // it is never a silent "in stock".
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
              selectable: isValueSelectable(variants, selection, option.id, value.id),
            })),
          }))
        : null,
      availability:
        availability.status === 'ready'
          ? { status: 'ready', quantity: availability.availability.availableQuantity, limited: availability.availability.limited }
          : availability.status === 'error'
            ? { status: 'error', message: mode === 'editor' ? availability.message : null }
            : { status: availability.status },
      onSelect: setOptionValue,
    };
    const id = typeof node.id === 'string' ? node.id : '';
    const view = surface === 'canvas' ? sampleVariantView(design?.stateOf(id) ?? 'in-stock', locale) : liveView;
    const runtime = variantRuntime(view);

    // Re-push the SELECTED variant (and its advisory availability) so descendant
    // `{{variant.*}}` / `{{availability.*}}` re-resolve to the chosen variant.
    let childScope = scope;
    if (variant) {
      childScope = pushVariantFrame(childScope, variant);
      if (availability.status === 'ready') {
        childScope = pushAvailabilityFrame(childScope, availability.availability);
      }
    }

    // The control's children (its parts and whatever the designer put beside them,
    // such as an add to cart) through the surface's renderer, then a default copy
    // of any required part the tree lacks.
    const children = Array.from(node.children ?? []).map((child: ComponentInstance) => (
      <React.Fragment key={child.id}>{renderNode(child, childScope)}</React.Fragment>
    ));
    const missing = missingShopParts(node, locale, 'variant-selector');

    // The selection state is published through context so the add-to-cart spec
    // can read the current variant. This is client-only state, never persisted.
    const selectionState = { selection, variant, setOptionValue };

    return React.createElement(
      hostType as any,
      wrapperProps,
      <SelectedVariantContext.Provider value={selectionState}>
        <ShopRuntimeContext.Provider value={runtime}>
          {missing.length > 0 ? renderNodeChildren({ type: 'div', children: missing } as ComponentNode, childScope) : null}
          {children}
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
  availability:
    | { status: 'idle' | 'loading' }
    | { status: 'ready'; quantity: number; limited: boolean }
    /** `message` is the real one in the editor, null for a visitor. */
    | { status: 'error'; message: string | null };
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

function variantPart(role: string, view: VariantView): ShopPartRender {
  const { availability } = view;
  const ready = availability.status === 'ready' ? availability : null;
  switch (role) {
    case 'variant.no-product':
      return { visible: view.product === null };
    case 'variant.options':
      return { visible: view.product !== null };
    case 'variant.option':
      if (!view.product) return { visible: false };
      return {
        visible: true,
        items: view.product.map((option) => ({
          key: option.id,
          tokens: { option: option.title },
          props: { role: 'group', 'aria-label': option.title, 'data-variant-option': option.id },
          runtime: optionRuntime(option, view),
        })),
      };
    case 'variant.checking':
      return availability.status === 'loading' ? { visible: true, props: { 'data-variant-availability': 'loading', role: 'status' } } : { visible: false };
    case 'variant.in-stock':
      return { visible: !!ready && ready.limited && ready.quantity > LOW_STOCK_THRESHOLD, props: { 'data-variant-availability': 'ready' } };
    case 'variant.low-stock':
      return ready && ready.limited && ready.quantity > 0 && ready.quantity <= LOW_STOCK_THRESHOLD
        ? { visible: true, tokens: { count: String(ready.quantity) }, props: { 'data-variant-availability': 'ready' } }
        : { visible: false };
    case 'variant.out-of-stock':
      return { visible: !!ready && ready.limited && ready.quantity <= 0, props: { 'data-variant-availability': 'ready' } };
    case 'variant.available':
      // Untracked stock (a service) or an allowed back-order: the quantity is no limit.
      return { visible: !!ready && !ready.limited, props: { 'data-variant-availability': 'ready' } };
    case 'variant.availability-error':
      if (availability.status !== 'error') return { visible: false };
      return {
        visible: true,
        props: { 'data-variant-availability': 'error', role: 'status' },
        ...(availability.message ? { text: `Availability check failed: ${availability.message}` } : {}),
      };
    default:
      // An option's own parts outside an option have nothing to show.
      return { visible: false };
  }
}

/** The runtime one copy of the option template reads: its name and its choices. */
function optionRuntime(option: NonNullable<VariantView['product']>[number], view: VariantView): ShopRuntime {
  return {
    kind: 'variant-selector',
    locale: view.locale,
    surface: view.onSelect ? 'live' : 'canvas',
    part: (role) => {
      if (role === 'variant.option-label') return { visible: true, tokens: { option: option.title } };
      if (role !== 'variant.value') return { visible: false };
      return {
        visible: true,
        items: option.values.map((value) => ({
          key: value.id,
          tokens: { value: value.label },
          props: {
            type: 'button',
            'data-variant-value': value.id,
            'aria-pressed': value.selected,
            disabled: !value.selectable,
            ...(view.onSelect ? { onClick: () => view.onSelect!(option.id, value.id) } : {}),
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
  const chosen = id !== 'nothing-chosen' && id !== 'no-product';
  const product = SAMPLE_OPTIONS[locale].map((option) => ({
    id: option.id,
    title: option.title,
    values: option.values.map((label, index) => ({
      id: `${option.id}-${index}`,
      label,
      selected: chosen && index === (option.id === 'size' ? 1 : 0),
      // Out of stock shows a choice that has no variant, greyed out.
      selectable: !(id === 'out-of-stock' && option.id === 'size' && index === 2),
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
              ? { status: 'error', message: null }
              : chosen
                ? { status: 'ready', quantity: 24, limited: true }
                : { status: 'idle' };
  return { locale, product: id === 'no-product' ? null : product, availability, onSelect: null };
}

/** Whether a preview state shows a part and every part around it; an option's part shows in any option. */
export function variantStateShows(id: string, roles: readonly string[], locale: ShopLocale): boolean {
  const view = sampleVariantView(id, locale);
  return roles.every((role) => {
    if (variantPart(role, view).visible) return true;
    return (view.product ?? []).some((option) => optionRuntime(option, view).part(role).visible);
  });
}

/** The first preview state that shows a part. */
export function variantStateShowing(roles: readonly string[], locale: ShopLocale): string | undefined {
  return VARIANT_PREVIEW_STATES.find(({ id }) => variantStateShows(id, roles, locale))?.id;
}

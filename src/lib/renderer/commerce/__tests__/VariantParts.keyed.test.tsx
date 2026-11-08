// A variant's availability is that variant's only (docs/plans/2026-11-02-designable-shop-controls.md,
// slice 3). When the visitor picks another variant, its check is held pending here,
// and a probe records what every render saw: the selector's parts, the binding
// scope its children read, and the add to cart's button. No render may pair the new
// choice with the previous variant's answer, nor with the product's default
// variant's answer from the surrounding product detail, during that window or after.
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import ComponentModel, { type ComponentInstance } from '@/models/ComponentModel';
import HeadlessComponentRenderer from '@/lib/renderer/HeadlessComponentRenderer';
import { CommerceDataSourceContext } from '@/lib/commerce/context';
import { CartProvider } from '@/lib/commerce/cart';
import { InMemoryCommerceDataSource } from '@/lib/commerce/inMemoryCommerceDataSource';
import {
  createScope,
  lookup,
  pushAvailabilityFrame,
  pushProductFrame,
  pushVariantFrame,
  type BindingScope,
} from '@/lib/bindings/resolver/scope';
import { SelectedVariantContext, type SelectionState } from '@/lib/commerce/selection';
import { ShopRuntimeContext } from '@/lib/commerce/shopRuntime';
import { buildShopParts } from '@/lib/commerce/parts';
import type { AvailabilityDTO, ProductDTO, ProductVariantDTO } from '@/lib/commerce/types';
import type { RenderNode } from '@/lib/renderer/data/CollectionRenderer';
import VariantSelector from '../VariantSelector';
import AddToCartButton from '../AddToCartButton';

const BP = 'bp';
const ALL_BP = [{ id: BP, minWidth: 0, label: 'BP' }];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

const dto = (variantId: string, availableQuantity: number): AvailabilityDTO => ({ variantId, locationId: 'all', availableQuantity, limited: true, stale: false });

/** A data source whose check for `held` waits for the test; every other check answers at once. */
function holding(held: string) {
  const ds = new InMemoryCommerceDataSource();
  const real = ds.getAvailability.bind(ds);
  const pending = deferred<AvailabilityDTO>();
  vi.spyOn(ds, 'getAvailability').mockImplementation((variantId: string) => (variantId === held ? pending.promise : real(variantId)));
  return { ds, pending };
}

describe('the selector, across a choice whose check is held', () => {
  /** What one render of the selector's children saw. */
  interface Seen {
    variant: unknown;
    quantity: unknown;
    inStock: boolean;
  }

  async function mount(ds: InMemoryCommerceDataSource) {
    const product = (await new InMemoryCommerceDataSource().getProduct('prod_tee')) as ProductDTO;
    const [defaultVariant] = await ds.listVariants('prod_tee');
    // The surrounding product detail: its default variant and that variant's answer (quantity 77).
    const outer = pushAvailabilityFrame(pushVariantFrame(pushProductFrame(createScope(), product), defaultVariant), dto(defaultVariant.id, 77));
    const seen: Seen[] = [];
    const Probe = ({ scope }: { scope: BindingScope }) => {
      const runtime = React.useContext(ShopRuntimeContext);
      seen.push({
        variant: lookup(scope, ['variant', 'id']),
        quantity: lookup(scope, ['availability', 'availableQuantity']),
        inStock: !!runtime?.part('variant.in-stock').visible,
      });
      return null;
    };
    const renderNode: RenderNode = (node: ComponentInstance, childScope: BindingScope) =>
      node.id === 'probe' ? <Probe scope={childScope} /> : <HeadlessComponentRenderer component={node} breakpointId={BP} allBreakpoints={ALL_BP} scope={childScope} />;
    const node = ComponentModel.create({
      id: 'vs',
      type: 'div',
      componentType: 'host',
      props: { 'data-component-kind': 'variant-selector' },
      children: [
        ...(buildShopParts('variant-selector', 'vs', 'en') as never[]),
        { id: 'probe', type: 'span', componentType: 'host', props: {} },
        { id: 'qty', type: 'span', componentType: 'host', props: {}, bindings: { children: { mode: 'read', expression: '{{availability.availableQuantity}}' } } },
      ],
    });
    const { container } = render(
      <CommerceDataSourceContext.Provider value={ds}>
        <CartProvider storageKey="variant-keyed">
          <VariantSelector node={node} scope={outer} renderNode={renderNode} hostType="div" hostProps={{}} />
        </CartProvider>
      </CommerceDataSourceContext.Provider>,
    );
    await waitFor(() => expect(container.querySelector('button[data-variant-value="ov_size_s"]')).not.toBeNull());
    const pick = (id: string) =>
      act(() => {
        fireEvent.click(container.querySelector(`button[data-variant-value="${id}"]`)!);
      });
    const qty = () => container.querySelector('[data-inner-component-id="qty"]')?.textContent;
    return { container, seen, pick, qty };
  }

  it('never pairs the new choice with the previous variant’s answer, while its check runs or after', async () => {
    const { ds, pending } = holding('var_m_red');
    const { container, seen, pick, qty } = await mount(ds);
    pick('ov_size_s');
    pick('ov_color_red');
    const smallRed = (await ds.getAvailability('var_s_red')).availableQuantity;
    await waitFor(() => expect(qty()).toBe(String(smallRed)));
    expect(container.querySelector('[data-shop-live="variant.in-stock"]')?.textContent).toBe('In stock');

    const from = seen.length;
    pick('ov_size_m');
    const during = seen.slice(from).filter((entry) => entry.variant === 'var_m_red');
    expect(during.length).toBeGreaterThan(0);
    // Not one render of the pending window shows the previous answer: not in the parts, not in the scope.
    expect(during.filter((entry) => entry.inStock)).toEqual([]);
    expect(during.filter((entry) => entry.quantity !== undefined)).toEqual([]);
    expect(container.querySelector('[data-shop-live="variant.in-stock"]')?.textContent).toBe('');
    expect(qty()).toBe('');

    await act(async () => pending.resolve(dto('var_m_red', 2)));
    await waitFor(() => expect(qty()).toBe('2'));
    expect(container.querySelector('[data-shop-live="variant.low-stock"]')?.textContent).toBe('Only 2 left');
    expect(seen.filter((entry) => entry.variant === 'var_m_red' && entry.quantity !== undefined && entry.quantity !== 2)).toEqual([]);
  });

  it('never shows the product detail’s default variant answer for the first choice while its check runs', async () => {
    const { ds, pending } = holding('var_m_blue');
    const { seen, pick, qty } = await mount(ds);
    // Nothing chosen yet: the product detail's default variant answer stands.
    expect(qty()).toBe('77');
    const from = seen.length;
    pick('ov_size_m');
    pick('ov_color_blue');
    const during = seen.slice(from).filter((entry) => entry.variant === 'var_m_blue');
    expect(during.length).toBeGreaterThan(0);
    expect(during.filter((entry) => entry.quantity === 77)).toEqual([]);
    expect(qty()).toBe('');
    await act(async () => pending.resolve(dto('var_m_blue', 9)));
    await waitFor(() => expect(qty()).toBe('9'));
  });
});

describe('the add to cart, across a choice whose check is held', () => {
  it('is never enabled for the new variant on the previous variant’s answer', async () => {
    const { ds, pending } = holding('var_m_red');
    const variants = await ds.listVariants('prod_tee');
    const variant = (id: string) => variants.find((entry) => entry.id === id) as ProductVariantDTO;
    const seen: { variant: string | undefined; disabled: unknown; busy: unknown }[] = [];
    const Probe = () => {
      const runtime = React.useContext(ShopRuntimeContext);
      const selected = React.useContext(SelectedVariantContext);
      const button = runtime?.part('addToCart.button').props ?? {};
      seen.push({ variant: selected?.variant?.id, disabled: button.disabled, busy: button['aria-busy'] });
      return null;
    };
    const node = ComponentModel.create({ id: 'atc', type: 'div', componentType: 'host', props: { 'data-component-kind': 'add-to-cart' } });
    const selection = (id: string): SelectionState => ({ selection: {}, variant: variant(id), setOptionValue: () => {} });
    const tree = (id: string) => (
      <CommerceDataSourceContext.Provider value={ds}>
        <CartProvider storageKey="add-to-cart-keyed">
          <SelectedVariantContext.Provider value={selection(id)}>
            <AddToCartButton node={node} scope={createScope()} hostType="div" hostProps={{}}>
              <Probe />
            </AddToCartButton>
          </SelectedVariantContext.Provider>
        </CartProvider>
      </CommerceDataSourceContext.Provider>
    );
    const { container, rerender } = render(tree('var_s_red'));
    await waitFor(() => expect(container.querySelector<HTMLButtonElement>('button[data-add-to-cart]')?.disabled).toBe(false));

    const from = seen.length;
    act(() => {
      rerender(tree('var_m_red'));
    });
    const during = seen.slice(from).filter((entry) => entry.variant === 'var_m_red');
    expect(during.length).toBeGreaterThan(0);
    // Every render of the pending window: disabled and checking, never the previous answer.
    expect(during.filter((entry) => entry.disabled !== true || entry.busy !== true)).toEqual([]);
    const button = container.querySelector<HTMLButtonElement>('button[data-add-to-cart]')!;
    expect(button.disabled).toBe(true);

    await act(async () => pending.resolve(dto('var_m_red', 4)));
    await waitFor(() => expect(button.disabled).toBe(false));
  });

  it('is disabled and checking while the first choice’s availability is read, and enabled after', async () => {
    const { ds, pending } = holding('var_s_red');
    const variants = await ds.listVariants('prod_tee');
    const node = ComponentModel.create({ id: 'atc', type: 'div', componentType: 'host', props: { 'data-component-kind': 'add-to-cart' } });
    const selection: SelectionState = { selection: {}, variant: variants.find((entry) => entry.id === 'var_s_red')!, setOptionValue: () => {} };
    const { container } = render(
      <CommerceDataSourceContext.Provider value={ds}>
        <CartProvider storageKey="add-to-cart-first-read">
          <SelectedVariantContext.Provider value={selection}>
            <AddToCartButton node={node} scope={createScope()} hostType="div" hostProps={{}} />
          </SelectedVariantContext.Provider>
        </CartProvider>
      </CommerceDataSourceContext.Provider>,
    );
    const button = container.querySelector<HTMLButtonElement>('button[data-add-to-cart]')!;
    // A buyer cannot add before the read answers.
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    await act(async () => pending.resolve(dto('var_s_red', 6)));
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(button.hasAttribute('aria-busy')).toBe(false);
  });
});

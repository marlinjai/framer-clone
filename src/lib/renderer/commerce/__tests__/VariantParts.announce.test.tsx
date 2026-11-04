// What the variant selector says besides availability (docs/plans/2026-11-02-designable-shop-controls.md,
// slice 3): a pick that clears an earlier choice no variant combines with it is
// announced politely in the site language, and a chosen variant whose price cannot
// be read (or which has none) is said and never added to the cart.
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import ComponentModel, { type ComponentInstance } from '@/models/ComponentModel';
import HeadlessComponentRenderer from '@/lib/renderer/HeadlessComponentRenderer';
import { CommerceDataSourceContext } from '@/lib/commerce/context';
import { CartProvider, useCart } from '@/lib/commerce/cart';
import { InMemoryCommerceDataSource } from '@/lib/commerce/inMemoryCommerceDataSource';
import { createScope, pushProductFrame, type BindingScope } from '@/lib/bindings/resolver/scope';
import { ShopLocaleContext } from '@/lib/commerce/shopRuntime';
import { buildShopParts, type ShopLocale } from '@/lib/commerce/parts';
import type { ProductDTO, ProductVariantDTO } from '@/lib/commerce/types';
import type { RenderNode } from '@/lib/renderer/data/CollectionRenderer';
import VariantSelector from '../VariantSelector';

const BP = 'bp';
const ALL_BP = [{ id: BP, minWidth: 0, label: 'BP' }];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

const renderNode: RenderNode = (node: ComponentInstance, childScope: BindingScope) => (
  <HeadlessComponentRenderer component={node} breakpointId={BP} allBreakpoints={ALL_BP} scope={childScope} />
);

/** Only S-Red and M-Blue exist, so picking M after S and Red clears the colour. */
async function diagonal(ds: InMemoryCommerceDataSource) {
  const all = await ds.listVariants('prod_tee');
  const keep = (variant: ProductVariantDTO) => variant.id === 'var_s_red' || variant.id === 'var_m_blue';
  vi.spyOn(ds, 'listVariants').mockResolvedValue(all.filter(keep));
}

let cartLines: () => readonly { variantId: string }[] = () => [];
function CartReader() {
  const cart = useCart();
  cartLines = () => cart.lines;
  return null;
}

async function mount(ds: InMemoryCommerceDataSource, locale: ShopLocale = 'en') {
  const product = (await new InMemoryCommerceDataSource().getProduct('prod_tee')) as ProductDTO;
  const node = ComponentModel.create({
    id: 'vs',
    type: 'div',
    componentType: 'host',
    props: { 'data-component-kind': 'variant-selector' },
    children: [
      ...(buildShopParts('variant-selector', 'vs', locale) as never[]),
      { id: 'atc', type: 'div', componentType: 'host', props: { 'data-component-kind': 'add-to-cart' }, children: buildShopParts('add-to-cart', 'atc', locale) as never[] },
    ],
  });
  const { container } = render(
    <CommerceDataSourceContext.Provider value={ds}>
      <ShopLocaleContext.Provider value={locale}>
        <CartProvider storageKey="variant-announce">
          <CartReader />
          <VariantSelector node={node} scope={pushProductFrame(createScope(), product)} renderNode={renderNode} hostType="div" hostProps={{}} />
        </CartProvider>
      </ShopLocaleContext.Provider>
    </CommerceDataSourceContext.Provider>,
  );
  await waitFor(() => expect(container.querySelector('button[data-variant-value="ov_size_s"]')?.hasAttribute('disabled')).toBe(false));
  const pick = (id: string) =>
    act(() => {
      fireEvent.click(container.querySelector(`button[data-variant-value="${id}"]`)!);
    });
  return { container, pick };
}

describe('a pick that clears an earlier choice', () => {
  it.each([
    ['en', 'Color cleared: no variant has Size Medium in Red.'],
    ['de', 'Color zurückgesetzt: keine Variante hat Size Medium in Red.'],
  ] as const)('is announced politely in its status region (%s)', async (locale, said) => {
    const ds = new InMemoryCommerceDataSource();
    await diagonal(ds);
    const { container, pick } = await mount(ds, locale);
    const region = container.querySelector<HTMLElement>('[data-shop-live="variant.cleared"]')!;
    expect(region.getAttribute('role')).toBe('status');
    pick('ov_size_s');
    pick('ov_color_red');
    // A pick that clears nothing says nothing.
    expect(region.textContent).toBe('');
    pick('ov_size_m');
    expect(region.textContent).toBe(said);
    expect(container.querySelector('button[data-variant-value="ov_color_red"]')?.getAttribute('aria-checked')).toBe('false');
    // The next pick that clears nothing empties it again.
    pick('ov_color_blue');
    expect(region.textContent).toBe('');
  });
});

describe('a chosen variant without a readable price', () => {
  it.each([
    ['the read fails', (ds: InMemoryCommerceDataSource) => vi.spyOn(ds, 'getPrices').mockRejectedValue(new Error('prices unreachable'))],
    ['the variant has no price', (ds: InMemoryCommerceDataSource) => vi.spyOn(ds, 'getPrices').mockResolvedValue([])],
  ])('is said, and the add to cart does not add it, when %s', async (_label, arrange) => {
    const ds = new InMemoryCommerceDataSource();
    arrange(ds);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container, pick } = await mount(ds, 'de');
    pick('ov_size_s');
    pick('ov_color_red');
    const region = container.querySelector<HTMLElement>('[data-shop-live="variant.price-error"]')!;
    await waitFor(() => expect(region.textContent).toBe('Der Preis dieser Auswahl kann gerade nicht geladen werden, daher kann sie noch nicht in den Warenkorb.'));
    // The availability answered: only the missing price holds the button back.
    await waitFor(() => expect(container.querySelector('[data-shop-live="variant.in-stock"]')?.textContent).toBe('Auf Lager'));
    const button = container.querySelector<HTMLButtonElement>('button[data-add-to-cart]')!;
    expect(button.disabled).toBe(true);
    act(() => {
      fireEvent.click(button);
    });
    expect(cartLines()).toEqual([]);
    if (_label === 'the read fails') expect(logged).toHaveBeenCalledWith(expect.stringContaining('could not be read'), expect.any(Error));
  });

  it('adds a variant whose price is known, and says nothing about the price', async () => {
    const ds = new InMemoryCommerceDataSource();
    const { container, pick } = await mount(ds);
    pick('ov_size_s');
    pick('ov_color_red');
    const button = container.querySelector<HTMLButtonElement>('button[data-add-to-cart]')!;
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(container.querySelector('[data-shop-live="variant.price-error"]')?.textContent).toBe('');
    act(() => {
      fireEvent.click(button);
    });
    expect(cartLines().map((line) => line.variantId)).toEqual(['var_s_red']);
  });
});

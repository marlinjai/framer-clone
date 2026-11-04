// The review of the designable variant selector (docs/plans/2026-11-02-designable-shop-controls.md,
// slice 3): each option is a radio group (one tab stop, the arrows, Home and End
// choose), a stored name on the choice or option name template never reaches the
// copies, a page saved with the toggle button's Selected rule is rewritten once,
// the wait for the options and a product with nothing to sell are said, a
// previous choice's availability never shows for the next one (here and in the
// add to cart), and a price bound to the variant follows the choice.
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import ComponentModel, { type ComponentInstance } from '@/models/ComponentModel';
import HeadlessComponentRenderer from '@/lib/renderer/HeadlessComponentRenderer';
import { CommerceDataSourceContext } from '@/lib/commerce/context';
import { CartProvider } from '@/lib/commerce/cart';
import { InMemoryCommerceDataSource } from '@/lib/commerce/inMemoryCommerceDataSource';
import { createScope, pushProductFrame, type BindingScope } from '@/lib/bindings/resolver/scope';
import { VARIANT_SELECTED_SELECTOR, buildShopParts, normalizeShopControl, shopPartRoleOf, type ShopTreeNode } from '@/lib/commerce/parts';
import { ruleLabel } from '@/lib/rules/states';
import type { AvailabilityDTO, ProductDTO, ProductVariantDTO } from '@/lib/commerce/types';
import type { RenderNode } from '@/lib/renderer/data/CollectionRenderer';
import VariantSelector from '../VariantSelector';

const BP = 'bp';
const ALL_BP = [{ id: BP, minWidth: 0, label: 'BP' }];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function flat(nodes: readonly ShopTreeNode[]): ShopTreeNode[] {
  return nodes.flatMap((node) => [node, ...flat(node.children ?? [])]);
}
const byRole = (nodes: readonly ShopTreeNode[], role: string) => flat(nodes).find((node) => shopPartRoleOf(node.props) === role);

function editedParts(edit: (node: ShopTreeNode) => ShopTreeNode): ShopTreeNode[] {
  const walk = (nodes: readonly ShopTreeNode[]): ShopTreeNode[] =>
    nodes.map((node) => {
      const next = edit(node);
      return { ...next, children: next.children ? walk(next.children) : undefined };
    });
  return walk(buildShopParts('variant-selector', 'vs', 'en'));
}

const control = (children: ShopTreeNode[]): ShopTreeNode => ({ id: 'vs', type: 'div', props: { 'data-component-kind': 'variant-selector' }, children });

const renderNode: RenderNode = (node: ComponentInstance, childScope: BindingScope) => (
  <HeadlessComponentRenderer component={node} breakpointId={BP} allBreakpoints={ALL_BP} scope={childScope} />
);

async function mount(parts: readonly ShopTreeNode[], ds: InMemoryCommerceDataSource = new InMemoryCommerceDataSource(), own: unknown[] = []) {
  const product = (await new InMemoryCommerceDataSource().getProduct('prod_tee')) as ProductDTO;
  const node = ComponentModel.create({
    id: 'vs',
    type: 'div',
    componentType: 'host',
    props: { 'data-component-kind': 'variant-selector' },
    children: [...(parts as never[]), ...(own as never[])],
  });
  return render(
    <CommerceDataSourceContext.Provider value={ds}>
      <CartProvider storageKey="variant-parts-review">
        <VariantSelector node={node} scope={pushProductFrame(createScope(), product)} renderNode={renderNode} hostType="div" hostProps={{}} />
      </CartProvider>
    </CommerceDataSourceContext.Provider>,
  ).container;
}

const choice = (container: HTMLElement, id: string) => container.querySelector<HTMLButtonElement>(`button[data-variant-value="${id}"]`)!;
const ready = (container: HTMLElement) => waitFor(() => expect(choice(container, 'ov_size_s')).not.toBeNull());

describe('a stored name on a template part', () => {
  const named = () =>
    editedParts((node) => {
      const role = shopPartRoleOf(node.props);
      return role === 'variant.value' || role === 'variant.option-label' || role === 'variant.option'
        ? { ...node, props: { ...node.props, 'aria-label': 'Same for all', title: 'Same for all', 'aria-labelledby': 'x' } }
        : node;
    });

  it('is never stored on the choice, the option name or the option', () => {
    const next = normalizeShopControl(control(named()), 'en', 'node').children ?? [];
    for (const role of ['variant.value', 'variant.option-label', 'variant.option']) {
      const props = byRole(next, role)!.props!;
      expect(props, role).not.toHaveProperty('aria-label');
      expect(props, role).not.toHaveProperty('title');
      expect(props, role).not.toHaveProperty('aria-labelledby');
    }
  });

  it('never reaches a choice: each is named by its own value, each group by its option', async () => {
    const container = await mount(named());
    await ready(container);
    const choices = [...container.querySelectorAll<HTMLButtonElement>('button[data-variant-value]')];
    expect(choices.every((button) => !button.hasAttribute('aria-label') && !button.hasAttribute('title') && !button.hasAttribute('aria-labelledby'))).toBe(true);
    expect(choices.map((button) => button.textContent)).toEqual(['Small', 'Medium', 'Red', 'Blue']);
    expect([...container.querySelectorAll('[role="radiogroup"]')].map((group) => group.getAttribute('aria-label'))).toEqual(['Size', 'Color']);
  });
});

describe('each option is a radio group', () => {
  it('draws radios with aria-checked and one tab stop per group', async () => {
    const container = await mount(buildShopParts('variant-selector', 'vs', 'en'));
    await ready(container);
    const groups = [...container.querySelectorAll<HTMLElement>('[role="radiogroup"]')];
    expect(groups).toHaveLength(2);
    for (const group of groups) {
      const radios = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
      expect(radios.every((radio) => radio.tagName === 'BUTTON' && radio.getAttribute('aria-checked') === 'false')).toBe(true);
      expect(radios.filter((radio) => radio.tabIndex === 0)).toHaveLength(1);
    }
    act(() => {
      fireEvent.click(choice(container, 'ov_size_m'));
    });
    // The tab stop follows the choice.
    expect(choice(container, 'ov_size_m').getAttribute('aria-checked')).toBe('true');
    expect(choice(container, 'ov_size_m').tabIndex).toBe(0);
    expect(choice(container, 'ov_size_s').tabIndex).toBe(-1);
    // The Selected rule addresses the radio's state.
    expect(VARIANT_SELECTED_SELECTOR).toBe('&[aria-checked="true"]');
  });

  it('moves and chooses with the arrows, wrapping, and with Home and End', async () => {
    const container = await mount(buildShopParts('variant-selector', 'vs', 'en'));
    await ready(container);
    const small = choice(container, 'ov_size_s');
    small.focus();
    act(() => {
      fireEvent.keyDown(small, { key: 'ArrowRight' });
    });
    expect(document.activeElement).toBe(choice(container, 'ov_size_m'));
    expect(choice(container, 'ov_size_m').getAttribute('aria-checked')).toBe('true');
    act(() => {
      fireEvent.keyDown(choice(container, 'ov_size_m'), { key: 'ArrowDown' });
    });
    // Two sizes: the next one wraps around to the first.
    expect(document.activeElement).toBe(small);
    expect(small.getAttribute('aria-checked')).toBe('true');
    act(() => {
      fireEvent.keyDown(small, { key: 'ArrowLeft' });
    });
    expect(document.activeElement).toBe(choice(container, 'ov_size_m'));
    act(() => {
      fireEvent.keyDown(choice(container, 'ov_size_m'), { key: 'Home' });
    });
    expect(document.activeElement).toBe(small);
    act(() => {
      fireEvent.keyDown(small, { key: 'End' });
    });
    expect(document.activeElement).toBe(choice(container, 'ov_size_m'));
    // The arrows stay in their group: the colours are untouched.
    expect(choice(container, 'ov_color_red').getAttribute('aria-checked')).toBe('false');
  });

  it('skips a choice no variant has', async () => {
    const ds = new InMemoryCommerceDataSource();
    const all = await ds.listVariants('prod_tee');
    vi.spyOn(ds, 'listVariants').mockResolvedValue(all.filter((variant) => !variant.optionValues.some((c) => c.valueId === 'ov_size_m')));
    const container = await mount(buildShopParts('variant-selector', 'vs', 'en'), ds);
    await waitFor(() => expect(choice(container, 'ov_size_m')?.disabled).toBe(true));
    const small = choice(container, 'ov_size_s');
    small.focus();
    act(() => {
      fireEvent.keyDown(small, { key: 'ArrowRight' });
    });
    expect(document.activeElement).toBe(small);
  });
});

describe('a page saved with the toggle button’s Selected rule', () => {
  it('is rewritten to the radio’s state once, other rules untouched', () => {
    const legacy = control(
      editedParts((node) =>
        shopPartRoleOf(node.props) === 'variant.value'
          ? {
              ...node,
              props: {
                ...node.props,
                rules: [
                  { id: 'hover', selector: '&:hover', style: { opacity: 0.9 } },
                  { id: 'selected', selector: '&[aria-pressed="true"]', style: { color: 'red' } },
                  { id: 'selected-hover', selector: '&[aria-pressed="true"]:hover', style: { color: 'blue' } },
                ],
              },
            }
          : node,
      ),
    );
    const once = normalizeShopControl(legacy, 'en', 'node');
    const rules = byRole(once.children ?? [], 'variant.value')!.props!.rules as { selector: string }[];
    expect(rules.map((rule) => rule.selector)).toEqual(['&:hover', '&[aria-checked="true"]', '&[aria-checked="true"]:hover']);
    expect(ruleLabel(rules[1] as never)).toBe('Selected');
    expect(normalizeShopControl(once, 'en', 'node')).toBe(once);
  });
});

describe('the options load after the page', () => {
  it('says so in a status region, then draws the choices', async () => {
    const ds = new InMemoryCommerceDataSource();
    const all = await ds.listVariants('prod_tee');
    let release!: (rows: ProductVariantDTO[]) => void;
    vi.spyOn(ds, 'listVariants').mockReturnValue(new Promise((resolve) => (release = resolve)));
    const container = await mount(buildShopParts('variant-selector', 'vs', 'en'), ds);
    const loading = container.querySelector<HTMLElement>('[data-shop-live="variant.loading"]')!;
    expect(loading.getAttribute('role')).toBe('status');
    expect(loading.textContent).toBe('Loading options...');
    expect(container.querySelector('button[data-variant-value]')).toBeNull();
    await act(async () => release(all));
    await ready(container);
    expect(container.querySelector('[data-shop-live="variant.loading"]')).toBe(loading);
    expect(loading.textContent).toBe('');
  });

  it('says a product with options but no variant is not available, with nothing to choose', async () => {
    const ds = new InMemoryCommerceDataSource();
    vi.spyOn(ds, 'listVariants').mockResolvedValue([]);
    const container = await mount(buildShopParts('variant-selector', 'vs', 'en'), ds);
    const region = container.querySelector<HTMLElement>('[data-shop-live="variant.unavailable"]')!;
    await waitFor(() => expect(region.textContent).toBe('This product is not available right now.'));
    expect(region.getAttribute('role')).toBe('status');
    expect(container.querySelector('button[data-variant-value]')).toBeNull();
  });
});

describe('a choice changed while its check runs', () => {
  async function switching() {
    const ds = new InMemoryCommerceDataSource();
    const real = ds.getAvailability.bind(ds);
    let release!: (dto: AvailabilityDTO) => void;
    vi.spyOn(ds, 'getAvailability').mockImplementation((variantId: string) =>
      variantId === 'var_m_red' ? new Promise<AvailabilityDTO>((resolve) => (release = resolve)) : real(variantId),
    );
    const addToCart = buildShopParts('add-to-cart', 'atc', 'en');
    const container = await mount(buildShopParts('variant-selector', 'vs', 'en'), ds, [
      { id: 'atc', type: 'div', componentType: 'host', props: { 'data-component-kind': 'add-to-cart' }, children: addToCart },
    ]);
    await ready(container);
    act(() => {
      fireEvent.click(choice(container, 'ov_size_s'));
    });
    act(() => {
      fireEvent.click(choice(container, 'ov_color_red'));
    });
    await waitFor(() => expect(container.querySelector('[data-shop-live="variant.in-stock"]')?.textContent).toBe('In stock'));
    await waitFor(() => expect(container.querySelector<HTMLButtonElement>('button[data-add-to-cart]')?.disabled).toBe(false));
    act(() => {
      fireEvent.click(choice(container, 'ov_size_m'));
    });
    return { container, release };
  }

  it('never shows the previous variant’s answer in the selector', async () => {
    const { container, release } = await switching();
    expect(container.querySelector('[data-shop-live="variant.in-stock"]')?.textContent).toBe('');
    expect(container.querySelector('[data-shop-live="variant.checking"]')?.textContent).toBe('Checking availability...');
    await act(async () => release({ variantId: 'var_m_red', locationId: 'all', availableQuantity: 0, limited: true, stale: false }));
    await waitFor(() => expect(container.querySelector('[data-shop-live="variant.out-of-stock"]')?.textContent).toBe('Out of stock'));
  });

  it('keeps the add to cart checking, never enabled on the previous variant’s answer', async () => {
    const { container } = await switching();
    const button = container.querySelector<HTMLButtonElement>('button[data-add-to-cart]')!;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
  });
});

describe('a price bound to the variant', () => {
  it('follows the choice, read from the chosen variant’s own price', async () => {
    const ds = new InMemoryCommerceDataSource();
    const [price] = await ds.getPrices('var_m_blue');
    const container = await mount(buildShopParts('variant-selector', 'vs', 'en'), ds, [
      { id: 'vs-price', type: 'span', componentType: 'host', props: {}, bindings: { children: { mode: 'read', expression: '{{variant.price.amountCents}}' } } },
    ]);
    await ready(container);
    act(() => {
      fireEvent.click(choice(container, 'ov_size_m'));
    });
    act(() => {
      fireEvent.click(choice(container, 'ov_color_blue'));
    });
    await waitFor(() => expect(container.querySelector('[data-inner-component-id="vs-price"]')?.textContent).toBe(String(price.amountCents)));
  });
});

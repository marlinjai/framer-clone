// The variant selector follows the patterns the add to cart and the cart settled in
// review (docs/plans/2026-11-02-designable-shop-controls.md, slices 2 and 3): the
// island owns whether a choice can be pressed or reached by the keyboard, every
// availability message is its own status region on the page before its text, a
// missing part comes back where the selector's parts go (before the designer's own
// children), the normaliser changes nothing on a second pass, and a failed variant
// load is said rather than shown as a selector with nothing to choose.
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import ComponentModel, { type ComponentInstance } from '@/models/ComponentModel';
import HeadlessComponentRenderer from '@/lib/renderer/HeadlessComponentRenderer';
import { CommerceDataSourceContext } from '@/lib/commerce/context';
import { InMemoryCommerceDataSource } from '@/lib/commerce/inMemoryCommerceDataSource';
import { createScope, pushProductFrame, type BindingScope } from '@/lib/bindings/resolver/scope';
import { buildShopParts, normalizeShopControl, shopPartRoleOf, type ShopTreeNode } from '@/lib/commerce/parts';
import type { ProductDTO } from '@/lib/commerce/types';
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

/** The default parts with `edit` applied to every node (top down). */
function editedParts(edit: (node: ShopTreeNode) => ShopTreeNode | null): ShopTreeNode[] {
  const walk = (nodes: readonly ShopTreeNode[]): ShopTreeNode[] =>
    nodes.flatMap((node) => {
      const next = edit(node);
      return next ? [{ ...next, children: next.children ? walk(next.children) : undefined }] : [];
    });
  return walk(buildShopParts('variant-selector', 'vs', 'en'));
}

const renderNode: RenderNode = (node: ComponentInstance, childScope: BindingScope) => (
  <HeadlessComponentRenderer component={node} breakpointId={BP} allBreakpoints={ALL_BP} scope={childScope} />
);

async function mount(parts: readonly ShopTreeNode[], ds = new InMemoryCommerceDataSource(), own: unknown[] = []) {
  const product = (await new InMemoryCommerceDataSource().getProduct('prod_tee')) as ProductDTO;
  const node = ComponentModel.create({
    id: 'vs',
    type: 'div',
    componentType: 'host',
    props: { 'data-component-kind': 'variant-selector' },
    children: [...(parts as never[]), ...(own as never[])],
  });
  const view = render(
    <CommerceDataSourceContext.Provider value={ds}>
      <VariantSelector node={node} scope={pushProductFrame(createScope(), product)} renderNode={renderNode} hostType="div" hostProps={{}} />
    </CommerceDataSourceContext.Provider>,
  );
  return view.container;
}

describe('the island owns whether a choice can be pressed', () => {
  const owned = { disabled: true, 'aria-disabled': 'true', tabIndex: -1, tabindex: '-1', inert: true };

  it('never stores the designer’s disabled, aria-disabled, tabindex or inert on a choice', () => {
    const parts = editedParts((node) => (shopPartRoleOf(node.props) === 'variant.value' ? { ...node, props: { ...node.props, ...owned } } : node));
    const control: ShopTreeNode = { id: 'vs', type: 'div', props: { 'data-component-kind': 'variant-selector' }, children: parts };
    const value = byRole(normalizeShopControl(control, 'en', 'node').children ?? [], 'variant.value')!;
    for (const key of Object.keys(owned)) expect(value.props).not.toHaveProperty(key);
  });

  it('draws a choice that has a variant pressable and in the tab order, whatever the stored node says', async () => {
    const parts = editedParts((node) => (shopPartRoleOf(node.props) === 'variant.value' ? { ...node, props: { ...node.props, ...owned } } : node));
    const container = await mount(parts);
    const small = await waitFor(() => {
      const found = container.querySelector<HTMLButtonElement>('button[data-variant-value="ov_size_s"]');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(small.disabled).toBe(false);
    expect(small.hasAttribute('aria-disabled')).toBe(false);
    expect(small.hasAttribute('tabindex')).toBe(false);
    expect(small.hasAttribute('inert')).toBe(false);
  });
});

describe('every availability message is announced when it shows', () => {
  const MESSAGES = ['variant.checking', 'variant.in-stock', 'variant.low-stock', 'variant.out-of-stock', 'variant.available', 'variant.availability-error'];

  it('puts each message on the page as its own empty status region before any choice', async () => {
    const container = await mount(buildShopParts('variant-selector', 'vs', 'en'));
    for (const role of MESSAGES) {
      const region = container.querySelector<HTMLElement>(`[data-shop-live="${role}"]`);
      expect(region, role).not.toBeNull();
      expect(region!.getAttribute('role')).toBe('status');
      expect(region!.getAttribute('data-shop-part')).toBe(role);
      expect(region!.textContent).toBe('');
    }
  });

  it('fills the same element with the answer, and no message nests a second region', async () => {
    const container = await mount(buildShopParts('variant-selector', 'vs', 'en'));
    const inStock = container.querySelector<HTMLElement>('[data-shop-live="variant.in-stock"]')!;
    await waitFor(() => expect(container.querySelector('button[data-variant-value="ov_size_s"]')).not.toBeNull());
    act(() => {
      fireEvent.click(container.querySelector('button[data-variant-value="ov_size_s"]')!);
    });
    act(() => {
      fireEvent.click(container.querySelector('button[data-variant-value="ov_color_red"]')!);
    });
    await waitFor(() => expect(inStock.textContent).toBe('In stock'));
    // The region was on the page before its text: it is the element the screen reader watched.
    expect(container.querySelector('[data-shop-live="variant.in-stock"]')).toBe(inStock);
    expect(inStock.getAttribute('data-variant-availability')).toBe('ready');
    expect(inStock.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(MESSAGES.length);
  });

  it('says a failed variant load, with the real reason in the console, instead of drawing nothing to choose', async () => {
    const ds = new InMemoryCommerceDataSource();
    vi.spyOn(ds, 'listVariants').mockRejectedValue(new Error('variants unreachable'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const container = await mount(buildShopParts('variant-selector', 'vs', 'en'), ds);
    const region = container.querySelector<HTMLElement>('[data-shop-live="variant.availability-error"]')!;
    await waitFor(() => expect(region.textContent).toBe('Availability could not be checked right now. Please try again later.'));
    // A visitor never reads the internal message.
    expect(region.textContent).not.toContain('unreachable');
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('could not be loaded'), expect.any(Error));
    // No choice resolves to a variant: none is offered as pressable.
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('button[data-variant-value]')];
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((button) => button.disabled)).toBe(true);
  });
});

describe('a part the selector lacks', () => {
  it('comes back before the designer’s own children, where the next load stores it', async () => {
    const parts = editedParts((node) => (shopPartRoleOf(node.props) === 'variant.options' ? null : node));
    const container = await mount(parts, new InMemoryCommerceDataSource(), [{ id: 'own-price', type: 'span', componentType: 'host', props: { children: 'price' } }]);
    const options = await waitFor(() => {
      const found = container.querySelector('[data-shop-part="variant.options"]');
      expect(found).not.toBeNull();
      return found!;
    });
    const own = container.querySelector('[data-inner-component-id="own-price"]')!;
    expect(own).not.toBeNull();
    expect(options.compareDocumentPosition(own) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The stored tree agrees: the normaliser puts it among the parts, before the designer's child.
    const control: ShopTreeNode = {
      id: 'vs',
      type: 'div',
      props: { 'data-component-kind': 'variant-selector' },
      children: [...parts, { id: 'own-price', type: 'span', props: {} }],
    };
    const ids = (normalizeShopControl(control, 'en', 'node').children ?? []).map((child) => shopPartRoleOf(child.props) ?? child.id);
    expect(ids.indexOf('variant.options')).toBeLessThan(ids.indexOf('own-price'));
  });
});

describe('the normaliser on a variant selector', () => {
  const cases: [string, ShopTreeNode][] = [
    ['a selector saved before parts, with a designer’s child', { id: 'vs', type: 'div', props: { 'data-component-kind': 'variant-selector' }, children: [{ id: 'own', type: 'span', props: {} }] }],
    [
      'a selector missing a message and carrying stored runtime attributes',
      {
        id: 'vs',
        type: 'div',
        props: { 'data-component-kind': 'variant-selector' },
        children: editedParts((node) => {
          const role = shopPartRoleOf(node.props);
          if (role === 'variant.checking') return null;
          if (role === 'variant.value') return { ...node, props: { ...node.props, disabled: true, tabIndex: -1 } };
          return node;
        }),
      },
    ],
  ];

  it.each(cases)('changes nothing on a second pass: %s', (_label, control) => {
    const once = normalizeShopControl(control, 'en', 'node');
    expect(once).not.toBe(control);
    const twice = normalizeShopControl(once, 'en', 'node');
    expect(twice).toBe(once);
    expect(twice).toEqual(once);
  });
});

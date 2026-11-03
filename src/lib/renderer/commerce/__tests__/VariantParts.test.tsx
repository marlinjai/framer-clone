// The variant selector as designable parts (docs/plans/2026-11-02-designable-shop-controls.md,
// slice 3): its parts in the site language, placed before the designer's own
// children, the option template drawn once per option and the choice button once
// per value (each copy reading its own option and value), the designer's text
// reaching the live control, and the selection behaviour the parts cannot change.
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import ComponentModel, { type ComponentInstance } from '@/models/ComponentModel';
import HeadlessComponentRenderer from '@/lib/renderer/HeadlessComponentRenderer';
import { CommerceDataSourceContext } from '@/lib/commerce/context';
import { InMemoryCommerceDataSource } from '@/lib/commerce/inMemoryCommerceDataSource';
import { createScope, pushProductFrame, type BindingScope } from '@/lib/bindings/resolver/scope';
import { ShopLocaleContext } from '@/lib/commerce/shopRuntime';
import { buildShopParts, normalizeShopControl, shopPartRoleOf, shopPartText, type ShopTreeNode } from '@/lib/commerce/parts';
import { ruleLabel } from '@/lib/rules/states';
import type { RenderNode } from '@/lib/renderer/data/CollectionRenderer';
import VariantSelector from '../VariantSelector';

const BP = 'bp';
const ALL_BP = [{ id: BP, minWidth: 0, label: 'BP' }];

afterEach(() => cleanup());

function flat(nodes: readonly ShopTreeNode[]): ShopTreeNode[] {
  return nodes.flatMap((node) => [node, ...flat(node.children ?? [])]);
}
const byRole = (nodes: readonly ShopTreeNode[], role: string) => flat(nodes).find((node) => shopPartRoleOf(node.props) === role);

describe('default parts', () => {
  it('builds them in the site language, with the selected and unavailable looks as named states', () => {
    const parts = buildShopParts('variant-selector', 'vs', 'de');
    expect(byRole(parts, 'variant.out-of-stock')?.props?.children).toBe('Nicht vorrätig');
    expect(byRole(parts, 'variant.low-stock')?.props?.children).toBe('Nur noch {count} verfügbar');
    const value = byRole(parts, 'variant.value')!;
    expect((value.props?.rules as never[]).map((rule) => ruleLabel(rule))).toEqual(['Hover', 'Selected', 'Disabled']);
  });

  it("puts the parts before the designer's own children when a selector gets them", () => {
    const legacy: ShopTreeNode = {
      id: 'vs',
      type: 'div',
      props: { 'data-component-kind': 'variant-selector' },
      children: [{ id: 'price', type: 'span', props: {} }],
    };
    const next = normalizeShopControl(legacy, 'en', 'node');
    expect(shopPartRoleOf(next.children![0].props)).toBe('variant.no-product');
    expect(next.children![next.children!.length - 1].id).toBe('price');
  });

  it('keeps the tokens the option name, a choice and the low stock text need', () => {
    expect(shopPartText('variant.value', 'Pick me', 'en')).toBe('{value}');
    expect(shopPartText('variant.low-stock', 'Hurry!', 'de')).toBe('Nur noch {count} verfügbar');
  });
});

const renderNode: RenderNode = (node: ComponentInstance, childScope: BindingScope) => (
  <HeadlessComponentRenderer component={node} breakpointId={BP} allBreakpoints={ALL_BP} scope={childScope} />
);

describe('a designed variant selector, live', () => {
  it('draws one group per option and one choice per value, with designed text and fixed behaviour', async () => {
    const ds = new InMemoryCommerceDataSource();
    const product = (await ds.getProduct('prod_tee'))!;
    const parts = buildShopParts('variant-selector', 'vs', 'de').map(function edit(node): ShopTreeNode {
      const children = node.children?.map(edit);
      const role = shopPartRoleOf(node.props);
      if (role === 'variant.value') return { ...node, children, type: 'div', props: { ...node.props, children: 'Wähle {value}', style: { color: 'rgb(1, 2, 3)' } } };
      if (role === 'variant.option-label') return { ...node, children, props: { ...node.props, children: '{option}:' } };
      return { ...node, children };
    });
    const node = ComponentModel.create({
      id: 'vs',
      type: 'div',
      componentType: 'host',
      props: { 'data-component-kind': 'variant-selector' },
      children: [
        ...(parts as never[]),
        { id: 'vs-title', type: 'span', componentType: 'host', props: {}, bindings: { children: { mode: 'read', expression: '{{variant.title}}' } } },
      ],
    });
    const { container } = render(
      <CommerceDataSourceContext.Provider value={ds}>
        <ShopLocaleContext.Provider value="de">
          <VariantSelector node={node} scope={pushProductFrame(createScope(), product)} renderNode={renderNode} hostType="div" hostProps={{}} />
        </ShopLocaleContext.Provider>
      </CommerceDataSourceContext.Provider>,
    );
    await waitFor(() => expect(container.querySelector<HTMLButtonElement>('button[data-variant-value="ov_size_s"]')?.disabled).toBe(false));
    const groups = [...container.querySelectorAll('[data-variant-option]')];
    expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual(['Size', 'Color']);
    expect(groups[0].querySelector('[data-shop-part="variant.option-label"]')?.textContent).toBe('Size:');
    const small = container.querySelector<HTMLButtonElement>('button[data-variant-value="ov_size_s"]')!;
    // Retyped to a div in the editor, it stays a button; its text and colour are the designer's.
    expect(small.tagName).toBe('BUTTON');
    expect(small.type).toBe('button');
    expect(small.textContent).toBe('Wähle Small');
    expect(small.style.color).toBe('rgb(1, 2, 3)');
    expect(small.getAttribute('aria-pressed')).toBe('false');

    act(() => {
      fireEvent.click(small);
    });
    act(() => {
      fireEvent.click(container.querySelector('button[data-variant-value="ov_color_red"]')!);
    });
    await waitFor(() => expect(container.querySelector('span[data-inner-component-id="vs-title"]')?.textContent).toBe('Small / Red'));
    expect(container.querySelector('button[data-variant-value="ov_size_s"]')?.getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(container.querySelector('[data-variant-availability="ready"]')?.textContent).toBe('Auf Lager'));
  });
});

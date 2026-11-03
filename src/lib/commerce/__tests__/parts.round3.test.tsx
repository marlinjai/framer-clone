// The third round of guards on the shop parts (src/lib/commerce/parts.ts and
// src/lib/commerce/shopRuntime.tsx): a part wrapped inside a button whose wording
// is fixed is lifted out (so normalising twice equals normalising once), the
// style keys a part kept in sight may carry are an allowlist, and form fields
// keep no stored name.
import * as React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { normalizeShopControl, shopPartRoleOf, type ShopTreeNode } from '../parts';
import { ShopPartElement, ShopRuntimeContext } from '../shopRuntime';

const control = (): ShopTreeNode => ({ id: 'co', type: 'div', props: { 'data-component-kind': 'checkout-button' }, children: [] });

function flat(nodes: readonly ShopTreeNode[]): ShopTreeNode[] {
  return nodes.flatMap((node) => [node, ...flat(node.children ?? [])]);
}
const byRole = (nodes: readonly ShopTreeNode[], role: string) => flat(nodes).find((node) => shopPartRoleOf(node.props) === role);

function editing(tree: ShopTreeNode, role: string, edit: (node: ShopTreeNode) => ShopTreeNode): ShopTreeNode {
  const next = { ...tree, children: tree.children?.map((child) => editing(child, role, edit)) };
  return shopPartRoleOf(tree.props) === role ? edit(next) : next;
}

describe('a part wrapped inside a button whose wording is fixed', () => {
  const wrapLabel = (full: ShopTreeNode) =>
    editing(full, 'checkout.pay', (node) => {
      const label = node.children!.find((child) => shopPartRoleOf(child.props) === 'checkout.pay-label')!;
      return {
        ...node,
        children: [
          { id: 'wrap', type: 'span', props: { children: 'Gratis testen' }, children: [label] },
          ...node.children!.filter((child) => child !== label),
        ],
      };
    });

  it('is lifted out of the wrapper, and the wrapper and its text go', () => {
    const next = normalizeShopControl(wrapLabel(normalizeShopControl(control(), 'de', 'node')), 'de', 'node');
    const pay = byRole(next.children!, 'checkout.pay')!;
    expect(pay.children!.map((child) => shopPartRoleOf(child.props))).toEqual(['checkout.pay-label', 'checkout.pay-loading']);
    expect(flat(next.children!).some((node) => node.id === 'wrap')).toBe(false);
  });

  it('normalises the same once as twice', () => {
    const wrapped = wrapLabel(normalizeShopControl(control(), 'de', 'node'));
    const once = normalizeShopControl(wrapped, 'de', 'node');
    const twice = normalizeShopControl(once, 'de', 'node');
    expect(twice).toEqual(once);
    expect(twice).toBe(once);
  });

  it('takes the button as its parent in a stored snapshot', () => {
    const full = normalizeShopControl(control(), 'de', 'snapshot');
    const pay = byRole(full.children!, 'checkout.pay')!;
    const wrapped = editing(full, 'checkout.pay', (node) => {
      const label = { ...node.children![0], parentId: 'wrap' };
      return { ...node, children: [{ id: 'wrap', type: 'span', parentId: pay.id, props: {}, children: [label] }, ...node.children!.slice(1)] };
    });
    const label = byRole(normalizeShopControl(wrapped, 'de', 'snapshot').children!, 'checkout.pay-label')!;
    expect(label.parentId).toBe(pay.id);
  });

  it('is drawn by the island without the wrapper text', () => {
    const runtime = {
      kind: 'checkout-button',
      locale: 'en',
      part: () => ({ visible: true }),
    };
    const { container } = render(
      <ShopRuntimeContext.Provider value={runtime as never}>
        <ShopPartElement
          role="checkout.pay"
          tag="button"
          domProps={{}}
          storedText={undefined}
          surface="preview"
          content={[
            <span key="wrap">
              Gratis testen
              <ShopPartElement key="label" role="checkout.pay-label" tag="span" domProps={{}} storedText={undefined} surface="preview" />
            </span>,
          ]}
        />
      </ShopRuntimeContext.Provider>,
    );
    const button = container.querySelector('button')!;
    expect(button.textContent).not.toContain('Gratis testen');
    expect(button.textContent).toContain('Buy now');
  });
});

describe('a part kept in sight and its wrappers', () => {
  const styled = (style: Record<string, unknown>, rules?: unknown[]) => {
    const full = normalizeShopControl(control(), 'en', 'node');
    return normalizeShopControl(
      editing(full, 'checkout.total', (node) => ({ ...node, props: { ...node.props, style, ...(rules ? { rules } : {}) } })),
      'en',
      'node',
    );
  };

  it('keep only listed style keys, so a new way to hide is closed by default', () => {
    const next = styled({
      color: '#111',
      fontWeight: '600',
      display: 'flex',
      scale: '0',
      translate: '-9999px 0',
      maskImage: 'linear-gradient(transparent, transparent)',
      contain: 'paint',
      position: 'absolute',
      textIndent: '-9999px',
      zIndex: 5,
    });
    expect(byRole(next.children!, 'checkout.total')?.props?.style).toEqual({ color: '#111', fontWeight: '600', display: 'flex' });
  });

  it('lose a see-through colour and a negative margin, in style and in every rule', () => {
    const next = styled({ color: 'rgba(0, 0, 0, 0.1)', marginLeft: '-2000px', padding: '4px' }, [
      { id: 'h', selector: '&:hover', style: { color: 'transparent', scale: '0', backgroundColor: '#eee' } },
    ]);
    const total = byRole(next.children!, 'checkout.total')!;
    expect(total.props?.style).toEqual({ padding: '4px' });
    expect(total.props?.rules).toEqual([{ id: 'h', selector: '&:hover', style: { backgroundColor: '#eee' } }]);
  });

  it('cover a wrapper between the part and its control', () => {
    const full = normalizeShopControl(control(), 'en', 'node');
    const payment = byRole(full.children!, 'checkout.payment')!;
    const badge = byRole(payment.children!, 'checkout.demo-badge')!;
    const wrapped = editing(full, 'checkout.payment', (node) => ({
      ...node,
      children: [
        { id: 'w', type: 'div', props: { style: { contain: 'paint', height: '1px', gap: '4px', maskImage: 'none', scale: '0.01' } }, children: [badge] },
        ...node.children!.filter((child) => child !== badge),
      ],
    }));
    const wrapper = flat(normalizeShopControl(wrapped, 'en', 'node').children!).find((node) => node.id === 'w')!;
    expect(wrapper.props?.style).toEqual({ height: '1px', gap: '4px' });
  });

  it("strip what hides from the control's rules that reach inside, and keep the rest", () => {
    const rules = [{ id: 'r', selector: '& [data-shop-part]', style: { scale: '0', maskImage: 'url(x.svg)', contain: 'strict', color: 'red', position: 'relative' } }];
    const next = normalizeShopControl({ ...control(), props: { ...control().props, rules } }, 'en', 'node');
    expect(next.props?.rules).toEqual([{ id: 'r', selector: '& [data-shop-part]', style: { color: 'red', position: 'relative' } }]);
  });
});

describe('a form field inside a shop control', () => {
  it('keeps no stored name', () => {
    const full = normalizeShopControl(control(), 'en', 'node');
    const named = editing(full, 'checkout.input.email', (node) => ({ ...node, props: { ...node.props, name: 'email' } }));
    const input = byRole(normalizeShopControl(named, 'en', 'node').children!, 'checkout.input.email')!;
    expect(input.props && 'name' in input.props).toBe(false);
  });
});

// Review round four on the shop parts (src/lib/commerce/parts.ts): transforms and
// filters that add up, a mixed colour that is faint, a shadow beside a kept part, a
// control inside a closed part, a form as the control's own root, and a reusable
// component's page repaired on load.
import { describe, expect, it } from 'vitest';
import { componentsWithShopParts, normalizeShopControl, shopPartRefusal, shopPartRoleOf, type ShopTreeNode } from '../parts';

const control = (extra: Record<string, unknown> = {}, type = 'div'): ShopTreeNode => ({
  id: 'co',
  type,
  props: { 'data-component-kind': 'checkout-button', ...extra },
  children: [],
});

function flat(nodes: readonly ShopTreeNode[]): ShopTreeNode[] {
  return nodes.flatMap((node) => [node, ...flat(node.children ?? [])]);
}
const byRole = (nodes: readonly ShopTreeNode[], role: string) => flat(nodes).find((node) => shopPartRoleOf(node.props) === role);

function badgeStyled(style: Record<string, unknown>): Record<string, unknown> | undefined {
  const full = normalizeShopControl(control(), 'en', 'node');
  const styled: ShopTreeNode = {
    ...full,
    children: flat(full.children!).length
      ? full.children!.map(function visit(node): ShopTreeNode {
          const next = { ...node, children: node.children?.map(visit) };
          return shopPartRoleOf(node.props) === 'checkout.demo-badge' ? { ...next, props: { ...node.props, style } } : next;
        })
      : [],
  };
  return byRole(normalizeShopControl(styled, 'en', 'node').children!, 'checkout.demo-badge')?.props?.style as Record<string, unknown> | undefined;
}

describe('a kept part', () => {
  it('keeps one small transform, and loses repeated steps that add up', () => {
    expect(badgeStyled({ transform: 'translateY(-2px)' })?.transform).toBe('translateY(-2px)');
    expect(badgeStyled({ transform: 'translateX(8px) translateX(8px) translateX(8px)' })?.transform).toBeUndefined();
    expect(badgeStyled({ transform: 'scale(1.1) scale(1.1)' })?.transform).toBeUndefined();
  });

  it('keeps one numeric filter, and loses repeated steps that compound', () => {
    expect(badgeStyled({ filter: 'brightness(0.8)' })?.filter).toBe('brightness(0.8)');
    expect(badgeStyled({ filter: 'brightness(0.7) brightness(0.7) brightness(0.7)' })?.filter).toBeUndefined();
    expect(badgeStyled({ filter: 'brightness(0.7) saturate(1.3)' })?.filter).toBeUndefined();
  });

  it('loses a faint mixed colour', () => {
    expect(badgeStyled({ color: 'color-mix(in srgb, red, transparent)' })?.color).toBeUndefined();
    expect(badgeStyled({ color: 'color-mix(in srgb, red 50%, rgba(0, 0, 0, 0.2))' })?.color).toBeUndefined();
    expect(badgeStyled({ color: 'color-mix(in srgb, red, blue)' })?.color).toBe('color-mix(in srgb, red, blue)');
  });
});

describe('a node beside a kept part', () => {
  it('loses its box shadow', () => {
    const full = normalizeShopControl(control(), 'en', 'node');
    const payment = byRole(full.children!, 'checkout.payment')!;
    const sibling: ShopTreeNode = { id: 'sib', type: 'div', props: { style: { boxShadow: '0 0 20px 20px black', color: 'red' } }, children: [] };
    const next = { ...full, children: full.children!.map((child) => (child === payment ? { ...payment, children: [...payment.children!, sibling] } : child)) };
    const out = flat(normalizeShopControl(next, 'en', 'node').children!).find((node) => node.id === 'sib')!;
    expect(out.props?.style).toEqual({ color: 'red' });
  });
});

describe('a control inserted into a closed part', () => {
  it('is refused, like anything else', () => {
    const full = normalizeShopControl(control(), 'en', 'node');
    const pay = byRole(full.children!, 'checkout.pay')!;
    const nested = control();
    expect(shopPartRefusal(nested, [pay, full])).toBeDefined();
    expect(shopPartRefusal(nested, [full])).toBeUndefined();
  });
});

describe('the control root', () => {
  it('is never a form and carries nothing that sends', () => {
    const next = normalizeShopControl(control({ action: 'https://example.com', method: 'post' }, 'form'), 'en', 'node');
    expect(next.type).toBe('div');
    expect(next.props).not.toHaveProperty('action');
    expect(next.props).not.toHaveProperty('method');
  });
});

describe('a reusable component page', () => {
  it('gets the parts of a legacy control, and passes anything else through', () => {
    const definition = { id: 'c1', name: 'Pay', page: { appComponentTree: { id: 'root', type: 'div', props: {}, children: [control()] } } };
    const out = componentsWithShopParts({ c1: definition, odd: 'x' }, 'en') as Record<string, typeof definition>;
    const tree = out.c1.page.appComponentTree as ShopTreeNode;
    expect(byRole(tree.children!, 'checkout.pay')).toBeDefined();
    expect((out as Record<string, unknown>).odd).toBe('x');
    expect(componentsWithShopParts(out, 'en')).toBe(out);
  });
});

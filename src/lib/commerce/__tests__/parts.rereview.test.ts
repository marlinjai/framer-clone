// The second round of guards on the shop parts (src/lib/commerce/parts.ts): rules
// on the control that reach inside it, `!important` in stored styles, stray
// children in a button whose wording is fixed, tokens split across formatting
// runs, and wrappers that crop.
import { describe, expect, it } from 'vitest';
import { normalizeShopControl, shopGuardCss, shopPartRoleOf, shopPartText, type ShopTreeNode } from '../parts';

const control = (rules?: unknown[]): ShopTreeNode => ({
  id: 'co',
  type: 'div',
  props: { 'data-component-kind': 'checkout-button', ...(rules ? { rules } : {}) },
  children: [],
});

function flat(nodes: readonly ShopTreeNode[]): ShopTreeNode[] {
  return nodes.flatMap((node) => [node, ...flat(node.children ?? [])]);
}
const byRole = (nodes: readonly ShopTreeNode[], role: string) => flat(nodes).find((node) => shopPartRoleOf(node.props) === role);

function editing(tree: ShopTreeNode, role: string, edit: (node: ShopTreeNode) => ShopTreeNode): ShopTreeNode {
  const next = { ...tree, children: tree.children?.map((child) => editing(child, role, edit)) };
  return shopPartRoleOf(tree.props) === role ? edit(next) : next;
}

describe("the control's own rules", () => {
  it('lose what hides when they reach inside, and keep everything else', () => {
    const rules = [
      { id: 'a', selector: '&:hover [data-checkout-demo-badge]', style: { display: 'none', color: 'red' } },
      { id: 'b', selector: '& > div', style: { opacity: 0 } },
      { id: 'c', selector: '&:hover', style: { opacity: 0.2, color: 'blue' } },
    ];
    const next = normalizeShopControl(control(rules), 'en', 'node');
    expect(next.props?.rules).toEqual([
      { id: 'a', selector: '&:hover [data-checkout-demo-badge]', style: { color: 'red' } },
      { id: 'b', selector: '& > div', style: {} },
      // On the control itself: the designer may fade the whole checkout.
      { id: 'c', selector: '&:hover', style: { opacity: 0.2, color: 'blue' } },
    ]);
  });

  it('never carry `!important`, on the control or anything inside it', () => {
    const next = normalizeShopControl(control([{ id: 'i', selector: '& div', style: { color: 'red !important' } }]), 'en', 'node');
    expect(next.props?.rules).toEqual([{ id: 'i', selector: '& div', style: { color: 'red' } }]);
    const inner = normalizeShopControl(
      editing(normalizeShopControl(control(), 'en', 'node'), 'checkout.total', (node) => ({ ...node, props: { ...node.props, style: { color: { base: 'red!important' } } } })),
      'en',
      'node',
    );
    expect(byRole(inner.children!, 'checkout.total')?.props?.style).toEqual({ color: { base: 'red' } });
  });

  it('are backed by a platform rule for every part kept in sight', () => {
    const css = shopGuardCss();
    expect(css).toContain('[data-shop-part="checkout.demo-badge"]{visibility:visible!important;opacity:1!important}');
    expect(css).toContain('[data-shop-part="checkout.pay-label"]{visibility:visible!important');
    // The designer's flex or grid stays: the guard never pins a display.
    expect(css).not.toContain('display');
    expect(css).not.toContain('<');
  });
});

describe('a button whose wording is fixed', () => {
  it('drops anything but its own parts', () => {
    const full = normalizeShopControl(control(), 'en', 'node');
    const stuffed = editing(full, 'checkout.pay', (node) => ({
      ...node,
      children: [...node.children!, { id: 'extra', type: 'span', props: { children: 'Kostenlos testen' } }],
    }));
    const next = normalizeShopControl(stuffed, 'en', 'node');
    expect(byRole(next.children!, 'checkout.pay')?.children?.map((child) => shopPartRoleOf(child.props))).toEqual(['checkout.pay-label', 'checkout.pay-loading']);
    const stuffedButton = editing(full, 'checkout.button', (node) => ({ ...node, children: [{ id: 'x', type: '#text', props: { children: 'Gratis' } }, ...node.children!] }));
    expect(flat(normalizeShopControl(stuffedButton, 'en', 'node').children!).some((node) => node.id === 'x')).toBe(false);
  });
});

describe('a token split across formatting runs', () => {
  it('counts as missing, so the default shows', () => {
    expect(shopPartText('checkout.total', { runs: [{ text: 'Summe {to' }, { text: 'tal}', marks: ['strong'] }] }, 'de')).toBe('Zu zahlen: {total}');
    const whole = { runs: [{ text: 'Summe ' }, { text: '{total}', marks: ['strong'] }] };
    expect(shopPartText('checkout.total', whole, 'de')).toBe(whole);
  });
});

describe('a wrapper that crops', () => {
  it('loses its overflow around a part kept in sight', () => {
    const full = normalizeShopControl(control(), 'en', 'node');
    const payment = byRole(full.children!, 'checkout.payment')!;
    const badge = byRole(payment.children!, 'checkout.demo-badge')!;
    const cropped = editing(full, 'checkout.payment', (node) => ({
      ...node,
      children: [{ id: 'crop', type: 'div', props: { style: { height: '1px', overflow: 'hidden', overflowY: 'clip' } }, children: [badge] }, ...node.children!.filter((child) => child !== badge)],
    }));
    const crop = flat(normalizeShopControl(cropped, 'en', 'node').children!).find((node) => node.id === 'crop')!;
    expect(crop.props?.style).toEqual({ height: '1px' });
  });
});

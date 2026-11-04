// The shop control parts (src/lib/commerce/parts.ts): the default tree a control
// arrives with, the normaliser every load and render path runs, and the rules
// that keep required parts and honesty notices on the page.
import { describe, expect, it } from 'vitest';
import {
  SHOP_PART_ATTR,
  buildShopParts,
  fillShopTokens,
  fillShopTokensIn,
  holdsRequiredShopPart,
  missingShopParts,
  normalizeShopControl,
  pageWithShopParts,
  shopPartId,
  shopPartRoleOf,
  shopPartSpec,
  shopPartText,
  withShopParts,
  type ShopTreeNode,
} from '../parts';
import { parseSelector, readRules } from '@/lib/rules/rules';
import { ruleLabel } from '@/lib/rules/states';

const control = (props: Record<string, unknown> = {}, children: ShopTreeNode[] = []): ShopTreeNode => ({
  id: 'co',
  type: 'div',
  props: { 'data-component-kind': 'checkout-button', ...props },
  children,
});

/** Every node of a tree, depth first. */
function flat(nodes: readonly ShopTreeNode[]): ShopTreeNode[] {
  return nodes.flatMap((node) => [node, ...flat(node.children ?? [])]);
}

const byRole = (nodes: readonly ShopTreeNode[], role: string) => flat(nodes).find((node) => shopPartRoleOf(node.props) === role);

describe('buildShopParts', () => {
  const parts = buildShopParts('checkout-button', 'co', 'de');

  it('builds every part with a deterministic id, a layer name and its marker', () => {
    const all = flat(parts);
    expect(all.length).toBeGreaterThan(40);
    expect(new Set(all.map((node) => node.id)).size).toBe(all.length);
    for (const node of all) {
      const role = node.props?.[SHOP_PART_ATTR] as string;
      expect(node.id).toBe(shopPartId('co', role));
      expect(node.label).toBe(shopPartSpec(role)?.label);
      expect(node.componentType).toBe('host');
    }
    expect(buildShopParts('checkout-button', 'co', 'de')).toEqual(parts);
  });

  it('gives each child the id of its parent', () => {
    const pay = byRole(parts, 'checkout.pay')!;
    expect(pay.children?.map((child) => child.parentId)).toEqual([pay.id, pay.id]);
    expect(byRole(parts, 'checkout.button')?.parentId).toBe('co');
  });

  it('writes the default text in the site language', () => {
    expect(byRole(parts, 'checkout.button-label')?.props?.children).toBe('Zur Kasse');
    expect(byRole(parts, 'checkout.field-text.postalCode')?.props?.children).toBe('Postleitzahl');
    const english = buildShopParts('checkout-button', 'co', 'en');
    expect(byRole(english, 'checkout.button-label')?.props?.children).toBe('Checkout');
    // The pay button's wording is fixed (the button solution): nothing stored.
    expect(byRole(english, 'checkout.pay-label')?.props).not.toHaveProperty('children');
  });

  it('stores no text on a fixed or a dynamic part', () => {
    expect(byRole(parts, 'checkout.demo-badge')?.props).not.toHaveProperty('children');
    expect(byRole(parts, 'checkout.payment-ref')?.props).not.toHaveProperty('children');
    expect(byRole(parts, 'checkout.refusal')?.props).not.toHaveProperty('children');
  });

  it('gives the buttons their states as rules the panel names and the parser accepts', () => {
    const rules = byRole(parts, 'checkout.button')?.props?.rules as never;
    const read = readRules(rules);
    expect(read.refused).toEqual([]);
    expect((rules as { selector: string }[]).map((rule) => ruleLabel(rule as never))).toEqual(['Hover', 'Disabled', 'Loading']);
    expect(parseSelector('&[aria-busy="true"]').ok).toBe(true);
  });
});

describe('normalizeShopControl', () => {
  it('gives a control written before parts the whole tree, carrying its old labels into the text', () => {
    const legacy = control({ label: 'Jetzt kaufen', payLabel: 'Zahlen' });
    const next = normalizeShopControl(legacy, 'de', 'node');
    expect(next).not.toBe(legacy);
    expect(next.props).not.toHaveProperty('label');
    expect(next.props).not.toHaveProperty('payLabel');
    expect(byRole(next.children!, 'checkout.button-label')?.props?.children).toBe('Jetzt kaufen');
    expect(byRole(next.children!, 'checkout.pay-label')?.props).not.toHaveProperty('children');
    // A published node needs no editor fields.
    expect(byRole(next.children!, 'checkout.button')).not.toHaveProperty('componentType');
  });

  it('is repeatable: a complete control comes back as the same object', () => {
    const once = normalizeShopControl(control(), 'en', 'snapshot');
    expect(normalizeShopControl(once, 'en', 'snapshot')).toBe(once);
  });

  it('keeps a design and puts back only a missing required part, in its place', () => {
    const full = normalizeShopControl(control(), 'en', 'snapshot');
    const actions = byRole(full.children!, 'checkout.actions')!;
    const designed: ShopTreeNode = {
      ...full,
      children: full.children!.map(function strip(node): ShopTreeNode {
        const role = shopPartRoleOf(node.props);
        // The designer removed the optional decline toggle and lost the back button.
        const children = (node.children ?? []).filter((child) => !['checkout.decline', 'checkout.back'].includes(shopPartRoleOf(child.props) ?? '')).map(strip);
        return role === 'checkout.button' ? { ...node, props: { ...node.props, style: { color: 'rgb(1, 2, 3)' } }, children } : { ...node, children };
      }),
    };
    const next = normalizeShopControl(designed, 'en', 'snapshot');
    expect(byRole(next.children!, 'checkout.decline')).toBeUndefined();
    const back = byRole(next.children!, 'checkout.back')!;
    expect(back.parentId).toBe(actions.id);
    expect(byRole(next.children!, 'checkout.actions')?.children?.map((child) => shopPartRoleOf(child.props))).toEqual(['checkout.pay', 'checkout.back']);
    expect(byRole(next.children!, 'checkout.button')?.props?.style).toEqual({ color: 'rgb(1, 2, 3)' });
  });

  it('keeps a part the designer moved into a wrapper of their own', () => {
    const full = normalizeShopControl(control(), 'en', 'node');
    const button = full.children!.find((child) => shopPartRoleOf(child.props) === 'checkout.button')!;
    const wrapped: ShopTreeNode = {
      ...full,
      children: [{ id: 'wrap', type: 'div', props: {}, children: [button] }, ...full.children!.filter((child) => child !== button)],
    };
    expect(normalizeShopControl(wrapped, 'en', 'node')).toBe(wrapped);
  });

  it('keeps an honesty notice in sight: no stored text, no hiding style, rule or attribute', () => {
    const full = normalizeShopControl(control(), 'en', 'node');
    const hide = (node: ShopTreeNode): ShopTreeNode => {
      const role = shopPartRoleOf(node.props);
      const children = node.children?.map(hide);
      if (role !== 'checkout.demo-badge') return { ...node, children };
      return {
        ...node,
        children,
        props: {
          ...node.props,
          children: 'Real payment',
          hidden: true,
          'aria-hidden': 'true',
          style: { display: { base: 'block', mobile: 'none' }, opacity: 0.1, color: 'red' },
          rules: [{ id: 'h', selector: '&:hover', style: { visibility: 'hidden', fontWeight: 700 } }],
        },
      };
    };
    const next = normalizeShopControl(hide(full), 'en', 'node');
    const badge = byRole(next.children!, 'checkout.demo-badge')!;
    expect(badge.props).not.toHaveProperty('children');
    expect(badge.props).not.toHaveProperty('hidden');
    expect(badge.props).not.toHaveProperty('aria-hidden');
    expect(badge.props?.style).toEqual({ color: 'red' });
    expect(badge.props?.rules).toEqual([{ id: 'h', selector: '&:hover', style: { fontWeight: 700 } }]);
  });

  it('drops text stored on a part whose text is the server message', () => {
    const full = normalizeShopControl(control(), 'en', 'node');
    const typed = withRoleProps(full, 'checkout.refusal', { children: 'All fine' });
    expect(byRole(normalizeShopControl(typed, 'en', 'node').children!, 'checkout.refusal')?.props).not.toHaveProperty('children');
  });

  it('leaves any other node alone', () => {
    const plain: ShopTreeNode = { id: 'x', type: 'div', props: { 'data-component-kind': 'product-detail' } };
    expect(normalizeShopControl(plain, 'en', 'node')).toBe(plain);
  });
});

describe('withShopParts and pageWithShopParts', () => {
  it('normalises every control in a tree and leaves a tree without one untouched', () => {
    const tree: ShopTreeNode = { id: 'root', type: 'div', children: [{ id: 'a', type: 'p', props: { children: 'Hi' } }] };
    expect(withShopParts(tree, 'en', 'node')).toBe(tree);
    const withControl: ShopTreeNode = { ...tree, children: [...tree.children!, control()] };
    const next = withShopParts(withControl, 'en', 'node');
    expect(byRole(next.children!, 'checkout.button')).toBeDefined();
  });

  it('normalises a stored page: its tree and its floating nodes, in the site language', () => {
    const page = {
      id: 'p',
      appComponentTree: { id: 'root', type: 'div', props: {}, children: [control({}, [])] },
      canvasNodes: { fl: { ...control(), id: 'fl' }, frame: { id: 'frame', type: 'div', props: {} } },
    };
    const next = pageWithShopParts(page, 'de-AT');
    const tree = next.appComponentTree as ShopTreeNode;
    expect(byRole(tree.children!, 'checkout.button-label')?.props?.children).toBe('Zur Kasse');
    const floating = (next.canvasNodes as Record<string, ShopTreeNode>).fl;
    expect(byRole(floating.children!, 'checkout.button')?.id).toBe(shopPartId('fl', 'checkout.button'));
    expect((next.canvasNodes as Record<string, ShopTreeNode>).frame).toBe(page.canvasNodes.frame);
    expect(pageWithShopParts(next, 'de')).toBe(next);
  });
});

describe('the delete guard', () => {
  const full = normalizeShopControl(control(), 'en', 'node');
  const actions = byRole(full.children!, 'checkout.actions')!;

  it('refuses a required part and a wrapper holding one, inside the control', () => {
    expect(holdsRequiredShopPart(byRole(full.children!, 'checkout.pay')!, [actions, full])).toBe(true);
    expect(holdsRequiredShopPart({ props: {}, children: [byRole(full.children!, 'checkout.button')!] }, [full])).toBe(true);
  });

  it('allows an optional part, a plain node, the control itself and a part outside any control', () => {
    expect(holdsRequiredShopPart(byRole(full.children!, 'checkout.decline')!, [full])).toBe(false);
    expect(holdsRequiredShopPart({ props: { children: 'Note' } }, [full])).toBe(false);
    expect(holdsRequiredShopPart(full, [{ props: {} }])).toBe(false);
    expect(holdsRequiredShopPart(byRole(full.children!, 'checkout.pay')!, [{ props: {} }])).toBe(false);
  });
});

describe('missingShopParts', () => {
  it('draws the outermost missing branch, holding only what is missing inside it', () => {
    const full = normalizeShopControl(control(), 'en', 'node');
    const withoutPayment: ShopTreeNode = {
      ...full,
      children: full.children!.filter((child) => shopPartRoleOf(child.props) !== 'checkout.payment'),
    };
    const missing = missingShopParts(withoutPayment, 'en');
    expect(missing.map((node) => shopPartRoleOf(node.props))).toEqual(['checkout.payment']);
    // The optional decline toggle is not drawn back.
    expect(byRole(missing, 'checkout.decline')).toBeUndefined();
    expect(byRole(missing, 'checkout.input.email')).toBeDefined();
    expect(missingShopParts(full, 'en')).toEqual([]);
  });
});

describe('text', () => {
  it('fills tokens and leaves unknown ones as typed', () => {
    expect(fillShopTokens('Pay {total} for {order}', { total: '1.00 EUR' })).toBe('Pay 1.00 EUR for {order}');
    expect(fillShopTokensIn({ runs: [{ text: 'Total {total}', marks: ['strong'] }] }, { total: '2' })).toEqual({ runs: [{ text: 'Total 2', marks: ['strong'] }] });
  });

  it('falls back to the default for an emptied label and keeps fixed text whatever is stored', () => {
    expect(shopPartText('checkout.field-text.name', '   ', 'de')).toBe('Vollständiger Name');
    expect(shopPartText('checkout.field-text.name', 'Name', 'de')).toBe('Name');
    expect(shopPartText('checkout.demo-badge', 'Real money', 'en')).toBe('Demo payment. No real charge will be made.');
    expect(shopPartText('checkout.refusal', 'x', 'en')).toBeUndefined();
  });
});

function withRoleProps(node: ShopTreeNode, role: string, props: Record<string, unknown>): ShopTreeNode {
  const children = node.children?.map((child) => withRoleProps(child, role, props));
  return shopPartRoleOf(node.props) === role ? { ...node, props: { ...node.props, ...props }, children } : { ...node, children };
}

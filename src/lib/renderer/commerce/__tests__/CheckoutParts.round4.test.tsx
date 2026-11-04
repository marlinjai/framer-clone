// The fourth review round on the checkout parts (docs/plans/2026-11-02-designable-shop-controls.md,
// section 5): each part only in the place its spec gives it, the pay button holding
// its own parts only, one copy per role, no generated content or animation inside
// a control, nothing laid over a part kept in sight, and the island's pins set
// always (not only when something hides at render time). Built from the
// reviewer's attacks, driven through the published render into the payment step.
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import { renderPublishedPage } from '@/lib/renderer/server/renderPublishedPage';
import { CART_STORAGE_KEY } from '@/lib/commerce/cart';
import { SHOP_KEPT_WRAPPER_ATTR, misplacesShopPart, normalizeShopControl, shopGuardCss, shopPartRoleOf, type ShopTreeNode } from '@/lib/commerce/parts';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

const repos = {
  cmsRepo: { listRows: async () => ({ rows: [], total: 0 }), getRow: async () => null },
  commerceRepo: {
    listProducts: async () => ({ products: [], total: 0 }),
    getProductByHandle: async () => null,
    listVariants: async () => [],
    getPrices: async () => [],
    getAvailability: async () => ({ variantId: 'x', locationId: 'all', availableQuantity: 0, limited: true, stale: false }),
  },
} as never;
const fakeResponse = (status: number, body: unknown) => ({ status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
const flat = (nodes: ShopTreeNode[]): ShopTreeNode[] => nodes.flatMap((node) => [node, ...flat(node.children ?? [])]);
const find = (tree: ShopTreeNode, role: string) => flat([tree]).find((node) => shopPartRoleOf(node.props) === role)!;
const detach = (tree: ShopTreeNode, node: ShopTreeNode): ShopTreeNode => ({ ...tree, children: (tree.children ?? []).filter((child) => child !== node).map((child) => detach(child, node)) });
function attach(tree: ShopTreeNode, role: string, node: ShopTreeNode, first = false): ShopTreeNode {
  const children = (tree.children ?? []).map((child) => attach(child, role, node, first));
  return shopPartRoleOf(tree.props) === role ? { ...tree, children: first ? [node, ...children] : [...children, node] } : { ...tree, children };
}
function move(tree: ShopTreeNode, role: string, into: string, first = false, edit?: (node: ShopTreeNode) => ShopTreeNode) {
  const node = find(tree, role);
  return attach(detach(tree, node), into, edit ? edit(node) : node, first);
}
const base = () => normalizeShopControl({ id: 'co', type: 'div', props: { 'data-component-kind': 'checkout-button' } } as ShopTreeNode, 'de', 'node');
const settled = (tree: ShopTreeNode) => {
  const once = normalizeShopControl(tree, 'de', 'node');
  expect(normalizeShopControl(once, 'de', 'node')).toBe(once);
  return once;
};

async function toPayment(tree: ShopTreeNode, rootProps: Record<string, unknown> = {}) {
  window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify([{ variantId: 'var_a', quantity: 1 }]));
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(201, { orderId: 'o1', orderNumber: 'ORD-1', totalCents: 4760, currency: 'EUR' }));
  const { body } = await renderPublishedPage({
    root: { type: 'div', id: 'root', props: rootProps, children: [tree] },
    pageParams: {},
    ...(repos as object),
    consent: { language: 'de' },
  } as never);
  const { container } = render(<>{body}</>);
  const button = await waitFor(() => {
    const found = container.querySelector<HTMLButtonElement>('button[data-checkout]');
    expect(found?.disabled).toBe(false);
    return found!;
  });
  await act(async () => {
    fireEvent.click(button);
  });
  await waitFor(() => expect(container.querySelector('[data-checkout-payment]')).not.toBeNull());
  return container;
}

const PAY_WORDING = 'Zahlungspflichtig bestellen (47,60 EUR)';

describe('the pay button', () => {
  it('ignores a part of somewhere else moved in, and gets its own label back when it was moved away', async () => {
    let tree = move(base(), 'checkout.button-label', 'checkout.pay', true, (node) => ({ ...node, props: { ...node.props, children: 'Kostenlos testen' } }));
    tree = move(tree, 'checkout.pay-label', 'checkout.confirmation');
    const container = await toPayment(settled(tree));
    expect(container.querySelector('button[data-checkout-pay]')?.textContent).toBe(PAY_WORDING);
  });

  it('adds no words from a legend moved in', async () => {
    const tree = move(base(), 'checkout.buyer-legend', 'checkout.pay', true, (node) => ({ ...node, props: { ...node.props, children: 'Gratis testen,' } }));
    const container = await toPayment(settled(tree));
    expect(container.querySelector('button[data-checkout-pay]')?.textContent).toBe(PAY_WORDING);
  });

  it('keeps one label when a copy of it is pasted in, and settles in one pass', () => {
    const tree = base();
    const label = find(tree, 'checkout.pay-label');
    const pasted = attach(tree, 'checkout.pay', { ...label, id: 'copy' });
    const pay = find(settled(pasted), 'checkout.pay');
    expect(pay.children!.map((child) => shopPartRoleOf(child.props))).toEqual(['checkout.pay-label', 'checkout.pay-loading']);
  });
});

describe('a part kept in sight moved under a part the island hides', () => {
  it('comes back in its own place, so the payment step still shows the notice and the total', async () => {
    let tree = move(base(), 'checkout.demo-badge', 'checkout.confirmation');
    tree = move(tree, 'checkout.total', 'checkout.redirecting');
    const container = await toPayment(settled(tree));
    expect(container.querySelector('[data-checkout-payment] [data-checkout-demo-badge]')).not.toBeNull();
    expect(container.querySelector('[data-checkout-payment] [data-checkout-payment-total]')).not.toBeNull();
  });

  it('is refused by the editor as a move inside the control', () => {
    const tree = base();
    const badge = find(tree, 'checkout.demo-badge');
    const confirmation = find(tree, 'checkout.confirmation');
    const payment = find(tree, 'checkout.payment');
    expect(misplacesShopPart(badge, [confirmation, tree])).toBe(true);
    expect(misplacesShopPart(badge, [payment, tree])).toBe(false);
    // A wrapper without a role between the part and its place is fine.
    expect(misplacesShopPart(badge, [{ props: {} }, payment, tree])).toBe(false);
    expect(misplacesShopPart({ props: {}, children: [badge] }, [confirmation, tree])).toBe(true);
  });
});

describe('styles and rules inside a control', () => {
  it('keep no generated content and no animation, and a kept part keeps no outline, negative spacing or far padding', () => {
    let tree: ShopTreeNode = {
      ...base(),
      props: {
        ...base().props,
        rules: [
          { id: 'x', selector: '& [data-shop-part="checkout.pay-label"]::before', style: { content: '"Kostenlos testen. "', color: 'red' } },
          { id: 'y', selector: '& [data-shop-part="checkout.demo-badge"]', style: { animation: 'u-hide 0s 3s forwards', animationDelay: '3s' } },
        ],
      },
    };
    tree = move(tree, 'checkout.demo-badge', 'checkout.payment', true, (node) => ({
      ...node,
      props: { ...node.props, style: { color: '#92400e', outline: '40px solid #fffbeb', outlineOffset: '-40px', letterSpacing: '-1em', wordSpacing: '-2em', paddingLeft: '5000px', padding: '6px 10px' } },
    }));
    const next = settled(tree);
    expect(next.props?.rules).toEqual([
      { id: 'x', selector: '& [data-shop-part="checkout.pay-label"]::before', style: { color: 'red' } },
      { id: 'y', selector: '& [data-shop-part="checkout.demo-badge"]', style: {} },
    ]);
    expect(find(next, 'checkout.demo-badge').props?.style).toEqual({ color: '#92400e', padding: '6px 10px' });
  });

  it('lay nothing over a part kept in sight: a sibling loses its positioning, negative margin, click-through and wide outline', () => {
    const overlay: ShopTreeNode = {
      id: 'ov',
      type: 'span',
      props: {
        children: 'Kostenlos testen',
        style: { marginLeft: '-220px', width: '220px', position: 'relative', zIndex: 5, pointerEvents: 'none', gridArea: '1 / 1', outline: '60px solid #065f46', backgroundColor: '#065f46' },
        rules: [{ id: 'f', selector: '&:focus-visible', style: { outline: '2px solid #111827', outlineOffset: '2px' } }],
      },
      children: [],
    };
    const next = settled(attach(base(), 'checkout.actions', overlay));
    const sibling = flat([next]).find((node) => node.id === 'ov')!;
    // Grid placement stays: a layout with the form beside the total is ordinary design.
    expect(sibling.props?.style).toEqual({ width: '220px', gridArea: '1 / 1', backgroundColor: '#065f46' });
    // A focus ring stays.
    expect(sibling.props?.rules).toEqual([{ id: 'f', selector: '&:focus-visible', style: { outline: '2px solid #111827', outlineOffset: '2px' } }]);
  });
});

describe('the guard rule', () => {
  it("blanks the generated content of every kept part, its wrappers and the fixed-wording buttons, and keeps a kept part's first letter readable", () => {
    const css = shopGuardCss();
    for (const selector of ['[data-shop-part="checkout.pay-label"]', '[data-shop-part="checkout.pay"]', '[data-shop-part="checkout.button"]', '[data-shop-part="checkout.payment"]', `[${SHOP_KEPT_WRAPPER_ATTR}]`]) {
      expect(css).toContain(`${selector}::before`);
      expect(css).toContain(`${selector}::after`);
    }
    expect(css).toMatch(/::after\{content:none!important\}/);
    expect(css).toContain('[data-shop-part="checkout.demo-badge"]::first-letter');
  });
});

describe('the island', () => {
  it('pins a kept part readable, also against a rule from the page root, and leaves its wrappers to the design', async () => {
    const container = await toPayment(base(), {
      rules: [
        { id: 'r', selector: '& [data-shop-part="checkout.pay-label"]::before', style: { content: '"Kostenlos "' } },
        { id: 's', selector: '& [data-shop-part="checkout.demo-badge"]', style: { textIndent: '-9999px', letterSpacing: '-1em', color: 'transparent' } },
      ],
    });
    const badge = container.querySelector<HTMLElement>('[data-checkout-demo-badge]')!;
    for (const [property, value] of [
      ['transform', 'none'],
      ['scale', 'none'],
      ['translate', 'none'],
      ['clip-path', 'none'],
      ['mask-image', 'none'],
      ['filter', 'none'],
      ['animation', 'none'],
      ['text-indent', '0px'],
      ['letter-spacing', 'normal'],
      ['visibility', 'visible'],
      ['opacity', '1'],
    ]) {
      expect(badge.style.getPropertyValue(property), property).toBe(value);
      expect(badge.style.getPropertyPriority(property), property).toBe('important');
    }
    // A see-through colour gets the dark default.
    expect(badge.style.getPropertyValue('color')).toBe('rgb(17, 24, 39)');
    // Every wrapper up to the control is marked for the guard rule, and keeps its own design.
    const pay = container.querySelector<HTMLElement>('button[data-checkout-pay]')!;
    expect(pay.hasAttribute(SHOP_KEPT_WRAPPER_ATTR)).toBe(true);
    expect(pay.style.getPropertyValue('transform')).toBe('');
    expect(pay.style.getPropertyValue('display')).toBe('');
    expect(pay.textContent).toBe(PAY_WORDING);
  });
});

describe('the fifth review round', () => {
  it('a part kept in sight holds no nodes: no words join the pay wording and no cover sits inside the notice', async () => {
    let tree = attach(base(), 'checkout.pay-label', { id: 'more', type: 'span', props: { children: ' GRATIS, keine Kosten' }, children: [] });
    tree = attach(tree, 'checkout.demo-badge', {
      id: 'cover',
      type: 'div',
      props: { children: 'Echte Zahlung.', style: { position: 'absolute', inset: '0', backgroundColor: '#fffbeb', zIndex: 5 } },
      children: [],
    });
    const next = settled(tree);
    expect(find(next, 'checkout.pay-label').children).toEqual([]);
    expect(find(next, 'checkout.demo-badge').children).toEqual([]);
    const container = await toPayment(next);
    expect(container.querySelector('button[data-checkout-pay]')?.textContent).toBe(PAY_WORDING);
    expect(container.querySelector('[data-checkout-demo-badge]')?.textContent).not.toContain('Echte Zahlung');
  });

  it('keeps a designed focus ring on the pay button, and only a focus ring', () => {
    const tree = attach(base(), 'checkout.actions', { id: 'x', type: 'span', props: {}, children: [] });
    const withRing = {
      ...tree,
      children: tree.children!.map(function ring(child: ShopTreeNode): ShopTreeNode {
        const next = { ...child, children: child.children?.map(ring) };
        return shopPartRoleOf(child.props) === 'checkout.pay'
          ? { ...next, props: { ...next.props, rules: [{ id: 'f', selector: '&:focus-visible', style: { outline: '2px solid #2563eb', outlineOffset: '2px' } }, { id: 'w', selector: '&:hover', style: { outline: '60px solid #fff' } }] } }
          : next;
      }),
    };
    const pay = find(settled(withRing), 'checkout.pay');
    expect(pay.props?.rules).toEqual([
      { id: 'f', selector: '&:focus-visible', style: { outline: '2px solid #2563eb', outlineOffset: '2px' } },
    ]);
  });

  it('strips a stored form attribute inside the control', () => {
    const tree = attach(base(), 'checkout.actions', { id: 'f', type: 'input', props: { form: 'evil' }, children: [] });
    expect(flat([settled(tree)]).find((node) => node.id === 'f')?.props).not.toHaveProperty('form');
  });
});

describe('the accident-scope review', () => {
  const edit = (tree: ShopTreeNode, role: string, change: (node: ShopTreeNode) => ShopTreeNode): ShopTreeNode => {
    const next = { ...tree, children: tree.children?.map((child) => edit(child, role, change)) };
    return shopPartRoleOf(tree.props) === role ? change(next) : next;
  };

  it("leaves the pay label's colour to its button, so an inverted hover keeps the wording readable", async () => {
    const tree = edit(base(), 'checkout.pay', (node) => ({
      ...node,
      props: { ...node.props, rules: [{ id: 'h', selector: '&:hover', style: { backgroundColor: '#ffffff', color: '#065f46' } }] },
    }));
    const next = settled(tree);
    expect(find(next, 'checkout.pay').props?.rules).toEqual([{ id: 'h', selector: '&:hover', style: { backgroundColor: '#ffffff', color: '#065f46' } }]);
    const container = await toPayment(next);
    const label = container.querySelector<HTMLElement>('[data-shop-part="checkout.pay-label"]')!;
    // Not frozen: the label inherits whatever colour the button has now.
    expect(label.style.getPropertyValue('color')).toBe('');
    expect(label.style.getPropertyValue('-webkit-text-fill-color')).toBe('currentcolor');
  });

  it('keeps ordinary design: a hover lift and press, a gentle hover filter, grid placement of the steps, responsive type', () => {
    let tree = edit(base(), 'checkout.button', (node) => ({
      ...node,
      props: {
        ...node.props,
        style: { ...(node.props?.style as object), gridArea: 'cta', position: 'relative' },
        rules: [{ id: 'h', selector: '&:hover', style: { transform: 'translateY(-2px)' } }, { id: 'p', selector: '&:active', style: { transform: 'scale(0.98)' } }],
      },
    }));
    tree = edit(tree, 'checkout.pay', (node) => ({ ...node, props: { ...node.props, rules: [{ id: 'f', selector: '&:hover', style: { filter: 'brightness(0.9)', transform: 'translateY(-1px)' } }] } }));
    tree = edit(tree, 'checkout.buyer', (node) => ({ ...node, props: { ...node.props, style: { ...(node.props?.style as object), gridColumn: '1', gridRow: '1 / 3' } } }));
    tree = edit(tree, 'checkout.total', (node) => ({ ...node, props: { ...node.props, style: { ...(node.props?.style as object), fontSize: 'clamp(1rem, 2vw, 1.5rem)' } } }));
    const next = settled(tree);
    const button = find(next, 'checkout.button');
    expect(button.props?.style).toMatchObject({ gridArea: 'cta', position: 'relative' });
    expect(button.props?.rules).toEqual([{ id: 'h', selector: '&:hover', style: { transform: 'translateY(-2px)' } }, { id: 'p', selector: '&:active', style: { transform: 'scale(0.98)' } }]);
    expect(find(next, 'checkout.pay').props?.rules).toEqual([{ id: 'f', selector: '&:hover', style: { filter: 'brightness(0.9)', transform: 'translateY(-1px)' } }]);
    expect(find(next, 'checkout.buyer').props?.style).toMatchObject({ gridColumn: '1', gridRow: '1 / 3' });
    expect(find(next, 'checkout.total').props?.style).toMatchObject({ fontSize: 'clamp(1rem, 2vw, 1.5rem)' });
  });

  it('still takes away what shrinks, moves or hides: a large scale, a far translation, a strong filter', () => {
    const tree = edit(base(), 'checkout.pay', (node) => ({
      ...node,
      props: { ...node.props, rules: [{ id: 'x', selector: '&:hover', style: { transform: 'scale(0)', filter: 'brightness(0)', translate: '9999px', color: '#fff' } }] },
    }));
    expect(find(settled(tree), 'checkout.pay').props?.rules).toEqual([{ id: 'x', selector: '&:hover', style: { color: '#fff' } }]);
  });

  it('gives the pay button no other accessible name or tooltip, and no text of its own', async () => {
    const tree = edit(base(), 'checkout.pay', (node) => ({ ...node, props: { ...node.props, 'aria-label': 'Jetzt kaufen', title: 'Gratis', children: 'Jetzt kaufen' } }));
    const next = settled(tree);
    const pay = find(next, 'checkout.pay');
    for (const key of ['aria-label', 'title', 'children']) expect(pay.props, key).not.toHaveProperty(key);
    const container = await toPayment(next);
    const button = container.querySelector<HTMLElement>('button[data-checkout-pay]')!;
    expect(button.getAttribute('aria-label')).toBeNull();
    expect(button.getAttribute('title')).toBeNull();
    expect(button.textContent).toBe(PAY_WORDING);
  });
});

describe('the approving review', () => {
  const edit = (tree: ShopTreeNode, role: string, change: (node: ShopTreeNode) => ShopTreeNode): ShopTreeNode => {
    const next = { ...tree, children: tree.children?.map((child) => edit(child, role, change)) };
    return shopPartRoleOf(tree.props) === role ? change(next) : next;
  };
  const faded = (node: ShopTreeNode) => ({ ...node, props: { ...node.props, style: { ...(node.props?.style as object), opacity: 0.6 } } });

  it('pins faded wrappers opaque when their opacities multiply under one half', async () => {
    let tree = edit(base(), 'checkout.payment', faded);
    tree = edit(tree, 'checkout.actions', faded);
    tree = edit(tree, 'checkout.pay', faded);
    const container = await toPayment(settled(tree));
    for (const selector of ['[data-checkout-payment]', '[data-shop-part="checkout.actions"]', 'button[data-checkout-pay]']) {
      const node = container.querySelector<HTMLElement>(selector)!;
      expect(node.style.getPropertyValue('opacity'), selector).toBe('1');
      expect(node.style.getPropertyPriority('opacity'), selector).toBe('important');
    }
  });

  it('leaves one gentle fade alone', async () => {
    const container = await toPayment(settled(edit(base(), 'checkout.payment', faded)));
    const payment = container.querySelector<HTMLElement>('[data-checkout-payment]')!;
    // The designer's fade, not pinned.
    expect(payment.style.getPropertyPriority('opacity')).toBe('');
    expect(getComputedStyle(payment).opacity).toBe('0.6');
  });

  it('keeps the usual spellings of a hover lift and a drop shadow', () => {
    const tree = edit(base(), 'checkout.pay', (node) => ({
      ...node,
      props: { ...node.props, rules: [{ id: 'h', selector: '&:hover', style: { transform: 'translate3d(0, -2px, 0)', filter: 'drop-shadow(0 2px 4px rgba(0, 0, 0, 0.2)) brightness(0.95)' } }] },
    }));
    expect(find(settled(tree), 'checkout.pay').props?.rules).toEqual([
      { id: 'h', selector: '&:hover', style: { transform: 'translate3d(0, -2px, 0)', filter: 'drop-shadow(0 2px 4px rgba(0, 0, 0, 0.2)) brightness(0.95)' } },
    ]);
  });

  it('lifts a kept part above its siblings, so one placed in the same grid cell cannot cover it', async () => {
    const container = await toPayment(base());
    const total = container.querySelector<HTMLElement>('[data-checkout-payment-total]')!;
    expect(total.style.getPropertyValue('position')).toBe('relative');
    expect(total.style.getPropertyValue('z-index')).toBe('1');
    // Contained in the control, so it never paints over the site's own sticky header.
    expect(total.closest<HTMLElement>('[data-component-kind="checkout-button"]')!.style.getPropertyValue('isolation')).toBe('isolate');
  });
});

describe('the island across renders', () => {
  it("puts the design's own value back once a pin is no longer needed, and keeps a pin another kept part still holds", async () => {
    const { container } = render(
      <div data-component-kind="checkout-button">
        <div data-testid="step" style={{ opacity: 0.6 }}>
          <div data-testid="row" style={{ opacity: 0.6 }}>
            <span data-shop-part="checkout.total">Total</span>
          </div>
        </div>
      </div>,
    );
    const step = container.querySelector<HTMLElement>('[data-testid="step"]')!;
    const row = container.querySelector<HTMLElement>('[data-testid="row"]')!;
    const total = container.querySelector<HTMLElement>('[data-shop-part="checkout.total"]')!;
    const { keepInSightForTest } = await import('@/lib/commerce/shopRuntime');
    // 0.6 x 0.6 is under one half: both wrappers are pinned opaque.
    keepInSightForTest(total);
    expect(step.style.getPropertyPriority('opacity')).toBe('important');
    expect(row.style.getPropertyValue('opacity')).toBe('1');
    // The designer lifts the row's fade; the next render puts the step's own 0.6 back.
    row.style.setProperty('opacity', '1');
    keepInSightForTest(total);
    expect(step.style.getPropertyValue('opacity')).toBe('0.6');
    expect(step.style.getPropertyPriority('opacity')).toBe('');
  });
});

describe('a kept part that leaves the page', () => {
  it("releases its pins, so the wrappers get the design's own fade back", async () => {
    const { ShopPartElement, ShopRuntimeContext } = await import('@/lib/commerce/shopRuntime');
    const runtime = { kind: 'checkout-button', locale: 'en', surface: 'live', part: () => ({ visible: true, tokens: { total: '1 EUR' } }) };
    const Tree = ({ show }: { show: boolean }) => (
      <ShopRuntimeContext.Provider value={runtime as never}>
        <div data-component-kind="checkout-button">
          <div data-testid="step" style={{ opacity: 0.6 }}>
            <div data-testid="row" style={{ opacity: 0.6 }}>
              {show ? <ShopPartElement role="checkout.total" tag="div" domProps={{}} storedText={undefined} surface="preview" /> : null}
            </div>
          </div>
        </div>
      </ShopRuntimeContext.Provider>
    );
    const view = render(<Tree show />);
    const step = view.getByTestId('step');
    expect(step.style.getPropertyPriority('opacity')).toBe('important');
    view.rerender(<Tree show={false} />);
    expect(step.style.getPropertyValue('opacity')).toBe('0.6');
    expect(step.style.getPropertyPriority('opacity')).toBe('');
  });
});

describe('a kept part, read at run time', () => {
  it('counts a see-through colour(...) value as see-through, and a solid one as solid', async () => {
    const { keepInSightForTest } = await import('@/lib/commerce/shopRuntime');
    const { container } = render(
      <div data-component-kind="checkout-button">
        <span data-shop-part="checkout.total">Total</span>
      </div>,
    );
    const total = container.querySelector<HTMLElement>('[data-shop-part="checkout.total"]')!;
    const real = window.getComputedStyle.bind(window);
    const colour = (value: string) =>
      vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
        const computed = real(element, pseudo);
        return element === total ? new Proxy(computed, { get: (target, key) => (key === 'color' ? value : Reflect.get(target, key) instanceof Function ? (Reflect.get(target, key) as () => unknown).bind(target) : Reflect.get(target, key)) }) : computed;
      });
    colour('color(srgb 1 0 0 / 0.2)');
    keepInSightForTest(total);
    expect(total.style.getPropertyValue('color')).toBe('rgb(17, 24, 39)');
    vi.restoreAllMocks();
    total.removeAttribute('style');
    colour('color(srgb 1 0 0 / 0.9)');
    keepInSightForTest(total);
    expect(total.style.getPropertyValue('color')).toBe('');
    vi.restoreAllMocks();
  });
});

describe('a part with fixed text', () => {
  it('draws the platform text even when a stored contentEditable is on it', async () => {
    const { ShopPartElement, ShopRuntimeContext } = await import('@/lib/commerce/shopRuntime');
    const runtime = { kind: 'checkout-button', locale: 'en', surface: 'live', part: () => ({ visible: true, tokens: { total: '1 EUR' } }) };
    const { container } = render(
      <ShopRuntimeContext.Provider value={runtime as never}>
        <div data-component-kind="checkout-button">
          <ShopPartElement role="checkout.demo-badge" tag="div" domProps={{ contentEditable: 'true' }} storedText={undefined} surface="preview" />
        </div>
      </ShopRuntimeContext.Provider>,
    );
    expect(container.querySelector('[data-component-kind] > div')?.textContent).toMatch(/Demo payment/);
  });
});

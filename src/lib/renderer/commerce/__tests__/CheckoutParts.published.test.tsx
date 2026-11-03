// A designed checkout on a published page (designable shop controls): the
// designer's text, styles and states reach the island, the island keeps every
// behaviour whatever the parts say, the honesty notice cannot be hidden or
// reworded, and a page saved before parts still checks out in the site language.
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import type { ComponentNode, CommerceServerRepository } from '@/lib/renderer/publish/hydrateBindings';
import type { CmsReadRepository } from '@/server/cms';
import { renderPublishedPage } from '@/lib/renderer/server/renderPublishedPage';
import { CART_STORAGE_KEY } from '@/lib/commerce/cart';
import { SHOP_PART_ATTR, normalizeShopControl, shopPartRoleOf, type ShopTreeNode } from '@/lib/commerce/parts';

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

/** The tree with `edit` applied to the part of each role named. */
function designed(tree: ShopTreeNode, edits: Record<string, (props: Record<string, unknown>) => Record<string, unknown>>): ShopTreeNode {
  const role = shopPartRoleOf(tree.props);
  const props = role && edits[role] ? edits[role]({ ...tree.props }) : tree.props;
  return { ...tree, props, children: tree.children?.map((child) => designed(child, edits)) };
}

function page(control: ShopTreeNode): ComponentNode {
  return { type: 'div', id: 'root', children: [control as ComponentNode] };
}

async function publish(root: ComponentNode, language: string) {
  const { body } = await renderPublishedPage({ root, pageParams: {}, ...repos, consent: { language } });
  return render(<>{body}</>);
}

function fakeResponse(status: number, body: unknown): Response {
  return { status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

const control = { id: 'co', type: 'div', props: { 'data-component-kind': 'checkout-button' } } as ShopTreeNode;

describe('a designed checkout, published', () => {
  const tree = designed(normalizeShopControl(control, 'de', 'node'), {
    'checkout.button': (props) => ({ ...props, type: 'submit', style: { ...(props.style as object), color: 'rgb(1, 2, 3)' } }),
    'checkout.button-label': (props) => ({ ...props, children: 'Jetzt bestellen' }),
    'checkout.input.email': (props) => ({ ...props, name: 'hijack', type: 'text', placeholder: 'du@beispiel.de' }),
    'checkout.demo-badge': (props) => ({ ...props, children: 'Echte Zahlung', style: { display: 'none', color: 'rgb(9, 9, 9)' } }),
    'checkout.total': (props) => ({ ...props, children: 'Summe: {total}' }),
  });

  it("shows the designer's text and style, and keeps the button a plain button", async () => {
    window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify([{ variantId: 'var_a', quantity: 1 }]));
    const { container } = await publish(page(tree), 'de');
    const button = await waitFor(() => {
      const found = container.querySelector<HTMLButtonElement>('button[data-checkout]');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(button.textContent).toBe('Jetzt bestellen');
    expect(button.type).toBe('button');
    expect(button.getAttribute(SHOP_PART_ATTR)).toBe('checkout.button');
    // The style left the inline attribute for the page sheet, with the button's states.
    const sheet = [...container.querySelectorAll('style')].map((style) => style.textContent).join('\n');
    expect(sheet).toContain('rgb(1, 2, 3)');
    expect(sheet).toMatch(/:disabled/);
    expect(sheet).toMatch(/\[aria-busy="true"\]/);
  });

  it('runs the real checkout through the designed parts, with behaviour the parts cannot change', async () => {
    window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify([{ variantId: 'var_a', quantity: 1 }]));
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(fakeResponse(201, { orderId: 'o1', orderNumber: 'ORD-1', totalCents: 4760, currency: 'EUR' }));
    const { container } = await publish(page(tree), 'de');
    const button = await waitFor(() => {
      const found = container.querySelector<HTMLButtonElement>('button[data-checkout]');
      expect(found?.disabled).toBe(false);
      return found!;
    });
    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() => expect(container.querySelector('[data-checkout-payment]')).not.toBeNull());
    expect(fetchSpy).toHaveBeenCalledWith('/api/commerce/orders', expect.objectContaining({ method: 'POST' }));
    expect(container.querySelector('[data-checkout-payment-total]')?.textContent).toBe('Summe: 47,60 EUR');
    const email = container.querySelector<HTMLInputElement>('input[data-checkout-buyer-field="email"]')!;
    // No name, the designer's included: nothing of the buyer's can be posted by a form around the checkout.
    expect(email.name).toBe('');
    expect(email.autocomplete).toBe('email');
    expect(email.type).toBe('email');
    expect(email.required).toBe(true);
    expect(email.placeholder).toBe('du@beispiel.de');
    // The demo notice keeps the platform's words and stays in sight.
    const badge = container.querySelector<HTMLElement>('[data-checkout-demo-badge]')!;
    expect(badge.textContent).toBe('Demo-Zahlung. Es wird kein echtes Geld abgebucht.');
    // Its colour is the designer's; nothing hides it, inline or in the page sheet.
    expect(badge.style.color).toBe('rgb(9, 9, 9)');
    // Shown, with the designer's display: the island pins a display only where it computes to none.
    expect(getComputedStyle(badge).display).not.toBe('none');
    expect(badge.style.getPropertyValue('display')).toBe('');
    const sheet = [...container.querySelectorAll('style')].map((style) => style.textContent).join('\n');
    expect(sheet).not.toMatch(/demo-badge[^{]*\{[^}]*display:\s*none/);
    expect(badge.hidden).toBe(false);
  });

  it('forces the demo notice and its wrappers visible against a stylesheet the normaliser never saw', async () => {
    window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify([{ variantId: 'var_a', quantity: 1 }]));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(201, { orderId: 'o1', orderNumber: 'ORD-1', totalCents: 4760, currency: 'EUR' }));
    // A site head item, say: nothing in the stored page, so only the island can answer it.
    const sheet = document.createElement('style');
    sheet.textContent = '[data-checkout-payment] { visibility: hidden !important; } [data-checkout-demo-badge] { display: none !important; }';
    document.head.appendChild(sheet);
    try {
      const { container } = await publish(page(tree), 'de');
      const button = await waitFor(() => {
        const found = container.querySelector<HTMLButtonElement>('button[data-checkout]');
        expect(found?.disabled).toBe(false);
        return found!;
      });
      await act(async () => {
        fireEvent.click(button);
      });
      const badge = await waitFor(() => {
        const found = container.querySelector<HTMLElement>('[data-checkout-demo-badge]');
        expect(found).not.toBeNull();
        return found!;
      });
      expect(badge.style.getPropertyValue('display')).toBe('block');
      expect(badge.style.getPropertyPriority('display')).toBe('important');
      expect(getComputedStyle(badge).display).toBe('block');
      const payment = container.querySelector<HTMLElement>('[data-checkout-payment]')!;
      expect(payment.style.getPropertyPriority('visibility')).toBe('important');
      expect(getComputedStyle(badge).visibility).toBe('visible');
    } finally {
      sheet.remove();
    }
  });

  it("speaks the button solution's words on the pay button, whatever was stored", async () => {
    window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify([{ variantId: 'var_a', quantity: 1 }]));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse(201, { orderId: 'o1', orderNumber: 'ORD-1', totalCents: 4760, currency: 'EUR' }));
    const retyped = designed(tree, { 'checkout.pay-label': (props) => ({ ...props, children: 'Weiter' }) });
    const { container } = await publish(page(retyped), 'de');
    const button = await waitFor(() => {
      const found = container.querySelector<HTMLButtonElement>('button[data-checkout]');
      expect(found?.disabled).toBe(false);
      return found!;
    });
    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() => expect(container.querySelector('button[data-checkout-pay]')?.textContent).toBe('Zahlungspflichtig bestellen (47,60 EUR)'));
  });
});

describe('formatted text in a message part', () => {
  afterEach(() => window.history.replaceState(null, '', '/'));

  it('keeps its link outside a button and fills its tokens run by run', async () => {
    window.history.replaceState(null, '', '/cart?checkout=cancelled&order=ORD-7');
    const tree = designed(normalizeShopControl(control, 'de', 'node'), {
      'checkout.returned-cancelled': (props) => ({
        ...props,
        children: { runs: [{ text: 'Abgebrochen. ' }, { text: 'Hilfe', href: '/hilfe' }] },
      }),
      'checkout.button-label': (props) => ({ ...props, children: { runs: [{ text: 'Kasse', href: '/kasse' }] } }),
    });
    const { container } = await publish(page(tree), 'de');
    const cancelled = await waitFor(() => {
      const found = container.querySelector('[data-checkout-returned="cancelled"]');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(cancelled.querySelector('a')?.getAttribute('href')).toBe('/hilfe');
    // Inside the button a link would be invalid: the text stays, the link does not.
    const button = container.querySelector('button[data-checkout]')!;
    expect(button.textContent).toBe('Kasse');
    expect(button.querySelector('a')).toBeNull();
  });
});

describe('a checkout published before parts', () => {
  it('gets the default parts in the site language, its old label kept', async () => {
    window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify([{ variantId: 'var_a', quantity: 1 }]));
    const legacy = { ...control, props: { ...control.props, label: 'Kaufen' } } as ShopTreeNode;
    const { container } = await publish(page(legacy), 'de');
    const button = await waitFor(() => {
      const found = container.querySelector<HTMLButtonElement>('button[data-checkout]');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(button.textContent).toBe('Kaufen');
    expect(container.querySelector('[data-component-kind="checkout-button"]')?.hasAttribute('label')).toBe(false);
  });

  it('speaks English on an English site', async () => {
    const { container } = await publish(page(control), 'en');
    await waitFor(() => expect(container.querySelector('button[data-checkout]')?.textContent).toBe('Checkout'));
  });
});

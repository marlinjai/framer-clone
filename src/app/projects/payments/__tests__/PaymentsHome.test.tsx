// src/app/projects/payments/__tests__/PaymentsHome.test.tsx
//
// The payments page against a scripted /api/payments/stripe (fetch stubbed): the status read from the
// server, both ways to connect for a company not connected, onboarding sends the owner to Stripe, a ready
// account offers nothing to do, test mode is said as such, refusals and returns from Stripe are shown as text.

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import PaymentsHome from '../PaymentsHome';

/** The receipt email card's status when a test does not script it: not available on this platform. */
/** No paid order without an invoice, when a test does not script it. */
const NONE_UNISSUED = { status: 200, body: { count: 0, orders: [] } };

const MAIL_OFF = { status: 200, body: { configured: false, connection: null, workspaces: [], otherCompanies: 0 } };

function respond(routes: Record<string, { status: number; body: unknown }>) {
  const all: Record<string, { status: number; body: unknown }> = {
    'GET /api/payments/mail': MAIL_OFF,
    'GET /api/payments/receipts': NONE_UNISSUED,
    ...routes,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const route = all[`${init?.method ?? 'GET'} ${url}`];
      if (!route) throw new Error(`unexpected ${url}`);
      return new Response(JSON.stringify(route.body), { status: route.status });
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('PaymentsHome', () => {
  it('a company not connected sees both ways in and the 1% fee', async () => {
    respond({ 'GET /api/payments/stripe/account': { status: 200, body: { status: 'not_connected' } } });
    render(<PaymentsHome returned={null} />);
    expect(await screen.findByText(/takes demo payments only/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Set up a new Stripe account' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'I already have a Stripe account' })).toBeTruthy();
    expect(screen.getByText(/takes 1% of each payment/)).toBeTruthy();
  });

  it('setting up sends the owner to Stripe', async () => {
    respond({
      'GET /api/payments/stripe/account': { status: 200, body: { status: 'not_connected' } },
      'POST /api/payments/stripe/onboarding': { status: 200, body: { url: 'https://connect.stripe.test/setup' } },
    });
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    render(<PaymentsHome returned={null} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Set up a new Stripe account' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://connect.stripe.test/setup'));
  });

  it('a ready account offers nothing to do; a return from Stripe is explained', async () => {
    respond({ 'GET /api/payments/stripe/account': { status: 200, body: { status: 'ready' } } });
    render(<PaymentsHome returned="invalid_state" />);
    expect(await screen.findByText(/takes real payments into your own Stripe account/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Stripe/ })).toBeNull();
    expect(screen.getByRole('status').textContent).toMatch(/not for this company or has expired/);
  });

  it('in test mode, neither a ready nor an unconnected account is promised real payments', async () => {
    respond({ 'GET /api/payments/stripe/account': { status: 200, body: { status: 'ready', testMode: true } } });
    render(<PaymentsHome returned={null} />);
    expect(await screen.findByText(/Ready \(test mode\)/)).toBeTruthy();
    expect(screen.getByText(/Stripe's test cards and no real money moves/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/takes real payments/);
    cleanup();

    respond({ 'GET /api/payments/stripe/account': { status: 200, body: { status: 'not_connected', testMode: true } } });
    render(<PaymentsHome returned={null} />);
    expect(await screen.findByText(/takes test payments only/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/to take real payments/);
  });

  it('a ready account whose Books cannot issue receipts yet says payments are paused, why, and where to go', async () => {
    respond({
      'GET /api/payments/stripe/account': {
        status: 200,
        body: { status: 'ready', books: { ready: false, blocker: 'sender_incomplete', missing: ['postalCode', 'taxNumber|vatId'] } },
      },
    });
    render(<PaymentsHome returned={null} />);
    expect(await screen.findByText(/Connected, payments paused/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/takes real payments/);
    const notice = document.querySelector('[data-payments-books-blocked]');
    expect(notice?.textContent).toMatch(/lack the postal code, a tax number or VAT id/);
    expect(notice?.textContent).toMatch(/pnpm books:init-company/);
    expect(screen.getByRole('link', { name: 'Open the Books' }).getAttribute('href')).toBe('/projects/books');
  });

  it.each([
    ['books_not_set_up', /Books are not set up yet/],
    ['invoice_numbers_missing', /no invoice number series yet/],
  ])('names %s as the reason', async (blocker, text) => {
    respond({
      'GET /api/payments/stripe/account': { status: 200, body: { status: 'pending', books: { ready: false, blocker, missing: [] } } },
    });
    render(<PaymentsHome returned={null} />);
    await waitFor(() => expect(document.querySelector('[data-payments-books-blocked]')?.textContent).toMatch(text));
    // The next step of the account stays: the Books do not replace finishing the setup with Stripe.
    expect(screen.getByRole('button', { name: 'Continue the setup with Stripe' })).toBeTruthy();
  });

  it('ready Books add nothing to the page', async () => {
    respond({ 'GET /api/payments/stripe/account': { status: 200, body: { status: 'ready', books: { ready: true } } } });
    render(<PaymentsHome returned={null} />);
    expect(await screen.findByText(/takes real payments into your own Stripe account/)).toBeTruthy();
    expect(document.querySelector('[data-payments-books-blocked]')).toBeNull();
  });

  it('a company other than the demo company hears that its shop takes no orders until Stripe is ready', async () => {
    respond({ 'GET /api/payments/stripe/account': { status: 200, body: { status: 'not_connected', demoCheckout: false } } });
    render(<PaymentsHome returned={null} />);
    expect(await screen.findByText(/Connect a Stripe account to start selling/)).toBeTruthy();
    expect(document.body.textContent).toMatch(/takes no orders: buyers are told it cannot take payments yet, and nothing is charged/);
    expect(document.body.textContent).not.toMatch(/demo payments/);
    cleanup();

    respond({ 'GET /api/payments/stripe/account': { status: 200, body: { status: 'pending', demoCheckout: false } } });
    render(<PaymentsHome returned={null} />);
    expect(await screen.findByText(/Stripe still needs details.*takes no orders/)).toBeTruthy();
  });

  it('paid orders without an invoice are listed with the reason and whether the shop still tries', async () => {
    respond({
      'GET /api/payments/stripe/account': { status: 200, body: { status: 'ready' } },
      'GET /api/payments/receipts': {
        status: 200,
        body: {
          count: 2,
          orders: [
            { orderId: 'o1', orderNumber: '1001', paidAt: '2026-11-01T10:00:00.000Z', reason: 'TOTALS_MISMATCH', state: 'stopped' },
            { orderId: 'o2', orderNumber: '1002', paidAt: '2026-11-02T10:00:00.000Z', reason: 'SETTINGS_MISSING', state: 'retrying' },
          ],
        },
      },
    });
    render(<PaymentsHome returned={null} />);
    expect(await screen.findByText('2 paid orders without an invoice')).toBeTruthy();
    const rows = Array.from(document.querySelectorAll('[data-payments-unissued-order]')).map((row) => row.textContent);
    expect(rows[0]).toMatch(/Order 1001.*would not add up.*stopped trying: this needs you/);
    expect(rows[1]).toMatch(/Order 1002.*Books are not set up yet.*keeps trying on its own/);
  });

  it('none: no card; a failure to read them is shown, not an empty card', async () => {
    respond({ 'GET /api/payments/stripe/account': { status: 200, body: { status: 'ready' } } });
    render(<PaymentsHome returned={null} />);
    expect(await screen.findByText(/takes real payments/)).toBeTruthy();
    expect(document.querySelector('[data-payments-unissued]')).toBeNull();
    cleanup();

    respond({
      'GET /api/payments/stripe/account': { status: 200, body: { status: 'ready' } },
      'GET /api/payments/receipts': { status: 500, body: { error: { message: 'the database is down' } } },
    });
    render(<PaymentsHome returned={null} />);
    await waitFor(() => expect(document.querySelector('[data-payments-unissued-error]')?.textContent).toBe('the database is down'));
  });

  it('a refusal of the server is shown, never a blank page', async () => {
    respond({
      'GET /api/payments/stripe/account': {
        status: 503,
        body: { error: { code: 'stripe_not_configured', message: 'payments through Stripe are not set up on this platform yet' } },
      },
    });
    render(<PaymentsHome returned={null} />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/not set up on this platform yet/);
  });
});

// src/app/projects/payments/__tests__/PaymentsHome.test.tsx
//
// The payments page against a scripted /api/payments/stripe (fetch stubbed): the status read from the
// server, both ways to connect for a company not connected, onboarding sends the owner to Stripe, a ready
// account offers nothing to do, refusals and returns from Stripe are shown as text.

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import PaymentsHome from '../PaymentsHome';

function respond(routes: Record<string, { status: number; body: unknown }>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const route = routes[`${init?.method ?? 'GET'} ${url}`];
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

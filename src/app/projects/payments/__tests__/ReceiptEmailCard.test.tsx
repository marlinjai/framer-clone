// src/app/projects/payments/__tests__/ReceiptEmailCard.test.tsx
//
// The "Receipt email" card against a scripted /api/payments/mail (fetch stubbed): not available on the platform,
// no workspace of this company (with the next step), choosing a workspace and a sender then connecting (one
// attempt id per chooser), connected with letters that failed, disconnecting, and refusals shown as text.

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import ReceiptEmailCard from '../ReceiptEmailCard';

type Route = { status: number; body: unknown };
const calls: { method: string; url: string; body: unknown }[] = [];

function respond(routes: Record<string, Route | Route[]>) {
  calls.length = 0;
  const queues = Object.fromEntries(Object.entries(routes).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const queue = queues[`${method} ${url}`];
      if (!queue) throw new Error(`unexpected ${method} ${url}`);
      const route = queue.length > 1 ? queue.shift()! : queue[0];
      return new Response(JSON.stringify(route.body), { status: route.status });
    }),
  );
}

const WS = '11111111-1111-4111-8111-111111111111';
const SENDER = '22222222-2222-4222-8222-222222222222';
const CONNECTION = {
  workspaceId: WS,
  workspaceName: 'Schmuck',
  sender: 'Schmuck Testshop <shop@testshop.example>',
  connectedAt: '2026-10-27T01:00:00.000Z',
  failed: { count: 0, latestReason: null },
};
const NOT_CONNECTED = { configured: true, connection: null, workspaces: [{ id: WS, name: 'Schmuck', role: 'owner' }], otherCompanies: 0 };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ReceiptEmailCard', () => {
  it('says so when the platform has no Lumitra Mail, and offers nothing', async () => {
    respond({ 'GET /api/payments/mail': { status: 200, body: { configured: false, connection: null, workspaces: [], otherCompanies: 0 } } });
    render(<ReceiptEmailCard />);
    expect(await screen.findByText(/not set up on this platform yet/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
  });

  it('without a workspace of this company, says how to make one, and that the others belong elsewhere', async () => {
    respond({ 'GET /api/payments/mail': { status: 200, body: { configured: true, connection: null, workspaces: [], otherCompanies: 2 } } });
    render(<ReceiptEmailCard />);
    expect(await screen.findByText(/no Lumitra Mail workspace you can use yet/)).toBeTruthy();
    expect(screen.getByText(/2 workspaces belong/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Lumitra Mail/ }).getAttribute('href')).toBe('https://app.mail.lumitra.co');
  });

  it('chooses a workspace and its only sender, retries a failed connect as a new attempt, and shows the connection', async () => {
    respond({
      'GET /api/payments/mail': [
        { status: 200, body: NOT_CONNECTED },
        { status: 200, body: { ...NOT_CONNECTED, connection: CONNECTION } },
      ],
      [`GET /api/payments/mail/senders?workspace=${WS}`]: { status: 200, body: { senders: [{ id: SENDER, label: CONNECTION.sender }] } },
      'POST /api/payments/mail': [
        { status: 503, body: { error: { code: 'mail_unavailable', message: 'Lumitra Mail cannot be reached right now: try again in a minute.' } } },
        { status: 200, body: { connection: CONNECTION } },
      ],
    });
    render(<ReceiptEmailCard />);
    fireEvent.change(await screen.findByRole('combobox', { name: 'Lumitra Mail workspace' }), { target: { value: WS } });
    await waitFor(() => expect((screen.getByRole('combobox', { name: 'Send from' }) as HTMLSelectElement).value).toBe(SENDER));

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/cannot be reached right now/);
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText(/from Schmuck Testshop <shop@testshop.example>/)).toBeTruthy();

    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[0].body).toMatchObject({ workspaceId: WS, providerId: SENDER });
    // A failed connect revoked its key: the retry is a new attempt, never a replay of that key.
    expect((posts[0].body as { attempt: string }).attempt).not.toBe((posts[1].body as { attempt: string }).attempt);
  });

  it('a workspace without a sending account says to add one', async () => {
    respond({
      'GET /api/payments/mail': { status: 200, body: NOT_CONNECTED },
      [`GET /api/payments/mail/senders?workspace=${WS}`]: { status: 200, body: { senders: [] } },
    });
    render(<ReceiptEmailCard />);
    fireEvent.change(await screen.findByRole('combobox', { name: 'Lumitra Mail workspace' }), { target: { value: WS } });
    expect(await screen.findByText(/no sending account yet/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('connected: names the sender, says what failed, and disconnects', async () => {
    respond({
      'GET /api/payments/mail': [
        { status: 200, body: { ...NOT_CONNECTED, connection: { ...CONNECTION, failed: { count: 2, latestReason: 'no template' } } } },
        { status: 200, body: NOT_CONNECTED },
      ],
      'DELETE /api/payments/mail': { status: 200, body: { connection: null } },
    });
    render(<ReceiptEmailCard />);
    expect(await screen.findByText(/2 letters of the last 30 days could not be sent: no template/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByRole('combobox', { name: 'Lumitra Mail workspace' })).toBeTruthy();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
    expect(screen.queryByText(/key in Lumitra Mail is still there/)).toBeNull();
  });

  it('after a disconnect whose key the person could not revoke, says who has to revoke it', async () => {
    respond({
      'GET /api/payments/mail': [
        { status: 200, body: { ...NOT_CONNECTED, connection: CONNECTION } },
        { status: 200, body: NOT_CONNECTED },
      ],
      'DELETE /api/payments/mail': { status: 200, body: { connection: null, keyRevoked: false } },
    });
    render(<ReceiptEmailCard />);
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByText(/key in Lumitra Mail is still there/)).toBeTruthy();
  });
});

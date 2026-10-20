// DomainsPanel: the editor's custom-domain flow, against a fake server that
// keeps real state (domains, tokens, statuses), so the four stateful-flow
// paths (knowledge-base/standards/stateful-flow-testing.md) are exercised end
// to end in the UI:
//   forward:   add -> records shown -> verify -> verified -> check -> active
//   revise:    disconnect a typo, add the corrected domain: the old records and
//              token are gone; re-adding the same domain shows the same token
//   resume:    a fresh mount (reload) shows what the server holds
//   re-entry:  after a failure the reason shows and a recheck clears it; after
//              disconnect, re-adding starts clean with a new token
// Plus: errors surface (add refusal, load failure with retry, network error),
// and the "not configured" state reads as such.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import DomainsPanel, { type DomainView } from '../DomainsPanel';

type Server = {
  configured: boolean;
  domains: DomainView[];
  nextVerify: Array<Partial<DomainView>>;
  tokenSeq: number;
  failList: boolean;
};
let server: Server;

function view(hostname: string, token: string): DomainView {
  return {
    id: `dom_${hostname}`,
    hostname,
    displayHostname: hostname,
    status: 'pending',
    serving: false,
    lastErrorCode: null,
    lastError: null,
    lastCheckedAt: null,
    verifiedAt: null,
    activatedAt: null,
    records: [
      { type: 'TXT', name: `_lumitra-verify.${hostname}`, value: `lumitra-verify=${token}`, purpose: 'ownership', recommended: true },
      { type: 'CNAME', name: hostname, value: 'domains.lumitra.co', purpose: 'routing', recommended: true },
    ],
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  const method = init?.method ?? 'GET';
  const base = '/api/projects/site_1/domains';
  if (url === base && method === 'GET') {
    if (server.failList) return json({ error: { code: 'authz_unavailable', message: 'Permissions are unavailable.' } }, 503);
    return json({ configured: server.configured, domains: server.domains });
  }
  if (url === base && method === 'POST') {
    const { hostname } = JSON.parse(String(init?.body)) as { hostname: string };
    if (hostname.endsWith('.lumitra.co')) {
      return json({ error: { code: 'reserved_hostname', message: 'This domain belongs to the platform.' } }, 400);
    }
    const existing = server.domains.find((d) => d.hostname === hostname);
    if (existing) return json({ domain: existing });
    server.tokenSeq += 1;
    const d = view(hostname, `token${server.tokenSeq}`);
    server.domains.push(d);
    return json({ domain: d }, 201);
  }
  const verifyMatch = url.match(/\/domains\/([^/]+)\/verify$/);
  if (verifyMatch && method === 'POST') {
    const d = server.domains.find((x) => x.id === decodeURIComponent(verifyMatch[1]));
    if (!d) return json({ error: { code: 'domain_not_found', message: 'gone' } }, 404);
    Object.assign(d, server.nextVerify.shift() ?? {});
    return json({ domain: d });
  }
  const delMatch = url.match(/\/domains\/([^/]+)$/);
  if (delMatch && method === 'DELETE') {
    server.domains = server.domains.filter((x) => x.id !== decodeURIComponent(delMatch[1]));
    return json({ removed: true });
  }
  return json({ error: { code: 'not_found', message: 'not found' } }, 404);
});

beforeEach(() => {
  server = { configured: true, domains: [], nextVerify: [], tokenSeq: 0, failList: false };
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function mount() {
  const utils = render(<DomainsPanel projectId="site_1" />);
  await screen.findByLabelText('Connect a domain you own');
  return utils;
}

async function addDomain(hostname: string) {
  fireEvent.change(screen.getByLabelText('Connect a domain you own'), { target: { value: hostname } });
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  await waitFor(() => expect(card(hostname)).toBeTruthy());
}

function card(hostname: string): HTMLElement {
  const el = document.querySelector(`[data-testid="domain-card"][data-hostname="${hostname}"]`);
  if (!el) throw new Error(`no card for ${hostname}`);
  return el as HTMLElement;
}

describe('forward', () => {
  it('add shows the exact records; verify walks to verified, then active', async () => {
    await mount();
    await addDomain('www.example.com');
    const c = card('www.example.com');
    expect(within(c).getByTestId('domain-status').textContent).toContain('Waiting for DNS');
    expect(within(c).getByText('_lumitra-verify.www.example.com')).toBeTruthy();
    expect(within(c).getByText('lumitra-verify=token1')).toBeTruthy();
    expect(within(c).getByText('domains.lumitra.co')).toBeTruthy();
    expect((screen.getByLabelText('Connect a domain you own') as HTMLInputElement).value).toBe('');

    server.nextVerify.push({
      status: 'verified',
      serving: true,
      lastErrorCode: 'certificate_pending',
      lastError: 'DNS is verified. The certificate is being issued.',
    });
    fireEvent.click(within(c).getByRole('button', { name: 'Verify' }));
    await waitFor(() =>
      expect(within(card('www.example.com')).getByTestId('domain-status').textContent).toContain('certificate pending'),
    );
    expect(within(card('www.example.com')).queryByTestId('dns-records')).toBeNull();
    expect(within(card('www.example.com')).getByRole('link', { name: 'www.example.com' })).toBeTruthy();

    server.nextVerify.push({ status: 'active', lastErrorCode: null, lastError: null });
    fireEvent.click(within(card('www.example.com')).getByRole('button', { name: 'Check again' }));
    await waitFor(() =>
      expect(within(card('www.example.com')).getByTestId('domain-status').textContent).toBe('Active'),
    );
  });
});

describe('backtrack and revise', () => {
  it('disconnecting a typo and adding the corrected domain drops the old records and token', async () => {
    await mount();
    await addDomain('www.exmple.com');
    const typo = card('www.exmple.com');
    fireEvent.click(within(typo).getByRole('button', { name: 'Disconnect' }));
    fireEvent.click(within(typo).getByRole('button', { name: 'Yes, disconnect' }));
    await waitFor(() => expect(document.querySelector('[data-hostname="www.exmple.com"]')).toBeNull());

    await addDomain('www.example.com');
    expect(screen.queryByText('lumitra-verify=token1')).toBeNull();
    expect(screen.getByText('lumitra-verify=token2')).toBeTruthy();
    expect(screen.getAllByTestId('domain-card')).toHaveLength(1);
  });

  it('re-adding the same domain keeps its claim and token (no duplicate)', async () => {
    await mount();
    await addDomain('www.example.com');
    await addDomain('www.example.com');
    expect(screen.getAllByTestId('domain-card')).toHaveLength(1);
    expect(screen.getByText('lumitra-verify=token1')).toBeTruthy();
  });

  it('cancelling a disconnect keeps the domain', async () => {
    await mount();
    await addDomain('www.example.com');
    const c = card('www.example.com');
    fireEvent.click(within(c).getByRole('button', { name: 'Disconnect' }));
    fireEvent.click(within(c).getByRole('button', { name: 'Cancel' }));
    expect(card('www.example.com')).toBeTruthy();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
  });
});

describe('resume', () => {
  it('a fresh mount shows the server state: pending records, an active domain', async () => {
    server.domains.push(view('pending.example.com', 'tokenP'));
    server.domains.push({ ...view('live.example.com', 'tokenL'), status: 'active', serving: true });
    await mount();
    expect(within(card('pending.example.com')).getByText('lumitra-verify=tokenP')).toBeTruthy();
    expect(within(card('live.example.com')).getByTestId('domain-status').textContent).toBe('Active');
    expect(within(card('live.example.com')).queryByTestId('dns-records')).toBeNull();
  });

  it('a remount after a reload loads again instead of keeping a stale list', async () => {
    const first = await mount();
    await addDomain('www.example.com');
    first.unmount();
    server.domains = [];
    await mount();
    expect(document.querySelector('[data-testid="domain-card"]')).toBeNull();
  });
});

describe('re-entry after failure or completion', () => {
  it('a failed check shows its reason, and a successful recheck clears it', async () => {
    await mount();
    await addDomain('www.example.com');
    server.nextVerify.push({ status: 'failed', lastErrorCode: 'txt_missing', lastError: 'No TXT record found.' });
    fireEvent.click(within(card('www.example.com')).getByRole('button', { name: 'Verify' }));
    await screen.findByText('No TXT record found.');
    expect(within(card('www.example.com')).getByTestId('dns-records')).toBeTruthy();

    server.nextVerify.push({ status: 'active', serving: true, lastErrorCode: null, lastError: null });
    fireEvent.click(within(card('www.example.com')).getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(screen.queryByText('No TXT record found.')).toBeNull());
  });

  it('disconnect then re-add starts clean: new token, pending, no old error', async () => {
    await mount();
    await addDomain('www.example.com');
    server.nextVerify.push({ status: 'failed', lastError: 'Old failure.' });
    fireEvent.click(within(card('www.example.com')).getByRole('button', { name: 'Verify' }));
    await screen.findByText('Old failure.');
    fireEvent.click(within(card('www.example.com')).getByRole('button', { name: 'Disconnect' }));
    fireEvent.click(within(card('www.example.com')).getByRole('button', { name: 'Yes, disconnect' }));
    await waitFor(() => expect(document.querySelector('[data-testid="domain-card"]')).toBeNull());

    await addDomain('www.example.com');
    expect(screen.queryByText('Old failure.')).toBeNull();
    expect(screen.getByText('lumitra-verify=token2')).toBeTruthy();
    expect(within(card('www.example.com')).getByTestId('domain-status').textContent).toContain('Waiting');
  });
});

describe('errors surface', () => {
  it('an add refusal shows the server message under the field and clears on typing', async () => {
    await mount();
    fireEvent.change(screen.getByLabelText('Connect a domain you own'), { target: { value: 'x.lumitra.co' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await screen.findByText('This domain belongs to the platform.');
    fireEvent.change(screen.getByLabelText('Connect a domain you own'), { target: { value: 'x.example.com' } });
    expect(screen.queryByText('This domain belongs to the platform.')).toBeNull();
  });

  it('a load failure shows its message and a retry that recovers', async () => {
    server.failList = true;
    render(<DomainsPanel projectId="site_1" />);
    await screen.findByText('Permissions are unavailable.');
    server.failList = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByLabelText('Connect a domain you own');
  });

  it('a network error on verify shows on that domain, nothing else changes', async () => {
    await mount();
    await addDomain('www.example.com');
    fetchMock.mockImplementationOnce(async () => {
      throw new TypeError('Failed to fetch');
    });
    fireEvent.click(within(card('www.example.com')).getByRole('button', { name: 'Verify' }));
    await screen.findByText('Network error while checking the domain.');
    expect(within(card('www.example.com')).getByTestId('domain-status').textContent).toContain('Waiting');
  });

  it('not configured: says so and disables adding, existing domains still listed', async () => {
    server.configured = false;
    server.domains.push({ ...view('live.example.com', 't'), status: 'active', serving: true, records: [] });
    await mount();
    expect(screen.getByText(/not set up on this server yet/)).toBeTruthy();
    expect((screen.getByLabelText('Connect a domain you own') as HTMLInputElement).disabled).toBe(true);
    expect(card('live.example.com')).toBeTruthy();
  });
});

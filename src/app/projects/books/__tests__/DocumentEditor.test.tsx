// src/app/projects/books/__tests__/DocumentEditor.test.tsx
//
// The document editor against a scripted /api/books server (fetch stubbed),
// the four stateful-flow paths at the interface:
//   1. forward: add a line (sent in thousandths and cents, with the version on
//      screen), the server's totals are shown, issue asks for confirmation with
//      the total and the next number and sends the confirmed version;
//   2. backtrack and revise: picking an EU business shows the server's
//      reverse-charge lines at once; picking the consumer again shows 19 %;
//   3. resume: everything shown comes from the GET; a stale draft says so;
//   4. re-entry: "New invoice" creates a fresh draft on the server and opens it;
//      a change refused as stale (409) reloads and explains, never overwrites.
// All data is synthetic.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

import BooksHome from '../BooksHome';
import DocumentEditor, { lineBody } from '../DocumentEditor';

type Json = Record<string, unknown>;

function line(over: Json = {}): Json {
  return {
    id: 'l1',
    position: 1,
    kind: 'service',
    title: 'Consulting',
    description: null,
    quantity: 1500,
    unitLabel: 'Std',
    unitPrice: 8000,
    discountBp: 0,
    subtotal: 12000,
    taxClass: 'standard',
    taxRateOverride: null,
    taxRate: 1900,
    taxAmount: 2280,
    taxTreatment: 'standard',
    updatedAt: '2026-10-19T08:00:00.000Z',
    ...over,
  };
}

function detail(over: { document?: Json; lines?: Json[]; stale?: boolean; customer?: Json | null } = {}): Json {
  return {
    document: {
      id: 'doc-1',
      docType: 'invoice',
      status: 'draft',
      source: 'editor',
      version: 3,
      customerId: 'cust-de',
      templateId: null,
      correctsDocumentId: null,
      documentNumber: null,
      issueDate: null,
      serviceDate: '2026-10-01',
      servicePeriodStart: null,
      servicePeriodEnd: null,
      dueDate: null,
      paymentTermsDays: 14,
      netOrGross: 'net',
      kleinunternehmer: false,
      reverseCharge: false,
      taxNote: null,
      taxProfileKey: 'regular|b2c||DE',
      subtotal: 12000,
      taxAmount: 2280,
      total: 14280,
      taxSummary: [{ taxRate: 1900, taxTreatment: 'standard', net: 12000, tax: 2280 }],
      introText: null,
      outroText: null,
      renderedPdfFileId: null,
      customerSnapshot: null,
      ...over.document,
    },
    lines: over.lines ?? [line()],
    events: [],
    stale: over.stale ?? false,
    customer: over.customer ?? null,
  };
}

const CUSTOMERS = {
  items: [
    { id: 'cust-de', contactId: 'c1', customerType: 'b2c', vatId: null, countryCode: 'DE', taxNumber: null, archivedAt: null, contact: { name: 'Alex Example' }, contactStatus: 'ok', drift: [] },
    { id: 'cust-fr', contactId: 'c2', customerType: 'b2b', vatId: 'FR12345678901', countryCode: 'FR', taxNumber: null, archivedAt: null, contact: { name: 'Société Exemple' }, contactStatus: 'ok', drift: [] },
  ],
};
const SETTINGS = {
  initialised: true,
  settings: { taxStatus: 'regular', exemptionNote: 'x', senderBlock: { legalName: 'Example Studio' }, defaultPaymentTermsDays: 14 },
  counters: [{ docType: 'invoice', format: '{n}', nextValue: 62, nextNumber: '62' }],
};

type Handler = (body: Json | null, url: string) => { status: number; body: unknown };
let routes: Record<string, Handler>;
let calls: Array<{ method: string; url: string; body: Json | null }>;

function server(r: Record<string, Handler>) {
  routes = r;
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Json) : null;
      calls.push({ method, url, body });
      const path = url.split('?')[0];
      const handler = routes[`${method} ${path}`];
      if (!handler) return new Response(JSON.stringify({ error: { code: 'not_found', message: 'nf' } }), { status: 404 });
      const res = handler(body, url);
      return new Response(res.status === 204 ? null : JSON.stringify(res.body), { status: res.status });
    }),
  );
}

const base = (doc: () => Json): Record<string, Handler> => ({
  'GET /api/books/documents/doc-1': () => ({ status: 200, body: doc() }),
  'GET /api/books/customers': () => ({ status: 200, body: CUSTOMERS }),
  'GET /api/books/settings': () => ({ status: 200, body: SETTINGS }),
});

beforeEach(() => push.mockReset());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('line form conversion', () => {
  it('sends quantities in thousandths and prices in cents, and names a bad field', () => {
    expect(lineBody({ kind: 'service', title: 'A', quantity: '1,5', unitLabel: 'Std', unitPrice: '80,00', taxClass: 'reduced' })).toEqual({
      ok: true,
      body: { kind: 'service', title: 'A', quantity: 1500, unitLabel: 'Std', unitPrice: 8000, taxClass: 'reduced' },
    });
    expect(lineBody({ kind: 'service', title: 'A', quantity: '0', unitLabel: '', unitPrice: '1', taxClass: 'standard' })).toMatchObject({ ok: false });
    expect(lineBody({ kind: 'text', title: 'Note', quantity: '', unitLabel: '', unitPrice: '', taxClass: 'standard' })).toEqual({
      ok: true,
      body: { kind: 'text', title: 'Note' },
    });
  });
});

describe('DocumentEditor', () => {
  it('forward: adds a line with the version, shows the server totals, issues after confirmation', async () => {
    let current = detail({ lines: [], document: { subtotal: 0, taxAmount: 0, total: 0, taxSummary: [] } });
    server({
      ...base(() => current),
      'POST /api/books/documents/doc-1/lines': () => {
        current = detail({ document: { version: 4 } });
        return { status: 201, body: current };
      },
      'POST /api/books/documents/doc-1/issue': () => ({
        status: 200,
        body: {
          alreadyIssued: false,
          render: { stored: true },
          document: detail({ document: { status: 'issued', documentNumber: '62', issueDate: '2026-10-19', version: 5 } }),
        },
      }),
    });
    render(<DocumentEditor id="doc-1" />);
    await screen.findByText(/next: 62/);

    const form = screen.getByRole('form', { name: 'Add line' });
    fireEvent.change(within(form).getByLabelText('Description'), { target: { value: 'Consulting' } });
    fireEvent.change(within(form).getByLabelText('Quantity'), { target: { value: '1,5' } });
    fireEvent.change(within(form).getByLabelText('Unit price (EUR)'), { target: { value: '80,00' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add line' }));
    await waitFor(() => expect(screen.getByTestId('total').textContent).toBe('142,80 €'));
    const add = calls.find((c) => c.method === 'POST' && c.url.endsWith('/lines'))!;
    expect(add.body).toMatchObject({ quantity: 1500, unitPrice: 8000, expectedVersion: 3 });

    fireEvent.click(screen.getByRole('button', { name: 'Issue…' }));
    const dialog = screen.getByRole('dialog', { name: 'Confirm issue' });
    expect(dialog.textContent).toContain('142,80 €');
    expect(dialog.textContent).toContain('as number 62');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Issue invoice' }));
    await screen.findByText(/Issued as 62/);
    expect(calls.find((c) => c.url.endsWith('/issue'))!.body).toEqual({ expectedVersion: 4 });
    expect(screen.getByRole('link', { name: 'Download PDF' }).getAttribute('href')).toBe('/api/books/documents/doc-1/pdf');
    expect(screen.queryByRole('form', { name: 'Add line' })).toBeNull();
  });

  it('backtrack and revise: an EU business shows reverse charge at once, the consumer again 19 %', async () => {
    let current = detail();
    server({
      ...base(() => current),
      'PUT /api/books/documents/doc-1/customer': (body) => {
        current =
          body!.customerId === 'cust-fr'
            ? detail({
                document: { customerId: 'cust-fr', version: 4, reverseCharge: true, taxAmount: 0, total: 12000, taxNote: 'Steuerschuldnerschaft des Leistungsempfängers', taxSummary: [{ taxRate: 0, taxTreatment: 'reverse_charge', net: 12000, tax: 0 }] },
                lines: [line({ taxRate: 0, taxAmount: 0, taxTreatment: 'reverse_charge' })],
              })
            : detail({ document: { version: 5 } });
        return { status: 200, body: current };
      },
    });
    render(<DocumentEditor id="doc-1" />);
    expect((await screen.findByTestId('line-tax')).textContent).toBe('19 %');
    fireEvent.change(screen.getByLabelText('Customer'), { target: { value: 'cust-fr' } });
    await waitFor(() => expect(screen.getByTestId('line-tax').textContent).toBe('reverse charge'));
    expect(screen.getByTestId('total').textContent).toBe('120,00 €');
    expect(screen.getByText(/Steuerschuldnerschaft/)).toBeTruthy();
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ customerId: 'cust-fr', expectedVersion: 3 });

    fireEvent.change(screen.getByLabelText('Customer'), { target: { value: 'cust-de' } });
    await waitFor(() => expect(screen.getByTestId('line-tax').textContent).toBe('19 %'));
    expect(screen.getByTestId('total').textContent).toBe('142,80 €');
  });

  it('resume: shows exactly the server state, and says when a draft was recalculated', async () => {
    server(base(() => detail({ stale: true })));
    render(<DocumentEditor id="doc-1" />);
    await screen.findByText(/tax details changed since this draft was last saved/);
    expect(screen.getByTestId('total').textContent).toBe('142,80 €');
    expect(screen.getAllByTestId('line')).toHaveLength(1);
  });

  it('a change refused as stale reloads the document and explains', async () => {
    let current = detail();
    server({
      ...base(() => current),
      'POST /api/books/documents/doc-1/lines': () => {
        current = detail({ document: { version: 9 }, lines: [line(), line({ id: 'l2', position: 2, title: 'Added elsewhere' })] });
        return { status: 409, body: { error: { code: 'concurrent_edit', message: 'x' } } };
      },
    });
    render(<DocumentEditor id="doc-1" />);
    await screen.findByText('Consulting');
    const form = screen.getByRole('form', { name: 'Add line' });
    fireEvent.change(within(form).getByLabelText('Description'), { target: { value: 'Mine' } });
    fireEvent.change(within(form).getByLabelText('Unit price (EUR)'), { target: { value: '10' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add line' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/changed in another window/);
    await screen.findByText('Added elsewhere');
  });

  it('a refused issue keeps the draft and names what to fix', async () => {
    server({
      ...base(() => detail({ document: { customerId: null } })),
      'POST /api/books/documents/doc-1/issue': () => ({
        status: 422,
        body: { error: { code: 'customer_required', message: 'x' } },
      }),
    });
    render(<DocumentEditor id="doc-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Issue…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Issue invoice' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Pick a customer/);
    expect(screen.getByRole('form', { name: 'Add line' })).toBeTruthy();
  });
});

describe('DocumentEditor: an imported invoice', () => {
  it('is marked, offers its original for download and nothing to edit or issue', async () => {
    const imported = detail({
      document: {
        status: 'issued',
        source: 'import',
        currencyCode: 'CHF',
        documentNumber: '12',
        issueDate: '2021-03-04',
        kleinunternehmer: true,
        taxAmount: 0,
        total: 12000,
        customerSnapshot: { name: 'Example Client GmbH', addressLine1: 'Beispielweg 2', postalCode: '20095', city: 'Hamburg', country: 'DE' },
      },
    });
    server(base(() => imported));
    render(<DocumentEditor id="doc-1" />);
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toContain('Imported');
    expect(screen.getByText(/imported, the original PDF is the document of record/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Download original PDF' }).getAttribute('href')).toBe('/api/books/documents/doc-1/pdf');
    expect(screen.queryByRole('button', { name: 'Issue…' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Add line' })).toBeNull();
    expect(screen.getAllByText(/CHF/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/€/)).toBeNull();
  });
});

describe('BooksHome', () => {
  it('re-entry: "New invoice" creates a fresh draft on the server and opens it', async () => {
    server({
      'GET /api/books/settings': () => ({ status: 200, body: SETTINGS }),
      'GET /api/books/customers': () => ({ status: 200, body: CUSTOMERS }),
      'GET /api/books/documents': () => ({
        status: 200,
        body: { items: [{ id: 'doc-1', docType: 'invoice', status: 'issued', documentNumber: '62', issueDate: '2026-10-19', dueDate: null, total: 14280, customerName: 'Alex Example', contactStatus: 'ok', correctsDocumentId: null, createdAt: '' }] },
      }),
      'POST /api/books/documents': () => ({ status: 201, body: detail({ document: { id: 'doc-2', version: 0 }, lines: [] }) }),
    });
    render(<BooksHome />);
    await screen.findByText('Invoice 62');
    fireEvent.click(screen.getByRole('button', { name: 'New invoice' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/projects/books/documents/doc-2'));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({});
  });

  it('marks imported invoices in the list', async () => {
    server({
      'GET /api/books/settings': () => ({ status: 200, body: SETTINGS }),
      'GET /api/books/customers': () => ({ status: 200, body: CUSTOMERS }),
      'GET /api/books/documents': () => ({
        status: 200,
        body: {
          items: [
            { id: 'doc-1', docType: 'invoice', status: 'issued', source: 'import', currencyCode: 'CHF', documentNumber: '12', issueDate: '2021-03-04', dueDate: null, total: 12000, customerName: 'Example Client GmbH', contactStatus: 'ok', correctsDocumentId: null, createdAt: '' },
            { id: 'doc-2', docType: 'invoice', status: 'issued', source: 'editor', currencyCode: 'EUR', documentNumber: '62', issueDate: '2026-10-19', dueDate: null, total: 14280, customerName: 'Alex Example', contactStatus: 'ok', correctsDocumentId: null, createdAt: '' },
          ],
        },
      }),
    });
    render(<BooksHome />);
    const imported = (await screen.findByText('Invoice 12')).closest('a')!;
    expect(within(imported).getByText('Imported')).toBeTruthy();
    expect(imported.textContent).toContain('Example Client GmbH');
    // Each document in its own currency, never converted.
    expect(imported.textContent).toContain('120,00 CHF');
    expect(screen.getByText('Invoice 62').closest('a')!.textContent).toContain('142,80 €');
    expect(within(screen.getByText('Invoice 62').closest('a')!).queryByText('Imported')).toBeNull();
  });

  it('a company without the Books grant gets a page that says so', async () => {
    server({
      'GET /api/books/settings': () => ({ status: 403, body: { error: { code: 'books_not_enabled', message: 'x' } } }),
      'GET /api/books/customers': () => ({ status: 403, body: { error: { code: 'books_not_enabled', message: 'x' } } }),
      'GET /api/books/documents': () => ({ status: 403, body: { error: { code: 'books_not_enabled', message: 'x' } } }),
    });
    render(<BooksHome />);
    await screen.findByText('The Books are not enabled for this company.');
    expect(screen.queryByRole('button', { name: 'New invoice' })).toBeNull();
  });
});

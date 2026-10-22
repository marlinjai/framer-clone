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

function detail(
  over: { document?: Json; lines?: Json[]; stale?: boolean; customer?: Json | null; related?: Json } = {},
): Json {
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
      replacesDocumentId: null,
      printReplacesReference: false,
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
    related: { corrects: null, correctedBy: null, replaces: null, replacedBy: null, ...over.related },
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

describe('DocumentEditor: the Correct flow', () => {
  const ISSUED = {
    status: 'issued',
    documentNumber: '62',
    issueDate: '2026-10-14',
    version: 5,
    customerSnapshot: { name: 'Alex Example', addressLine1: 'Beispielweg 2', postalCode: '20095', city: 'Hamburg', country: 'DE' },
  };
  const REF_62 = { id: 'doc-62', docType: 'invoice', status: 'issued', documentNumber: '62', issueDate: '2026-10-14' };

  it('forward: Correct on an issued invoice creates the replacement draft and opens it', async () => {
    server({
      ...base(() => detail({ document: ISSUED })),
      'POST /api/books/documents/doc-1/correct': () => ({
        status: 201,
        body: { existing: false, document: detail({ document: { id: 'doc-2', replacesDocumentId: 'doc-1' } }) },
      }),
    });
    render(<DocumentEditor id="doc-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Correct' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/projects/books/documents/doc-2'));
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ url: '/api/books/documents/doc-1/correct', body: {} });
    // Nothing is cancelled by the click: the plain cancellation stays offered next to it.
    expect(screen.getByRole('button', { name: 'Cancel with a credit note…' })).toBeTruthy();
  });

  it('a refused Correct stays on the invoice and says why', async () => {
    server({
      ...base(() => detail({ document: ISSUED })),
      'POST /api/books/documents/doc-1/correct': () => ({
        status: 422,
        body: { error: { code: 'customer_archived', message: 'the customer is archived' } },
      }),
    });
    render(<DocumentEditor id="doc-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Correct' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/archived/);
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Correct' })).toBeTruthy();
  });

  it('an invoice with an open replacement links to it instead of offering a second one', async () => {
    server(
      base(() =>
        detail({
          document: ISSUED,
          related: { replacedBy: { id: 'doc-2', docType: 'invoice', status: 'draft', documentNumber: null, issueDate: null } },
        }),
      ),
    );
    render(<DocumentEditor id="doc-1" />);
    const link = await screen.findByRole('link', { name: 'Open the correction draft' });
    expect(link.getAttribute('href')).toBe('/projects/books/documents/doc-2');
    expect(screen.queryByRole('button', { name: 'Correct' })).toBeNull();
    const linked = screen.getByRole('region', { name: 'Linked documents' });
    expect(within(linked).getByText(/Correction draft \(open\)/)).toBeTruthy();
    // Cancelling meanwhile warns that the open draft can no longer replace it.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel with a credit note…' }));
    expect(screen.getByRole('note').textContent).toMatch(/can no longer replace it/);
  });

  it('the replacement draft says what issuing does, and the issue names the cancelled invoice', async () => {
    let issued = false;
    server({
      ...base(() =>
        issued
          ? detail({ document: { status: 'issued', documentNumber: '63', replacesDocumentId: 'doc-62' }, related: { replaces: { ...REF_62, status: 'cancelled' } } })
          : detail({ document: { replacesDocumentId: 'doc-62' }, related: { replaces: REF_62 } }),
      ),
      'POST /api/books/documents/doc-1/issue': () => {
        issued = true;
        return {
          status: 200,
          body: {
            document: detail({ document: { status: 'issued', documentNumber: '63', replacesDocumentId: 'doc-62' }, related: { replaces: { ...REF_62, status: 'cancelled' } } }),
            alreadyIssued: false,
            replaced: { invoiceId: 'doc-62', creditNoteId: 'doc-cn' },
            render: { stored: true },
          },
        };
      },
    });
    render(<DocumentEditor id="doc-1" />);
    const banner = await screen.findByRole('region', { name: 'Correction' });
    expect(banner.textContent).toMatch(/replaces invoice 62/);
    expect(banner.textContent).toMatch(/stays valid/);
    fireEvent.click(screen.getByRole('button', { name: 'Issue…' }));
    expect(screen.getByRole('dialog', { name: 'Confirm issue' }).textContent).toMatch(/Invoice 62 is cancelled with a credit note at the same time/);
    fireEvent.click(screen.getByRole('button', { name: 'Issue invoice' }));
    expect((await screen.findByText(/Issued as 63\./)).textContent).toMatch(/Invoice 62 is cancelled with a credit note/);
  });

  it('a replacement can print the replaced invoice under its title', async () => {
    let doc = detail({ document: { replacesDocumentId: 'doc-62' }, related: { replaces: REF_62 } });
    server({
      ...base(() => doc),
      'PATCH /api/books/documents/doc-1': (body) => {
        doc = detail({ document: { replacesDocumentId: 'doc-62', printReplacesReference: true, version: 4 }, related: { replaces: REF_62 } });
        return { status: 200, body: { ...doc, _sent: body } };
      },
    });
    render(<DocumentEditor id="doc-1" />);
    const box = (await screen.findByRole('checkbox', { name: /Ersetzt Rechnung 62 vom/ })) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    await waitFor(() => expect((screen.getByRole('checkbox', { name: /Ersetzt Rechnung 62 vom/ }) as HTMLInputElement).checked).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ printReplacesReference: true, expectedVersion: 3 });
  });

  it('re-entry after a race: the replaced invoice was cancelled meanwhile, the draft becomes an ordinary invoice', async () => {
    let doc = detail({ document: { replacesDocumentId: 'doc-62' }, related: { replaces: REF_62 } });
    server({
      ...base(() => doc),
      'POST /api/books/documents/doc-1/issue': () => {
        doc = detail({ document: { replacesDocumentId: 'doc-62' }, related: { replaces: { ...REF_62, status: 'cancelled' } } });
        return { status: 409, body: { error: { code: 'replaced_invoice_cancelled', message: 'x' } } };
      },
      'PATCH /api/books/documents/doc-1': (body) => {
        doc = detail({ document: { version: 4 } });
        return { status: 200, body: { ...doc, _sent: body } };
      },
    });
    render(<DocumentEditor id="doc-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Issue…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Issue invoice' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/cancelled in the meantime/);
    fireEvent.click(await screen.findByRole('button', { name: 'Make it an ordinary invoice' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Correction' })).toBeNull());
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ replacesDocumentId: null, expectedVersion: 3 });
  });

  it('an imported invoice offers no Correct, and says how to fix one', async () => {
    server(base(() => detail({ document: { ...ISSUED, source: 'import' } })));
    render(<DocumentEditor id="doc-1" />);
    expect(await screen.findByText(/An imported invoice cannot be corrected here/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Correct' })).toBeNull();
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

  /** A synthetic issued invoice numbered n (the newest first in the list). */
  const doc = (n: number): Json => ({
    id: `doc-${n}`, docType: 'invoice', status: 'issued', source: 'import', currencyCode: 'EUR', documentNumber: String(n),
    issueDate: '2023-03-04', dueDate: null, total: 12000, customerName: 'Example Client GmbH', contactStatus: 'ok', correctsDocumentId: null, createdAt: '',
  });
  /** 61 documents, 50 a page, newest first, as the API pages them. */
  function pagedDocuments(opts: { failSecond?: number } = {}): Handler {
    let failures = opts.failSecond ?? 0;
    return (_body, url) => {
      const cursor = new URL(url, 'http://x').searchParams.get('cursor');
      if (cursor === null) return { status: 200, body: { items: Array.from({ length: 50 }, (_, i) => doc(61 - i)), nextCursor: 'page-2', total: 61 } };
      if (failures > 0) {
        failures -= 1;
        return { status: 503, body: { error: { code: 'books_unavailable', message: 'The Books are temporarily unavailable.' } } };
      }
      return { status: 200, body: { items: Array.from({ length: 11 }, (_, i) => doc(11 - i)), nextCursor: null, total: 61 } };
    };
  }
  const shell = (documents: Handler): Record<string, Handler> => ({
    'GET /api/books/settings': () => ({ status: 200, body: SETTINGS }),
    'GET /api/books/customers': () => ({ status: 200, body: { ...CUSTOMERS, nextCursor: null, total: 2 } }),
    'GET /api/books/documents': documents,
  });

  it('a list longer than one page reaches its last document with "Load more"; the last page hides the button', async () => {
    server(shell(pagedDocuments()));
    render(<BooksHome />);
    await screen.findByText('Invoice 61');
    expect(screen.queryByText('Invoice 1')).toBeNull();
    expect(screen.getByText('Showing 50 of 61 documents')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText('Invoice 1');
    expect(screen.getByText('Showing 61 of 61 documents')).toBeTruthy();
    // Appended, not replaced: the first page is still there, and every invoice once.
    expect(screen.getByText('Invoice 61')).toBeTruthy();
    expect(within(screen.getByRole('list', { name: 'Documents' })).getAllByRole('listitem')).toHaveLength(61);
    // nextCursor null: no button.
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(calls.filter((c) => c.url.startsWith('/api/books/documents')).map((c) => c.url)).toEqual(['/api/books/documents', '/api/books/documents?cursor=page-2']);
  });

  it('a page that fails to load says so and keeps the rows shown; the next "Load more" tries again', async () => {
    server(shell(pagedDocuments({ failSecond: 1 })));
    render(<BooksHome />);
    await screen.findByText('Invoice 61');
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not be loaded: The Books are temporarily unavailable\. Your list is kept/);
    expect(within(screen.getByRole('list', { name: 'Documents' })).getAllByRole('listitem')).toHaveLength(50);
    expect(screen.getByText('Showing 50 of 61 documents')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText('Invoice 1');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('finds documents by number and year on the server, and "Clear" shows them all again', async () => {
    server(
      shell((_body, url) => {
        const q = new URL(url, 'http://x').searchParams;
        if (q.get('number') === '17' && q.get('year') === '2023') return { status: 200, body: { items: [doc(17)], nextCursor: null, total: 1 } };
        if (q.get('number') === '17') return { status: 200, body: { items: [doc(17)], nextCursor: null, total: 1 } };
        return pagedDocuments()(null, url);
      }),
    );
    render(<BooksHome />);
    await screen.findByText('Invoice 61');
    // An incomplete year is not sent, and says so; "Clear" is there at once.
    fireEvent.change(screen.getByLabelText('Year'), { target: { value: '20' } });
    expect(screen.getByText(/Enter a four-digit year/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeTruthy();
    await new Promise((r) => setTimeout(r, 400));
    expect(calls.some((c) => c.url.includes('year='))).toBe(false);
    fireEvent.change(screen.getByLabelText('Number'), { target: { value: '17' } });
    fireEvent.change(screen.getByLabelText('Year'), { target: { value: '2023' } });
    await screen.findByText('Showing 1 of 1 document');
    expect(screen.queryByText('Invoice 61')).toBeNull();
    expect(calls.some((c) => c.url === '/api/books/documents?number=17&year=2023')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await screen.findByText('Invoice 61');
    expect(screen.getByText('Showing 50 of 61 documents')).toBeTruthy();
  });

  it('a first page that fails says so in the list with a retry, never "Loading" forever', async () => {
    let fail = true;
    server(
      shell((_body, url) => {
        if (fail) {
          fail = false;
          return { status: 503, body: { error: { code: 'books_unavailable', message: 'The Books are temporarily unavailable.' } } };
        }
        return pagedDocuments()(null, url);
      }),
    );
    render(<BooksHome />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/documents could not be loaded: The Books are temporarily unavailable/);
    expect(screen.queryByText('Loading documents…')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('Invoice 61');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a filter change while "Load more" waits never appends the old page; the button keeps the focus across pages', async () => {
    // Three pages of the unfiltered list; the second is held until the filter has changed.
    let releasePage2!: () => void;
    const page2Held = new Promise<void>((r) => (releasePage2 = r));
    let page2Requests = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push({ method: 'GET', url, body: null });
        const path = url.split('?')[0];
        const q = new URL(url, 'http://x').searchParams;
        if (path === '/api/books/settings') return new Response(JSON.stringify(SETTINGS), { status: 200 });
        if (path === '/api/books/customers') return new Response(JSON.stringify({ ...CUSTOMERS, nextCursor: null, total: 2 }), { status: 200 });
        if (q.get('number') === '17') return new Response(JSON.stringify({ items: [doc(17)], nextCursor: null, total: 1 }), { status: 200 });
        const cursor = q.get('cursor');
        if (cursor === 'p2') {
          page2Requests += 1;
          await page2Held;
          return new Response(JSON.stringify({ items: Array.from({ length: 50 }, (_, i) => doc(100 - i)), nextCursor: 'p3', total: 150 }), { status: 200 });
        }
        if (cursor === 'p3') return new Response(JSON.stringify({ items: Array.from({ length: 50 }, (_, i) => doc(50 - i)), nextCursor: null, total: 150 }), { status: 200 });
        return new Response(JSON.stringify({ items: Array.from({ length: 50 }, (_, i) => doc(150 - i)), nextCursor: 'p2', total: 150 }), { status: 200 });
      }),
    );
    calls = [];
    render(<BooksHome />);
    await screen.findByText('Invoice 150');
    const more = screen.getByRole('button', { name: 'Load more' });
    more.focus();
    fireEvent.click(more);
    // Waiting: a second click (or Enter) fetches nothing more, and the button keeps the focus.
    fireEvent.click(screen.getByRole('button', { name: 'Loading…' }));
    expect(page2Requests).toBe(1);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Loading…' }));
    // The filter changes while page 2 is still on its way; then page 2 arrives.
    fireEvent.change(screen.getByLabelText('Number'), { target: { value: '17' } });
    await screen.findByText('Showing 1 of 1 document');
    releasePage2();
    await new Promise((r) => setTimeout(r, 50));
    // The old page never mixes into the new list.
    expect(within(screen.getByRole('list', { name: 'Documents' })).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.queryByText('Invoice 100')).toBeNull();
    expect(screen.getByText('Showing 1 of 1 document')).toBeTruthy();
  });

  it('the focus stays with the list: on "Load more" across pages, and on the count when the last page arrives', async () => {
    server(shell(pagedDocuments()));
    render(<BooksHome />);
    await screen.findByText('Invoice 61');
    const more = screen.getByRole('button', { name: 'Load more' });
    more.focus();
    fireEvent.click(more);
    await screen.findByText('Invoice 1');
    // The button is gone (no further page): the focus is on the count, not lost to the page.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByText('Showing 61 of 61 documents')));
  });

  it('a refresh that fails after archiving keeps the rows, says so, and offers a retry', async () => {
    let failNext = false;
    server({
      'GET /api/books/settings': () => ({ status: 200, body: SETTINGS }),
      'GET /api/books/documents': () => ({ status: 200, body: { items: [], nextCursor: null, total: 0 } }),
      'GET /api/books/customers': () => {
        if (failNext) {
          failNext = false;
          return { status: 503, body: { error: { code: 'books_unavailable', message: 'The Books are temporarily unavailable.' } } };
        }
        return { status: 200, body: { ...CUSTOMERS, nextCursor: null, total: 2 } };
      },
      'DELETE /api/books/customers/cust-de': () => {
        failNext = true;
        return { status: 200, body: { ...CUSTOMERS.items[0], archivedAt: '2026-10-21T10:00:00.000Z' } };
      },
    });
    render(<BooksHome />);
    fireEvent.click(await screen.findByRole('button', { name: 'Customers' }));
    await screen.findByText('Alex Example');
    fireEvent.click(within(screen.getByText('Alex Example').closest('li')!).getByRole('button', { name: 'Archive' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/customers could not be refreshed: The Books are temporarily unavailable\. The list may be out of date/);
    expect(screen.getByText('Société Exemple')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('an incomplete year shows the list unfiltered, with its real empty state', async () => {
    server(shell(() => ({ status: 200, body: { items: [], nextCursor: null, total: 0 } })));
    render(<BooksHome />);
    await screen.findByText('No invoices yet');
    fireEvent.change(screen.getByLabelText('Year'), { target: { value: '20' } });
    expect(screen.getByText('No invoices yet')).toBeTruthy();
    expect(screen.queryByText('No document matches these filters.')).toBeNull();
  });

  it('customers page with "Load more" too', async () => {
    server({
      'GET /api/books/settings': () => ({ status: 200, body: SETTINGS }),
      'GET /api/books/documents': () => ({ status: 200, body: { items: [], nextCursor: null, total: 0 } }),
      'GET /api/books/customers': (_body, url) =>
        new URL(url, 'http://x').searchParams.get('cursor')
          ? { status: 200, body: { items: [CUSTOMERS.items[1]], nextCursor: null, total: 2 } }
          : { status: 200, body: { items: [CUSTOMERS.items[0]], nextCursor: 'c-2', total: 2 } },
    });
    render(<BooksHome />);
    fireEvent.click(await screen.findByRole('button', { name: 'Customers' }));
    await screen.findByText('Alex Example');
    expect(screen.getByText('Showing 1 of 2 customers')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText('Société Exemple');
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
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

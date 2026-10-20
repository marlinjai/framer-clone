// src/app/projects/books/__tests__/ImportPanel.test.tsx
//
// "Import past invoices" against a scripted /api/books/imports server (fetch
// stubbed). The interface states of the plan and the four stateful-flow paths
// at the interface:
//   - empty: says what happens, nothing imported without confirmation;
//   - forward: chosen PDFs upload one per request as the body, are read, show
//     ready, import on Import; the counter notice is shown;
//   - backtrack and revise: a correction is sent keyed to the reading and the
//     version, the answer's problems are shown; reading again resets the form
//     to the new reading;
//   - resume: a row uploaded but not read yet is read on load;
//   - re-entry and failure: a duplicate says so and is not read; a failed
//     upload offers a retry; a busy answer is retried; the daily limit stops
//     the queue with a notice; "Import all ready" confirms every ready row.
// All data is synthetic.

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import ImportPanel from '../ImportPanel';

type Json = Record<string, unknown>;

function printed(over: Json = {}): Json {
  return {
    number: '17',
    issueDate: '2022-05-03',
    serviceDate: null,
    servicePeriod: null,
    recipient: { name: 'Example Client GmbH', addressLines: ['Beispielweg 2', '20095 Hamburg'], country: null, countryInferred: 'DE', customerNumber: null },
    recipientVatId: null,
    sender: { name: 'Sample Studio', addressLines: ['Musterstrasse 1', '10115 Berlin'], country: null, taxNumber: null, vatId: null },
    lines: [{ description: 'Design work', quantity: 10, unit: 'h', unitPrice: 80, discount: null, lineTotal: 800, taxRate: null, taxAmount: null }],
    total: 800,
    currency: 'EUR',
    taxTreatment: 'small_business',
    taxAmounts: [],
    pricesIncludeVat: false,
    taxNote: 'Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.',
    paymentTerms: null,
    ...over,
  };
}

function item(over: Json = {}): Json {
  return {
    id: 'i1',
    fileName: 'Rechnung 17.pdf',
    byteSize: 1000,
    status: 'ready',
    version: 3,
    extractionId: 'x1',
    printed: printed(),
    extractedPrinted: printed(),
    confidence: {},
    corrected: false,
    problems: [],
    extractionError: null,
    model: 'claude-sonnet-5-5',
    documentId: null,
    createdAt: '2026-10-20T10:00:00.000Z',
    updatedAt: '2026-10-20T10:00:00.000Z',
    ...over,
  };
}

const LIMITS = { maxFileBytes: 10 * 1024 * 1024, maxFilesAtOnce: 50, parallel: 4, perDay: 500 };

type Handler = (call: { body: unknown; headers: Record<string, string>; url: string }) => { status: number; body: unknown };
let calls: Array<{ method: string; url: string; body: unknown; headers: Record<string, string> }>;

function server(routes: Record<string, Handler | Handler[]>) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const raw = init?.body;
      const body = typeof raw === 'string' ? JSON.parse(raw) : raw ?? null;
      calls.push({ method, url, body, headers });
      const route = routes[`${method} ${url.split('?')[0]}`];
      const handler = Array.isArray(route) ? (route.length > 1 ? route.shift()! : route[0]) : route;
      if (!handler) return new Response(JSON.stringify({ error: { code: 'not_found', message: 'nf' } }), { status: 404 });
      const res = handler({ body, headers, url });
      return new Response(JSON.stringify(res.body), { status: res.status });
    }),
  );
}

function pdfFile(name: string): File {
  return new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])], name, { type: 'application/pdf' });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('ImportPanel', () => {
  it('empty: says what happens and that nothing imports without confirmation', async () => {
    server({ 'GET /api/books/imports': () => ({ status: 200, body: { items: [], counter: { format: '{n}', nextValue: 62 }, limits: LIMITS } }) });
    render(<ImportPanel />);
    expect((await screen.findByLabelText('No past invoices yet')).textContent).toMatch(/Nothing is imported without your confirmation/);
    expect(screen.getByText(/Next invoice number: 62/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Import all ready' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('forward: each PDF uploads as the body, is read, shows ready, and imports', async () => {
    let n = 0;
    server({
      'GET /api/books/imports': () => ({ status: 200, body: { items: [], counter: null, limits: LIMITS } }),
      'POST /api/books/imports': () => {
        n += 1;
        return { status: 201, body: { status: 'staged', item: item({ id: `i${n}`, status: 'uploaded', printed: null, extractionId: null, fileName: `f${n}.pdf` }) } };
      },
      'POST /api/books/imports/i1/extract': () => ({ status: 200, body: item({ id: 'i1' }) }),
      'POST /api/books/imports/i2/extract': () => ({ status: 200, body: item({ id: 'i2', printed: printed({ number: '18' }), fileName: 'f2.pdf' }) }),
      'POST /api/books/imports/i1/confirm': () => ({
        status: 200,
        body: { item: item({ id: 'i1', status: 'imported', documentId: 'doc-1' }), documentId: 'doc-1', counterRaisedTo: 71 },
      }),
    });
    render(<ImportPanel />);
    await screen.findByLabelText('No past invoices yet');
    fireEvent.change(screen.getByLabelText('Choose invoice PDFs'), { target: { files: [pdfFile('Rechnung 17.pdf'), pdfFile('Rechnung 18.pdf')] } });
    await waitFor(() => expect(screen.getAllByText('Ready to check')).toHaveLength(2));
    const ups = calls.filter((c) => c.method === 'POST' && c.url === '/api/books/imports');
    expect(ups).toHaveLength(2);
    expect(ups[0].headers).toMatchObject({ 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent('Rechnung 17.pdf') });
    expect(ups[0].body).toBeInstanceOf(File);
    const row = screen.getByTestId('import-row-i1');
    expect(row.textContent).toContain('Example Client GmbH');
    expect(row.textContent).toContain('800,00 €');
    fireEvent.click(within(row).getByRole('button', { name: 'Import' }));
    await screen.findByText(/counter was raised to 71/);
    expect(calls.find((c) => c.url.endsWith('/i1/confirm'))!.body).toEqual({ expectedVersion: 3, confirmCounterRaiseTo: null });
    expect(within(screen.getByTestId('import-row-i1')).getByRole('link', { name: 'Open' }).getAttribute('href')).toBe('/projects/books/documents/doc-1');
  });

  it('resume: a row uploaded but not read yet is read on load', async () => {
    server({
      'GET /api/books/imports': () => ({ status: 200, body: { items: [item({ status: 'uploaded', printed: null, extractionId: null })], counter: null, limits: LIMITS } }),
      'POST /api/books/imports/i1/extract': () => ({ status: 200, body: item() }),
    });
    render(<ImportPanel />);
    await screen.findByText('Ready to check');
    expect(calls.filter((c) => c.url.endsWith('/i1/extract'))).toHaveLength(1);
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/books/imports')).toBe(false);
  });

  it('backtrack and revise: the correction is keyed to the reading and the version; reading again resets the form', async () => {
    server({
      'GET /api/books/imports': () => ({ status: 200, body: { items: [item({ confidence: { 'recipient.name': 'medium' } })], counter: null, limits: LIMITS } }),
      'PATCH /api/books/imports/i1': ({ body }) => ({
        status: 200,
        body: item({
          version: 4,
          corrected: true,
          printed: (body as { printed: Json }).printed,
          status: 'needs_attention',
          problems: [{ code: 'number_taken', path: 'number', blocking: true, count: null }],
        }),
      }),
      'POST /api/books/imports/i1/extract': () => ({ status: 200, body: item({ version: 5, extractionId: 'x2', printed: printed({ number: '99' }) }) }),
    });
    render(<ImportPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Check' }));
    const form = screen.getByRole('form', { name: 'Invoice as printed' });
    // The field the AI was unsure about is marked.
    expect((within(form).getByLabelText('Name', { selector: '#i1-rname' }) as HTMLInputElement).className).toContain('amber');
    fireEvent.change(within(form).getByLabelText('Invoice number'), { target: { value: '20' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save corrections' }));
    await within(await screen.findByLabelText('Problems')).findByText(/already in the Books/);
    expect(within(screen.getByTestId('import-row-i1')).getByText(/already in the Books/)).toBeTruthy();
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.body).toMatchObject({ extractionId: 'x1', expectedVersion: 3, printed: { number: '20', total: 800, currency: 'EUR' } });
    // Reading again replaces the correction: asked first, the focus on Cancel; confirmed, it is sent as a replacing read.
    fireEvent.click(within(screen.getByRole('form', { name: 'Invoice as printed' })).getByRole('button', { name: 'Read again with AI' }));
    const ask = screen.getByRole('alertdialog', { name: 'Replace what you entered' });
    await waitFor(() => expect(document.activeElement).toBe(within(ask).getByRole('button', { name: 'Cancel' })));
    expect(calls.some((c) => c.url.includes('/extract'))).toBe(false);
    fireEvent.click(within(ask).getByRole('button', { name: 'Replace with a new reading' }));
    await waitFor(() =>
      expect((within(screen.getByRole('form', { name: 'Invoice as printed' })).getByLabelText('Invoice number') as HTMLInputElement).value).toBe('99'),
    );
    expect(calls.find((c) => c.url.includes('/extract'))!.url).toBe('/api/books/imports/i1/extract?replace=1');
  });

  it('re-entry and failures: duplicate, failed upload with retry, busy retried, daily limit stops', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const uploads = [
      { status: 200, body: { status: 'duplicate', item: null, documentId: 'doc-9' } },
      { status: 500, body: { error: { code: 'books_failed', message: 'the request failed' } } },
      { status: 201, body: { status: 'staged', item: item({ id: 'i2', status: 'uploaded', printed: null, fileName: 'b.pdf' }) } },
      { status: 201, body: { status: 'staged', item: item({ id: 'i3', status: 'uploaded', printed: null, fileName: 'c.pdf' }) } },
    ];
    server({
      'GET /api/books/imports': () => ({ status: 200, body: { items: [], counter: null, limits: LIMITS } }),
      'POST /api/books/imports': () => uploads.shift()!,
      'POST /api/books/imports/i2/extract': [
        () => ({ status: 429, body: { error: { code: 'extract_busy', message: 'busy', retryAfterSec: 1 } } }),
        () => ({ status: 200, body: item({ id: 'i2', fileName: 'b.pdf' }) }),
      ],
      'POST /api/books/imports/i3/extract': () => ({ status: 429, body: { error: { code: 'import_limit', message: 'limit' } } }),
    });
    render(<ImportPanel />);
    await screen.findByLabelText('No past invoices yet');
    fireEvent.change(screen.getByLabelText('Choose invoice PDFs'), { target: { files: [pdfFile('a.pdf'), pdfFile('b.pdf')] } });
    await screen.findByText('Duplicate: Already imported.');
    const failed = await screen.findByText(/Failed:/);
    fireEvent.click(within(failed.closest('li')!).getByRole('button', { name: 'Retry' }));
    await vi.advanceTimersByTimeAsync(1500);
    await waitFor(() => expect(within(screen.getByTestId('import-row-i2')).getByText('Ready to check')).toBeTruthy());
    expect(calls.filter((c) => c.url.endsWith('/i2/extract'))).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('Choose invoice PDFs'), { target: { files: [pdfFile('c.pdf')] } });
    await screen.findByText(/daily limit of invoices read/);
    expect(calls.filter((c) => c.url.endsWith('/extract')).map((c) => c.url)).not.toContain('/api/books/imports/i1/extract');
  });

  it('"Import all ready" confirms every ready row and leaves the others', async () => {
    server({
      'GET /api/books/imports': () => ({
        status: 200,
        body: {
          items: [
            item({ id: 'i1' }),
            item({ id: 'i2', problems: [{ code: 'number_missing', path: null, blocking: true, count: null }], status: 'needs_attention' }),
            item({ id: 'i3' }),
          ],
          counter: null,
          limits: LIMITS,
        },
      }),
      'POST /api/books/imports/i1/confirm': () => ({ status: 200, body: { item: item({ id: 'i1', status: 'imported', documentId: 'd1' }), documentId: 'd1', counterRaisedTo: null } }),
      'POST /api/books/imports/i3/confirm': () => ({ status: 200, body: { item: item({ id: 'i3', status: 'imported', documentId: 'd3' }), documentId: 'd3', counterRaisedTo: null } }),
    });
    render(<ImportPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Import all ready (2)' }));
    await waitFor(() => expect(screen.getAllByText('Imported')).toHaveLength(2));
    expect(calls.filter((c) => c.url.endsWith('/confirm')).map((c) => c.url)).toEqual(['/api/books/imports/i1/confirm', '/api/books/imports/i3/confirm']);
    expect(within(screen.getByTestId('import-row-i2')).getByText('The invoice number is missing.')).toBeTruthy();
  });

  it('a row that raises the counter says so before import and imports only after the explicit confirmation of that value', async () => {
    const raising = item({ problems: [{ code: 'counter_raised', path: null, blocking: false, count: 71 }] });
    server({
      'GET /api/books/imports': () => ({ status: 200, body: { items: [raising], counter: { format: '{n}', nextValue: 62 }, limits: LIMITS } }),
      'POST /api/books/imports/i1/confirm': () => ({ status: 200, body: { item: item({ status: 'imported', documentId: 'd1' }), documentId: 'd1', counterRaisedTo: 71 } }),
    });
    render(<ImportPanel />);
    const row = await screen.findByTestId('import-row-i1');
    expect(row.textContent).toContain('Importing sets your next invoice number to 71. It cannot be lowered later.');
    fireEvent.click(within(row).getByRole('button', { name: 'Import' }));
    // Not imported yet: the confirmation asks first.
    const dialog = screen.getByRole('alertdialog', { name: 'Confirm the new invoice number' });
    expect(dialog.textContent).toContain('Your next invoice number will become 71. It cannot be lowered later.');
    expect(calls.some((c) => c.url.endsWith('/confirm'))).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Import and set the next number to 71' }));
    await screen.findByText(/counter was raised to 71/);
    expect(calls.find((c) => c.url.endsWith('/i1/confirm'))!.body).toEqual({ expectedVersion: 3, confirmCounterRaiseTo: 71 });
  });

  it('"Import all ready" with a raising row confirms the highest new number first, then sends each row its own value', async () => {
    server({
      'GET /api/books/imports': () => ({
        status: 200,
        body: {
          items: [
            item({ id: 'i1', problems: [{ code: 'counter_raised', path: null, blocking: false, count: 66 }] }),
            item({ id: 'i2', problems: [{ code: 'counter_raised', path: null, blocking: false, count: 71 }] }),
            item({ id: 'i3' }),
          ],
          counter: null,
          limits: LIMITS,
        },
      }),
      'POST /api/books/imports/i1/confirm': () => ({ status: 200, body: { item: item({ id: 'i1', status: 'imported' }), documentId: 'd1', counterRaisedTo: 66 } }),
      'POST /api/books/imports/i2/confirm': () => ({ status: 200, body: { item: item({ id: 'i2', status: 'imported' }), documentId: 'd2', counterRaisedTo: 71 } }),
      'POST /api/books/imports/i3/confirm': () => ({ status: 200, body: { item: item({ id: 'i3', status: 'imported' }), documentId: 'd3', counterRaisedTo: null } }),
    });
    render(<ImportPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Import all ready (3)' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Confirm the new invoice number' });
    expect(dialog.textContent).toContain('Your next invoice number will become 71. It cannot be lowered later.');
    expect(calls.some((c) => c.url.endsWith('/confirm'))).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Import and set the next number to 71' }));
    await waitFor(() => expect(screen.getAllByText('Imported')).toHaveLength(3));
    expect(calls.filter((c) => c.url.endsWith('/confirm')).map((c) => (c.body as Json).confirmCounterRaiseTo)).toEqual([66, 71, null]);
  });

  it('a number jumping far ahead is confirmed for exactly that number', async () => {
    const jumping = item({ status: 'needs_attention', printed: printed({ number: '9999' }), problems: [{ code: 'number_jump', path: 'number', blocking: true, count: 62 }] });
    server({
      'GET /api/books/imports': () => ({ status: 200, body: { items: [jumping], counter: null, limits: LIMITS } }),
      'POST /api/books/imports/i1/confirm-number': () => ({ status: 200, body: item({ version: 4, printed: printed({ number: '9999' }) }) }),
    });
    render(<ImportPanel />);
    const row = await screen.findByTestId('import-row-i1');
    expect(row.textContent).toMatch(/more than 50 above 62/);
    expect(within(row).queryByRole('button', { name: 'Import' })).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: 'The number is right' }));
    await waitFor(() => expect(within(screen.getByTestId('import-row-i1')).getByText('Ready to check')).toBeTruthy());
    expect(calls.find((c) => c.url.endsWith('/confirm-number'))!.body).toEqual({ documentNumber: '9999', expectedVersion: 3 });
  });

  it('a PDF the AI could not read is filled in by hand: no "Check" before, the form opens after', async () => {
    const failed = item({ status: 'needs_attention', printed: null, extractedPrinted: null, extractionId: null, extractionError: 'unreadable', problems: [{ code: 'extraction_failed:unreadable', path: null, blocking: true, count: null }] });
    server({
      'GET /api/books/imports': () => ({ status: 200, body: { items: [failed], importedTotal: 0, counter: null, limits: LIMITS } }),
      'POST /api/books/imports/i1/by-hand': () => ({
        status: 200,
        body: item({ version: 4, status: 'needs_attention', extractionId: 'manual:1', printed: printed({ number: null, recipient: null, lines: [], total: null }), problems: [{ code: 'number_missing', path: null, blocking: true, count: null }] }),
      }),
    });
    render(<ImportPanel />);
    const row = await screen.findByTestId('import-row-i1');
    expect(row.textContent).toMatch(/could not open this PDF/);
    expect(within(row).queryByRole('button', { name: 'Check' })).toBeNull();
    // Unreadable is not offered again: reading it again cannot change it.
    expect(within(row).queryByRole('button', { name: 'Read again' })).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: 'Fill in by hand' }));
    const form = await screen.findByRole('form', { name: 'Invoice as printed' });
    expect((within(form).getByLabelText('Invoice number') as HTMLInputElement).value).toBe('');
    expect(calls.find((c) => c.url.endsWith('/by-hand'))!.body).toEqual({ expectedVersion: 3 });
  });

  it('a row stopped by the daily limit can be read later with its own button', async () => {
    server({
      'GET /api/books/imports': () => ({ status: 200, body: { items: [item({ status: 'uploaded', printed: null, extractionId: null })], importedTotal: 0, counter: null, limits: LIMITS } }),
      'POST /api/books/imports/i1/extract': [
        () => ({ status: 429, body: { error: { code: 'import_limit', message: 'The daily limit of invoices read is reached.' } } }),
        () => ({ status: 200, body: item() }),
      ],
    });
    render(<ImportPanel />);
    await screen.findByText(/daily limit of invoices read/);
    fireEvent.click(within(await screen.findByTestId('import-row-i1')).getByRole('button', { name: 'Read' }));
    await screen.findByText('Ready to check');
    expect(calls.filter((c) => c.url.endsWith('/i1/extract'))).toHaveLength(2);
  });

  it('"Import all ready" goes on after a failure with the rows as they are now, and names what failed', async () => {
    const lists = [
      { items: [item({ id: 'i1', fileName: 'a.pdf' }), item({ id: 'i2', fileName: 'b.pdf' })], importedTotal: 0, counter: null, limits: LIMITS },
      // After the failure: the second row was checked again meanwhile (its version moved).
      { items: [item({ id: 'i1', fileName: 'a.pdf', version: 5 }), item({ id: 'i2', fileName: 'b.pdf', version: 9 })], importedTotal: 0, counter: null, limits: LIMITS },
    ];
    server({
      'GET /api/books/imports': () => ({ status: 200, body: lists.length > 1 ? lists.shift()! : lists[0] }),
      'POST /api/books/imports/i1/confirm': () => ({ status: 409, body: { error: { code: 'concurrent_edit', message: 'the row changed meanwhile' } } }),
      'POST /api/books/imports/i2/confirm': () => ({ status: 200, body: { item: item({ id: 'i2', status: 'imported', documentId: 'd2' }), documentId: 'd2', counterRaisedTo: null } }),
    });
    render(<ImportPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Import all ready (2)' }));
    await screen.findByText(/1 of 2 were not imported/);
    expect(screen.getByText(/a\.pdf:/)).toBeTruthy();
    expect(calls.find((c) => c.url.endsWith('/i2/confirm'))!.body).toEqual({ expectedVersion: 9, confirmCounterRaiseTo: null });
  });

  it('after the daily limit, a row\'s "Read" reads only that row, never the rest of the old queue', async () => {
    server({
      'GET /api/books/imports': () => ({
        status: 200,
        body: { items: [item({ id: 'i1', status: 'uploaded', printed: null, extractionId: null }), item({ id: 'i2', status: 'uploaded', printed: null, extractionId: null })], importedTotal: 0, counter: null, limits: { ...LIMITS, parallel: 1 } },
      }),
      'POST /api/books/imports/i1/extract': () => ({ status: 429, body: { error: { code: 'import_limit', message: 'The daily limit of invoices read is reached.' } } }),
      'POST /api/books/imports/i2/extract': () => ({ status: 200, body: item({ id: 'i2' }) }),
    });
    render(<ImportPanel />);
    await screen.findByText(/daily limit of invoices read/);
    expect(calls.filter((c) => c.url.endsWith('/i2/extract'))).toHaveLength(0);
    fireEvent.click(within(screen.getByTestId('import-row-i2')).getByRole('button', { name: 'Read' }));
    await waitFor(() => expect(within(screen.getByTestId('import-row-i2')).getByText('Ready to check')).toBeTruthy());
    expect(calls.filter((c) => c.url.endsWith('/i1/extract'))).toHaveLength(1);
  });

  it('the counter-raise confirmation puts the focus on Cancel, and Cancel gives it back to Import', async () => {
    server({ 'GET /api/books/imports': () => ({ status: 200, body: { items: [item({ problems: [{ code: 'counter_raised', path: null, blocking: false, count: 71 }] })], importedTotal: 0, counter: null, limits: LIMITS } }) });
    render(<ImportPanel />);
    const row = await screen.findByTestId('import-row-i1');
    fireEvent.click(within(row).getByRole('button', { name: 'Import' }));
    const cancel = within(screen.getByRole('alertdialog', { name: 'Confirm the new invoice number' })).getByRole('button', { name: 'Cancel' });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    fireEvent.click(cancel);
    await waitFor(() => expect(document.activeElement).toBe(within(screen.getByTestId('import-row-i1')).getByRole('button', { name: 'Import' })));
  });

  it('a replacing read keeps its flag across a busy retry; queued reads never replace', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    server({
      'GET /api/books/imports': () => ({ status: 200, body: { items: [item({ status: 'needs_attention', extractionError: 'error', corrected: true })], importedTotal: 0, counter: null, limits: LIMITS } }),
      'POST /api/books/imports/i1/extract': [
        () => ({ status: 429, body: { error: { code: 'extract_busy', message: 'busy', retryAfterSec: 1 } } }),
        () => ({ status: 200, body: item({ version: 7, extractionId: 'x2' }) }),
      ],
    });
    render(<ImportPanel />);
    fireEvent.click(within(await screen.findByTestId('import-row-i1')).getByRole('button', { name: 'Read again' }));
    await vi.advanceTimersByTimeAsync(1500);
    await waitFor(() => expect(calls.filter((c) => c.url.includes('/i1/extract'))).toHaveLength(2));
    expect(calls.filter((c) => c.url.includes('/i1/extract')).map((c) => c.url)).toEqual([
      '/api/books/imports/i1/extract?replace=1',
      '/api/books/imports/i1/extract?replace=1',
    ]);
  });

  it('filling a row in by hand drops a pending busy retry of its reading', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    server({
      'GET /api/books/imports': () => ({ status: 200, body: { items: [item({ status: 'uploaded', printed: null, extractionId: null })], importedTotal: 0, counter: null, limits: LIMITS } }),
      'POST /api/books/imports/i1/extract': () => ({ status: 429, body: { error: { code: 'extract_busy', message: 'busy', retryAfterSec: 2 } } }),
      'POST /api/books/imports/i1/by-hand': () => ({ status: 200, body: item({ version: 4, status: 'needs_attention', extractionId: 'manual:1', printed: printed({ number: null }) }) }),
    });
    render(<ImportPanel />);
    await waitFor(() => expect(calls.filter((c) => c.url.includes('/i1/extract'))).toHaveLength(1));
    fireEvent.click(await within(screen.getByTestId('import-row-i1')).findByRole('button', { name: 'Fill in by hand' }));
    await screen.findByRole('form', { name: 'Invoice as printed' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(calls.filter((c) => c.url.includes('/i1/extract'))).toHaveLength(1);
    expect(calls.every((c) => !c.url.endsWith('?replace=1'))).toBe(true);
  });

  it('the batch confirmation puts the focus on Cancel, and Cancel gives it back to "Import all ready"', async () => {
    server({ 'GET /api/books/imports': () => ({ status: 200, body: { items: [item({ problems: [{ code: 'counter_raised', path: null, blocking: false, count: 71 }] })], importedTotal: 0, counter: null, limits: LIMITS } }) });
    render(<ImportPanel />);
    const all = await screen.findByRole('button', { name: 'Import all ready (1)' });
    fireEvent.click(all);
    const dialog = screen.getByRole('alertdialog', { name: 'Confirm the new invoice number' });
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' })));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Import all ready (1)' })));
  });

  it('the replace question in the editor gives the focus back to "Read again with AI" on Cancel and on Escape', async () => {
    server({ 'GET /api/books/imports': () => ({ status: 200, body: { items: [item({ corrected: true })], importedTotal: 0, counter: null, limits: LIMITS } }) });
    render(<ImportPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Check' }));
    const form = screen.getByRole('form', { name: 'Invoice as printed' });
    const reread = within(form).getByRole('button', { name: 'Read again with AI' });
    fireEvent.click(reread);
    fireEvent.click(within(screen.getByRole('alertdialog', { name: 'Replace what you entered' })).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(document.activeElement).toBe(reread));
    fireEvent.click(reread);
    fireEvent.keyDown(await screen.findByRole('alertdialog', { name: 'Replace what you entered' }), { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(reread));
    expect(screen.queryByRole('alertdialog', { name: 'Replace what you entered' })).toBeNull();
    expect(calls.some((c) => c.url.includes('/extract'))).toBe(false);
  });

  it('discarding asks first (the file is deleted at once); Cancel keeps the row, Discard sends it', async () => {
    server({
      'GET /api/books/imports': () => ({ status: 200, body: { items: [item()], importedTotal: 0, counter: null, limits: LIMITS } }),
      'POST /api/books/imports/i1/discard': () => ({ status: 200, body: item({ status: 'discarded' }) }),
    });
    render(<ImportPanel />);
    const discard = within(await screen.findByTestId('import-row-i1')).getByRole('button', { name: 'Discard' });
    fireEvent.click(discard);
    const dialog = screen.getByRole('alertdialog', { name: 'Discard this file' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(document.activeElement).toBe(discard));
    expect(calls.some((c) => c.url.endsWith('/discard'))).toBe(false);
    fireEvent.click(discard);
    fireEvent.click(within(screen.getByRole('alertdialog', { name: 'Discard this file' })).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByTestId('import-row-i1')).toBeNull());
  });

  it('filling in by hand that fails keeps the busy retry of the reading', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    server({
      'GET /api/books/imports': () => ({ status: 200, body: { items: [item({ status: 'uploaded', printed: null, extractionId: null })], importedTotal: 0, counter: null, limits: LIMITS } }),
      'POST /api/books/imports/i1/extract': [
        () => ({ status: 429, body: { error: { code: 'extract_busy', message: 'busy', retryAfterSec: 2 } } }),
        () => ({ status: 200, body: item() }),
      ],
      'POST /api/books/imports/i1/by-hand': () => ({ status: 409, body: { error: { code: 'concurrent_edit', message: 'the row changed meanwhile' } } }),
    });
    render(<ImportPanel />);
    await waitFor(() => expect(calls.filter((c) => c.url.includes('/i1/extract'))).toHaveLength(1));
    fireEvent.click(await within(screen.getByTestId('import-row-i1')).findByRole('button', { name: 'Fill in by hand' }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/by-hand'))).toBe(true));
    await vi.advanceTimersByTimeAsync(3000);
    await waitFor(() => expect(calls.filter((c) => c.url.includes('/i1/extract'))).toHaveLength(2));
  });

  it('after replacing with a new reading, the reopened form has the focus on its heading', async () => {
    server({
      'GET /api/books/imports': () => ({ status: 200, body: { items: [item({ corrected: true })], importedTotal: 0, counter: null, limits: LIMITS } }),
      'POST /api/books/imports/i1/extract': () => ({ status: 200, body: item({ version: 5, extractionId: 'x2', printed: printed({ number: '99' }) }) }),
    });
    render(<ImportPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Check' }));
    fireEvent.click(within(screen.getByRole('form', { name: 'Invoice as printed' })).getByRole('button', { name: 'Read again with AI' }));
    fireEvent.click(within(await screen.findByRole('alertdialog', { name: 'Replace what you entered' })).getByRole('button', { name: 'Replace with a new reading' }));
    await waitFor(() =>
      expect((within(screen.getByRole('form', { name: 'Invoice as printed' })).getByLabelText('Invoice number') as HTMLInputElement).value).toBe('99'),
    );
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Check the invoice as printed' })));
  });

  it('shows how many imported invoices are not listed', async () => {
    server({ 'GET /api/books/imports': () => ({ status: 200, body: { items: [item({ status: 'imported', documentId: 'd1' })], importedTotal: 140, counter: null, limits: LIMITS } }) });
    render(<ImportPanel />);
    expect(await screen.findByText(/newest 1 of 140 imported invoices/)).toBeTruthy();
  });

  it('everything imported: says so', async () => {
    server({ 'GET /api/books/imports': () => ({ status: 200, body: { items: [item({ status: 'imported', documentId: 'd1' })], counter: null, limits: LIMITS } }) });
    render(<ImportPanel />);
    expect((await screen.findByLabelText('Everything imported')).textContent).toMatch(/marked imported/);
  });
});

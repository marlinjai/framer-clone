// src/app/projects/books/invoice/__tests__/InvoicePage.test.tsx
//
// Writing the invoice on the invoice page (WYSIWYG invoice editor plan,
// phase 3), through the document editor, against a scripted /api/books server
// (fetch stubbed). The engine's browser render and the PDF canvas are
// stand-ins (jsdom has neither Web Workers nor canvas): the render returns a
// fixed field map, the canvas draws the page's overlay straight away. The real
// engine and pdf.js are proven in the browser. The four stateful-flow paths:
//   1. forward: a field opens in place, a typed value is sent in the Books'
//      units with the version on screen, the page reads the server's answer;
//      a line is added on the page, one is picked from the product list;
//   2. backtrack and revise: a bad value is named and nothing is sent; Escape
//      leaves the value; undo sends the value before, redo the value after;
//      a removed line comes back at its place;
//   3. resume: what the page shows is the server's (render input read again
//      after every change);
//   4. re-entry: a narrow window and "Use the form" give the form; an issued
//      invoice is shown as its stored PDF.
// All data is synthetic.

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

let renderInputs = 0;
vi.mock('@/lib/books/engine', () => ({
  browserRenderSupported: () => true,
  fetchRenderInput: vi.fn(async () => {
    renderInputs += 1;
    return { format: 1, documentId: 'doc-1', documentVersion: 3, fontFamily: 'dejavu-sans', input: { draft: true, document: {}, lines: [] }, template: {}, logos: [] };
  }),
  renderDraftInBrowser: vi.fn(async () => ({ bytes: new Uint8Array([37, 80, 68, 70]), layout: LAYOUT, renderMs: 12 })),
  BrowserRenderError: class extends Error {},
}));

vi.mock('../../composer/PdfCanvas', () => ({
  default: function CanvasStandIn(props: { overlay?: (page: number, scale: number) => React.ReactNode; pdf: unknown; layout: unknown }) {
    if (!props.pdf) return <p>No page</p>;
    return <div data-testid="page">{props.overlay ? props.overlay(1, 1) : 'stored pdf'}</div>;
  },
}));

import DocumentEditor from '../../DocumentEditor';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const style = { fontFamily: 'dejavu-sans', bold: false, sizePt: 9.5, color: '#1a1a1f', align: 'left', lineHeightPt: 12 };
const rect = (y: number, x = 60, width = 200) => [{ page: 1, x, y, width, height: 12 }];
const field = (over: Json) => ({ source: null, documentField: null, valueUnit: null, recipientField: null, lineId: null, blockId: 'b', region: 'body', empty: false, room: null, style, ...over });
const LAYOUT = {
  page: { width: 595.28, height: 841.89 },
  pageCount: 1,
  blocks: [],
  tables: [{ blockId: 'lineTable', columns: { title: { x: 80, width: 200 }, quantity: { x: 300, width: 50 }, unit: { x: 350, width: 40 }, unitPrice: { x: 400, width: 70 } } }],
  issues: [],
  fields: [
    field({ id: 'recipient.line.1', kind: 'readonly', region: 'addressZone.left', recipientField: 'name', rects: rect(140) }),
    field({ id: 'introText', kind: 'multiline', source: 'document', documentField: 'introText', empty: true, room: 30, rects: rect(300, 60, 480) }),
    field({ id: 'line.l1.title', kind: 'text', source: 'line', documentField: 'title', lineId: 'l1', rects: rect(340, 80) }),
    field({ id: 'line.l1.quantity', kind: 'number', source: 'line', documentField: 'quantity', valueUnit: 'thousandths', lineId: 'l1', rects: rect(340, 300, 50) }),
    field({ id: 'line.l1.unitPrice', kind: 'money', source: 'line', documentField: 'unitPrice', valueUnit: 'cents', lineId: 'l1', rects: rect(340, 400, 70) }),
    field({ id: 'totals.1', kind: 'readonly', rects: rect(400, 400, 100) }),
  ],
  anchors: {
    rows: [{ lineId: 'l1', blockId: 'lineTable', rects: rect(340, 60, 480) }],
    addLine: [{ blockId: 'lineTable', rect: { page: 1, x: 60, y: 360, width: 480, height: 14 }, room: 20 }],
  },
};

function line(over: Json = {}): Json {
  return { id: 'l1', position: 1, kind: 'service', title: 'Consulting', description: null, quantity: 1500, unitLabel: 'Std', unitPrice: 8000, discountBp: 0, subtotal: 12000, taxClass: 'standard', taxRateOverride: null, taxRate: 1900, taxAmount: 2280, taxTreatment: 'standard', updatedAt: '2026-10-19T08:00:00.000Z', ...over };
}

function detail(over: { document?: Json; lines?: Json[] } = {}): Json {
  return {
    document: {
      id: 'doc-1', docType: 'invoice', status: 'draft', source: 'editor', version: 3, customerId: 'cust-de', templateId: null, correctsDocumentId: null, replacesDocumentId: null,
      printReplacesReference: false, documentNumber: null, issueDate: null, serviceDate: '2026-10-01', servicePeriodStart: null, servicePeriodEnd: null, dueDate: null, paymentTermsDays: 14,
      contractReference: null, netOrGross: 'net', kleinunternehmer: false, reverseCharge: false, taxNote: null, taxProfileKey: 'regular|b2c||DE', subtotal: 12000, taxAmount: 2280, total: 14280,
      taxSummary: [{ taxRate: 1900, taxTreatment: 'standard', net: 12000, tax: 2280 }], introText: null, outroText: null, renderedPdfFileId: null, customerSnapshot: null, ...over.document,
    },
    lines: over.lines ?? [line()],
    events: [],
    related: { corrects: null, correctedBy: null, replaces: null, replacedBy: null },
    stale: false,
    customer: null,
  };
}

const CUSTOMERS = {
  items: [
    { id: 'cust-de', contactId: 'c1', archivedAt: null, contact: { name: 'Alex Example' } },
    { id: 'cust-fr', contactId: 'c2', archivedAt: null, contact: { name: 'Société Exemple' } },
  ],
};
const SETTINGS = { initialised: true, settings: { taxStatus: 'regular', exemptionNote: 'x', senderBlock: {}, defaultPaymentTermsDays: 14 }, counters: [{ docType: 'invoice', format: '{n}', nextValue: 62, nextNumber: '62' }] };

type Handler = (body: Json | null, url: string) => { status: number; body: unknown };
let calls: Array<{ method: string; url: string; body: Json | null }>;
let current: Json;
let nextLineId = 10;

function server(extra: Record<string, Handler> = {}) {
  calls = [];
  const routes: Record<string, Handler> = {
    'GET /api/books/documents/doc-1': () => ({ status: 200, body: current }),
    'GET /api/books/customers': () => ({ status: 200, body: CUSTOMERS }),
    'GET /api/books/settings': () => ({ status: 200, body: SETTINGS }),
    'PATCH /api/books/documents/doc-1/lines/l1': (b) => {
      current = detail({ document: { version: current.document.version + 1 }, lines: [line({ ...stripVersion(b) })] });
      return { status: 200, body: current };
    },
    'PATCH /api/books/documents/doc-1': (b) => {
      current = detail({ document: { ...current.document, ...stripVersion(b), version: current.document.version + 1 } });
      return { status: 200, body: current };
    },
    'POST /api/books/documents/doc-1/lines': (b) => {
      current = detail({ document: { version: current.document.version + 1 }, lines: [...current.lines, line({ id: `l${nextLineId++}`, ...stripVersion(b) })] });
      return { status: 201, body: current };
    },
    'DELETE /api/books/documents/doc-1/lines/l1': () => {
      current = detail({ document: { version: current.document.version + 1 }, lines: current.lines.filter((l: Json) => l.id !== 'l1') });
      return { status: 200, body: current };
    },
    'POST /api/books/documents/doc-1/lines/reorder': (b) => {
      current = detail({ document: { version: current.document.version + 1 }, lines: b!.lineIds.map((id: string) => current.lines.find((l: Json) => l.id === id)) });
      return { status: 200, body: current };
    },
    'PUT /api/books/documents/doc-1/customer': (b) => {
      current = detail({ document: { ...current.document, customerId: b!.customerId, version: current.document.version + 1 } });
      return { status: 200, body: current };
    },
    'GET /api/books/products': () => ({
      status: 200,
      body: { items: [{ id: 'p1', kind: 'service', name: 'Beratung', description: 'Strategie', unitLabel: 'Std', unitPrice: 9900, priceBasis: 'gross', taxClass: 'standard', discountBp: 0, archivedAt: null }], nextCursor: null, total: 1 },
    }),
    ...extra,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Json) : null;
      calls.push({ method, url, body });
      const handler = routes[`${method} ${url.split('?')[0]}`];
      if (!handler) return new Response(JSON.stringify({ error: { code: 'not_found', message: 'nf' } }), { status: 404 });
      const res = handler(body, url);
      return new Response(JSON.stringify(res.body), { status: res.status });
    }),
  );
}

function stripVersion(b: Json | null): Json {
  const { expectedVersion, ...rest } = b ?? {};
  void expectedVersion;
  return rest;
}

function wideWindow(wide: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: wide, media: q, addEventListener: () => {}, removeEventListener: () => {} }));
  window.matchMedia = globalThis.matchMedia as typeof window.matchMedia;
}

const live = () => screen.getByRole('region', { name: 'Invoice page' }).querySelector('p[aria-live]')!.textContent ?? '';
const fieldButton = (id: string) => document.querySelector<HTMLButtonElement>(`[data-field-id="${id}"]`)!;

beforeEach(() => {
  current = detail();
  renderInputs = 0;
  window.localStorage.clear();
  wideWindow(true);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function opened() {
  render(<DocumentEditor id="doc-1" />);
  await waitFor(() => expect(fieldButton('line.l1.quantity')).toBeTruthy());
}

describe('the invoice page: forward', () => {
  it('a field opens in place with its value, and the typed value goes in the Books units with the version', async () => {
    server();
    await opened();
    expect(screen.queryByRole('region', { name: 'Lines' })).toBeNull(); // the form is not shown
    fireEvent.click(fieldButton('line.l1.quantity'));
    const input = screen.getByRole('textbox', { name: 'Line 1, quantity' }) as HTMLInputElement;
    expect(input.value).toBe('1,5');
    expect(input.style.fontFamily).toContain('books-dejavu-sans');
    fireEvent.change(input, { target: { value: '2,25' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ quantity: 2250, expectedVersion: 3 });
    await waitFor(() => expect(live()).toBe('Line 1, quantity saved.'));
    // The page is read again from the server after the change.
    await waitFor(() => expect(renderInputs).toBeGreaterThanOrEqual(2));
  });

  it('an empty intro text offers "Add an intro text" where it would print, and saves the typed text', async () => {
    server();
    await opened();
    const slot = fieldButton('introText');
    expect(slot.textContent).toContain('Add an intro text');
    fireEvent.click(slot);
    const box = screen.getByRole('textbox', { name: 'Intro text' });
    fireEvent.change(box, { target: { value: 'Vielen Dank.\nHier die Leistungen.' } });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ introText: 'Vielen Dank.\nHier die Leistungen.', expectedVersion: 3 }));
  });

  it('adds a line on the page; Enter in its price adds it and opens the next', async () => {
    server();
    await opened();
    fireEvent.click(screen.getByRole('button', { name: 'Add line' }));
    fireEvent.change(screen.getByLabelText('New line, description'), { target: { value: 'Workshop' } });
    fireEvent.change(screen.getByLabelText('New line, quantity'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('New line, unit price in euros'), { target: { value: '120' } });
    fireEvent.keyDown(screen.getByLabelText('New line, unit price in euros'), { key: 'Enter' });
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ kind: 'service', title: 'Workshop', quantity: 3000, unitLabel: 'Std', unitPrice: 12000, taxClass: 'standard', expectedVersion: 3 }));
    await waitFor(() => expect((screen.getByLabelText('New line, description') as HTMLInputElement).value).toBe(''));
  });

  it('picks a line from the product list, with its price basis for the server to convert', async () => {
    server();
    await opened();
    fireEvent.click(screen.getByRole('button', { name: 'Choose product' }));
    fireEvent.click(await screen.findByRole('button', { name: /Beratung/ }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
        kind: 'service', title: 'Beratung', description: 'Strategie', unitLabel: 'Std', unitPrice: 9900, priceBasis: 'gross', taxClass: 'standard', discountBp: 0, quantity: 1000, expectedVersion: 3,
      }),
    );
  });

  it('the address chooses another customer; computed figures are not fields', async () => {
    server();
    await opened();
    expect(document.querySelector('[data-field-id="totals.1"]')).toBeNull();
    fireEvent.click(fieldButton('recipient.line.1'));
    const select = screen.getByRole('combobox', { name: 'Customer' });
    fireEvent.change(select, { target: { value: 'cust-fr' } });
    fireEvent.keyDown(select, { key: 'Enter' });
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ customerId: 'cust-fr', expectedVersion: 3 }));
  });
});

describe('the invoice page: backtrack and revise', () => {
  it('a bad value is named and nothing is sent; Escape leaves the value as it was', async () => {
    server();
    await opened();
    fireEvent.click(fieldButton('line.l1.unitPrice'));
    const input = screen.getByRole('textbox', { name: 'Line 1, unit price' });
    fireEvent.change(input, { target: { value: 'achtzig' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('alert').textContent).toBe('Enter a price in euros, for example 80,00.');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'Line 1, unit price' })).toBeNull();
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('undo sends the value before, redo the value after', async () => {
    server();
    await opened();
    fireEvent.click(fieldButton('line.l1.quantity'));
    const input = screen.getByRole('textbox', { name: 'Line 1, quantity' });
    fireEvent.change(input, { target: { value: '4' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(live()).toBe('Line 1, quantity saved.'));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PATCH').at(-1)!.body).toEqual({ quantity: 1500, expectedVersion: 4 }));
    await waitFor(() => expect(live()).toBe('Undone: Line 1, quantity.'));
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true, shiftKey: true });
    await waitFor(() => expect(calls.filter((c) => c.method === 'PATCH').at(-1)!.body).toEqual({ quantity: 4000, expectedVersion: 5 }));
  });

  it('a removed line comes back at its place with undo', async () => {
    current = detail({ lines: [line(), line({ id: 'l2', position: 2, title: 'Second' })] });
    server();
    await opened();
    fireEvent.click(screen.getByRole('button', { name: 'Line 1 actions' }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Remove' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
    await waitFor(() => expect(live()).toContain('Line 1 removed.'));
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST' && c.url.endsWith('/reorder')).length).toBe(1));
    expect(current.lines.map((l: Json) => l.title)).toEqual(['Consulting', 'Second']);
  });

  it('a change refused as stale reloads the draft and keeps the typed value in the field', async () => {
    server({ 'PATCH /api/books/documents/doc-1/lines/l1': () => ({ status: 409, body: { error: { code: 'concurrent_edit', message: 'newer' } } }) });
    await opened();
    fireEvent.click(fieldButton('line.l1.quantity'));
    const input = screen.getByRole('textbox', { name: 'Line 1, quantity' });
    fireEvent.change(input, { target: { value: '7' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(calls.filter((c) => c.url === '/api/books/documents/doc-1' && c.method === 'GET').length).toBeGreaterThanOrEqual(2));
    expect(((await screen.findByRole('textbox', { name: 'Line 1, quantity' })) as HTMLInputElement).value).toBe('7');
  });
});

describe('the invoice page: re-entry', () => {
  it('"Use the form" switches to the form and is remembered; a narrow window gets the form', async () => {
    server();
    await opened();
    fireEvent.click(screen.getByRole('button', { name: 'Use the form' }));
    expect(screen.getByRole('region', { name: 'Lines' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Invoice page' })).toBeNull();
    cleanup();
    render(<DocumentEditor id="doc-1" />);
    await screen.findByRole('region', { name: 'Lines' });
    expect(screen.getByRole('button', { name: 'Edit on the page' })).toBeTruthy();
    cleanup();
    window.localStorage.clear();
    wideWindow(false);
    render(<DocumentEditor id="doc-1" />);
    await screen.findByRole('region', { name: 'Lines' });
    expect(screen.queryByRole('button', { name: 'Use the form' })).toBeNull();
  });

  it('an issued invoice is shown as its stored PDF, never drawn again', async () => {
    current = detail({ document: { status: 'issued', documentNumber: '62', issueDate: '2026-10-20' } });
    server({ 'GET /api/books/documents/doc-1/pdf': () => ({ status: 200, body: {} }) });
    render(<DocumentEditor id="doc-1" />);
    await screen.findByRole('region', { name: 'The issued PDF' });
    await waitFor(() => expect(screen.getByTestId('page').textContent).toBe(''));
    expect(renderInputs).toBe(0);
    expect(calls.some((c) => c.url === '/api/books/documents/doc-1/pdf')).toBe(true);
    await act(async () => {});
  });
});

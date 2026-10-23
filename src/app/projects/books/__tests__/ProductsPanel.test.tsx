// src/app/projects/books/__tests__/ProductsPanel.test.tsx
//
// The "Products and services" tab against a scripted /api/books/products
// server (fetch stubbed, an in-memory list with the real rules: a name unique
// among live items, case and accents ignored; archive frees it; restore
// refuses a taken name). The four stateful-flow paths at the interface:
//   1. forward: a new item is sent in cents and basis points and shown in
//      German format;
//   2. backtrack and revise: wrong fields are named under the field, tied to it
//      and focused; corrected, the item saves; a change of the price and a
//      rename onto a taken name (the server's 409 under the name) and back;
//   3. resume: a fresh mount shows what the server holds; the search ignores
//      case and accents;
//   4. re-entry: archive takes the item out and frees its name, a new item can
//      take it, restoring the old one is refused while the name is taken and
//      works once it is free again.
// All data is synthetic.

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

import { foldKey } from '@/lib/books/searchKey';

import BooksHome from '../BooksHome';
import { EMPTY_PRODUCT, productBody } from '../ProductForm';
import ProductsPanel from '../ProductsPanel';

type Json = Record<string, unknown>;
type Item = Json & { id: string; name: string; description: string | null; archivedAt: string | null };

let items: Item[];
let calls: Array<{ method: string; url: string; body: Json | null }>;
let nextId = 0;

function item(over: Partial<Item> & { name: string }): Item {
  nextId += 1;
  return {
    id: `p${nextId}`,
    kind: 'service',
    description: null,
    unitLabel: 'Std',
    unitPrice: 8000,
    priceBasis: 'net',
    taxClass: 'standard',
    discountBp: 0,
    archivedAt: null,
    createdAt: '2026-10-23T08:00:00.000Z',
    updatedAt: '2026-10-23T08:00:00.000Z',
    ...over,
  };
}

const duplicate = { status: 409, body: { error: { code: 'duplicate_product', message: 'dup', field: 'name' } } };
const taken = (name: string, except: string | null) =>
  items.some((i) => i.archivedAt === null && i.id !== except && foldKey(i.name) === foldKey(name));

function server(seed: Item[] = []) {
  items = seed;
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Json) : null;
      calls.push({ method, url, body });
      const u = new URL(url, 'http://localhost');
      const id = /^\/api\/books\/products\/([^/]+)$/.exec(u.pathname)?.[1];
      const reply = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
      if (method === 'GET' && u.pathname === '/api/books/products') {
        const words = foldKey(u.searchParams.get('q') ?? '').split(' ').filter(Boolean);
        const all = u.searchParams.get('includeArchived') === '1';
        const rows = items
          .filter((i) => all || i.archivedAt === null)
          .filter((i) => words.every((w) => foldKey(`${i.name} ${i.description ?? ''}`).includes(w)))
          .sort((a, b) => Number(a.archivedAt !== null) - Number(b.archivedAt !== null) || foldKey(a.name).localeCompare(foldKey(b.name)));
        return reply(200, { items: rows, nextCursor: null, total: rows.length });
      }
      if (method === 'POST' && u.pathname === '/api/books/products') {
        if (taken(String(body!.name), null)) return reply(duplicate.status, duplicate.body);
        const created = item(body as Item);
        items.push(created);
        return reply(201, created);
      }
      const target = items.find((i) => i.id === id);
      if (!target) return reply(404, { error: { code: 'not_found', message: 'nf' } });
      if (method === 'DELETE') {
        target.archivedAt = target.archivedAt ?? '2026-10-23T09:00:00.000Z';
        return reply(200, target);
      }
      if (method === 'PATCH' && body?.archived === false) {
        if (target.archivedAt !== null && taken(target.name, target.id)) return reply(duplicate.status, duplicate.body);
        target.archivedAt = null;
        return reply(200, target);
      }
      if (method === 'PATCH') {
        if (target.archivedAt === null && body?.name !== undefined && taken(String(body.name), target.id)) {
          return reply(duplicate.status, duplicate.body);
        }
        Object.assign(target, body);
        return reply(200, target);
      }
      return reply(404, { error: { code: 'not_found', message: 'nf' } });
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const onBlocked = vi.fn();
const list = () => screen.getByRole('list', { name: 'Products and services' });
const status = () => screen.getAllByRole('status').map((s) => s.textContent).join(' | ');

async function openNew() {
  fireEvent.click(screen.getByRole('button', { name: 'New item' }));
  return screen.getByRole('form', { name: 'New item' });
}

describe('productBody', () => {
  it('sends cents and basis points, and names every wrong field', () => {
    expect(
      productBody({ ...EMPTY_PRODUCT, name: '  Beratung ', unitPrice: '1.234,50', discount: '2,5', description: '  ' }),
    ).toEqual({
      ok: true,
      body: {
        kind: 'service',
        name: 'Beratung',
        description: null,
        unitLabel: 'Std',
        unitPrice: 123450,
        priceBasis: 'net',
        taxClass: 'standard',
        discountBp: 250,
      },
    });
    const bad = productBody({ ...EMPTY_PRODUCT, name: ' ', unitLabel: '', unitPrice: '-5', discount: '120' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(['discount', 'name', 'unitLabel', 'unitPrice']);
    const pricey = productBody({ ...EMPTY_PRODUCT, name: 'X', unitPrice: '21474836,48' });
    expect(pricey.ok).toBe(false);
    expect(productBody({ ...EMPTY_PRODUCT, name: 'X', unitPrice: '0' }).ok).toBe(true);
    expect(productBody({ ...EMPTY_PRODUCT, name: '…', unitPrice: '1' }).ok).toBe(false);
  });
});

describe('ProductsPanel', () => {
  it('forward: a new item is sent in cents and basis points and listed in German format', async () => {
    server();
    render(<ProductsPanel onBlocked={onBlocked} />);
    await screen.findByText(/No items yet/);
    const form = await openNew();
    await waitFor(() => expect(document.activeElement).toBe(within(form).getByLabelText(/^Name/)));
    fireEvent.change(within(form).getByLabelText(/^Name/), { target: { value: 'Beratung' } });
    fireEvent.change(within(form).getByLabelText(/^Description/), { target: { value: 'Workshop und Konzept' } });
    fireEvent.change(within(form).getByLabelText('Unit price (EUR)'), { target: { value: '1.234,50' } });
    fireEvent.change(within(form).getByLabelText('The price is'), { target: { value: 'gross' } });
    fireEvent.change(within(form).getByLabelText('VAT'), { target: { value: 'reduced' } });
    fireEvent.change(within(form).getByLabelText(/^Default discount/), { target: { value: '10' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add item' }));

    await waitFor(() => expect(within(list()).getByText('Beratung')).toBeTruthy());
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      kind: 'service',
      name: 'Beratung',
      description: 'Workshop und Konzept',
      unitLabel: 'Std',
      unitPrice: 123450,
      priceBasis: 'gross',
      taxClass: 'reduced',
      discountBp: 1000,
    });
    expect(list().textContent).toContain('1.234,50 € per Std gross · 7 % VAT · 10 % discount');
    expect(status()).toContain('“Beratung” was added to the list.');
    expect(screen.queryByRole('form', { name: 'New item' })).toBeNull();
    // The focus lands on the new row.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Change Beratung' }));
  });

  it('backtrack and revise: wrong fields are named, tied and focused; a change and a taken name, then back', async () => {
    server([item({ name: 'Wartung' })]);
    render(<ProductsPanel onBlocked={onBlocked} />);
    await screen.findByText('Wartung');

    const form = await openNew();
    fireEvent.change(within(form).getByLabelText('Unit price (EUR)'), { target: { value: '12,345' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add item' }));
    const name = within(form).getByLabelText(/^Name/);
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(name.getAttribute('aria-describedby')!)!.textContent).toBe('Enter a name.');
    expect(document.activeElement).toBe(name);
    const price = within(form).getByLabelText('Unit price (EUR)');
    expect(price.getAttribute('aria-invalid')).toBe('true');
    expect(price.getAttribute('aria-describedby')).toContain('-error');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    // Typing in a field clears its message; the corrected form saves.
    fireEvent.change(name, { target: { value: 'Hosting' } });
    expect(name.getAttribute('aria-invalid')).toBeNull();
    fireEvent.change(price, { target: { value: '12,50' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add item' }));
    await screen.findByText('Hosting');
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({ name: 'Hosting', unitPrice: 1250 });

    // Change the price.
    fireEvent.click(screen.getByRole('button', { name: 'Change Hosting' }));
    let edit = screen.getByRole('form', { name: 'Change “Hosting”' });
    expect((within(edit).getByLabelText('Unit price (EUR)') as HTMLInputElement).value).toBe('12,50');
    fireEvent.change(within(edit).getByLabelText('Unit price (EUR)'), { target: { value: '15' } });
    fireEvent.click(within(edit).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(list().textContent).toContain('15,00 € per Std'));
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toBe(`/api/books/products/${items.find((i) => i.name === 'Hosting')!.id}`);
    expect(patch.body).toMatchObject({ unitPrice: 1500 });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Change Hosting' }));

    // Rename onto a taken name (other case, an accent): the server's refusal is shown under the name.
    fireEvent.click(screen.getByRole('button', { name: 'Change Hosting' }));
    edit = screen.getByRole('form', { name: 'Change “Hosting”' });
    const rename = within(edit).getByLabelText(/^Name/);
    fireEvent.change(rename, { target: { value: 'WARTÚNG' } });
    fireEvent.click(within(edit).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(rename.getAttribute('aria-invalid')).toBe('true'));
    expect(document.getElementById(rename.getAttribute('aria-describedby')!)!.textContent).toMatch(/already has this name/);
    expect(document.activeElement).toBe(rename);
    // Back to its own name: saved, nothing else changed.
    fireEvent.change(rename, { target: { value: 'Hosting Pro' } });
    fireEvent.click(within(edit).getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Hosting Pro');
    expect(within(list()).getByText('Wartung')).toBeTruthy();

    // Escape cancels a form and gives the focus back.
    fireEvent.click(screen.getByRole('button', { name: 'Change Hosting Pro' }));
    fireEvent.keyDown(screen.getByRole('form', { name: 'Change “Hosting Pro”' }), { key: 'Escape' });
    expect(screen.queryByRole('form')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Change Hosting Pro' })));
  });

  it('resume: a fresh mount shows what the server holds; the search ignores case and accents', async () => {
    server([item({ name: 'Beratúng', description: 'Strategie', unitPrice: 9900 }), item({ name: 'Druck', kind: 'product', unitLabel: 'Stk' })]);
    const first = render(<ProductsPanel onBlocked={onBlocked} />);
    await screen.findByText('Beratúng');
    first.unmount();

    render(<ProductsPanel onBlocked={onBlocked} />);
    await screen.findByText('Druck');
    expect(list().textContent).toContain('99,00 € per Std net');
    expect(list().textContent).toContain('Product · 80,00 € per Stk');

    vi.useFakeTimers();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'BERATUNG strat' } });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    vi.useRealTimers();
    await waitFor(() => expect(screen.queryByText('Druck')).toBeNull());
    expect(within(list()).getByText('Beratúng')).toBeTruthy();
    expect(calls.at(-1)!.url).toBe('/api/books/products?q=BERATUNG+strat');

    vi.useFakeTimers();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'nichts' } });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    vi.useRealTimers();
    await screen.findByText('No item matches this search.');
  });

  it('re-entry: archive frees the name, a new item takes it, restore is refused until the name is free', async () => {
    server([item({ name: 'Wartung' })]);
    render(<ProductsPanel onBlocked={onBlocked} />);
    await screen.findByText('Wartung');

    fireEvent.click(screen.getByRole('button', { name: 'Archive Wartung' }));
    await screen.findByText(/No items yet/);
    expect(status()).toContain('“Wartung” was archived. Drafts that used it keep their lines.');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'New item' }));

    // The name is free: a new item takes it.
    const form = await openNew();
    fireEvent.change(within(form).getByLabelText(/^Name/), { target: { value: 'wartung' } });
    fireEvent.change(within(form).getByLabelText('Unit price (EUR)'), { target: { value: '50' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add item' }));
    await screen.findByText('wartung');

    // Shown with the archived ones (live first), the old one cannot come back while the name is taken.
    fireEvent.click(screen.getByLabelText('Show archived'));
    await screen.findByText('Wartung');
    const rows = within(list()).getAllByRole('listitem');
    expect(rows[0].textContent).toContain('wartung');
    expect(rows[1].textContent).toContain('Archived');
    fireEvent.click(screen.getByRole('button', { name: 'Restore Wartung' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toMatch(/already has this name/);

    // Archive the new one: still listed (with archived ones shown), focus on its Restore.
    fireEvent.click(screen.getByRole('button', { name: 'Archive wartung' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Restore wartung' })));
    fireEvent.click(screen.getByRole('button', { name: 'Restore Wartung' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Archive Wartung' })).toBeTruthy());
    expect(status()).toContain('“Wartung” was restored.');
    expect(calls.filter((c) => c.method === 'PATCH').every((c) => JSON.stringify(c.body) === '{"archived":false}')).toBe(true);
  });
});

describe('BooksHome', () => {
  it('has a Products and services tab that opens the list', async () => {
    server([item({ name: 'Beratung' })]);
    const fetchList = globalThis.fetch as ReturnType<typeof vi.fn>;
    const inner = fetchList.getMockImplementation()!;
    fetchList.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/books/settings') {
        return new Response(JSON.stringify({ initialised: true, settings: null, counters: [] }), { status: 200 });
      }
      if (url.startsWith('/api/books/documents') || url.startsWith('/api/books/customers')) {
        return new Response(JSON.stringify({ items: [], nextCursor: null, total: 0 }), { status: 200 });
      }
      return inner(url, init);
    });
    render(<BooksHome initialTab="documents" />);
    fireEvent.click(screen.getByRole('button', { name: 'Products and services' }));
    expect(await screen.findByText('Beratung')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Products and services' }).getAttribute('aria-pressed')).toBe('true');
  });
});

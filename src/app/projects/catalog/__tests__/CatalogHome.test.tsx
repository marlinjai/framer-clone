// src/app/projects/catalog/__tests__/CatalogHome.test.tsx
//
// The catalogue area against a scripted /api/catalog server (fetch stubbed),
// the four stateful-flow paths at the interface:
//   1. forward: the empty state adds the sample products; an inline price is
//      sent in cents and the server's figure is shown;
//   2. backtrack and revise: the options editor sends the ids of what exists
//      (a rename keeps its variant) and shows the regenerated variants;
//   3. resume: a product named in the address opens with what the server
//      stored; the filters in the address are what the list asks for;
//   4. re-entry: a refused save shows the server's sentence and keeps the
//      stored value; archive then unarchive; undo puts the last step back.
// Plus the empty state, a locked stock cell with its reason, the remembered
// columns and the page that replaces the area when the company may not use it.
// All data is synthetic.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import CatalogHome from '../CatalogHome';
import { columnsKey } from '../state';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
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
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Json) : null;
      calls.push({ method, url, body });
      const path = url.split('?')[0];
      const handler = routes[`${method} ${path}`];
      if (!handler) return new Response(JSON.stringify({ error: { code: 'not_found', message: 'not scripted' } }), { status: 404 });
      const res = handler(body, url);
      return new Response(JSON.stringify(res.body), { status: res.status });
    }),
  );
}

function listItem(over: Json = {}): Json {
  return {
    id: 'p1',
    title: 'Pearl necklace',
    handle: 'pearl-necklace',
    kind: 'physical',
    status: 'draft',
    productType: 'Necklace',
    variantCount: 1,
    priceMin: 12900,
    priceMax: 12900,
    stock: 5,
    image: null,
    collections: [],
    single: { id: 'v1', sku: 'PEARL-1', price: 12900, manageInventory: true, stock: 5 },
    updatedAt: '2026-10-26T08:00:00.000Z',
    ...over,
  };
}

function detail(over: Json = {}): Json {
  return {
    id: 'p1',
    title: 'Pearl necklace',
    handle: 'pearl-necklace',
    kind: 'physical',
    status: 'draft',
    publishStatus: 'draft',
    productType: 'Necklace',
    tags: [],
    description: null,
    descriptionFormat: null,
    taxClass: 'standard',
    priceBasis: 'gross',
    unitLabel: 'Stk',
    discountBp: 0,
    seoTitle: null,
    seoDescription: null,
    archivedAt: null,
    createdAt: '2026-10-26T08:00:00.000Z',
    updatedAt: '2026-10-26T08:00:00.000Z',
    options: [],
    variants: [
      { id: 'v1', title: null, sku: 'PEARL-1', barcode: null, price: 12900, compareAt: null, manageInventory: true, allowBackorder: false, stock: 5, imageId: null, values: [] },
    ],
    images: [],
    collections: [],
    hiddenSiteIds: [],
    ...over,
  };
}

const META = { sites: [{ id: 'site-1', name: 'Shop' }], productTypes: ['Necklace'] };
const base = (list: () => Json[]): Record<string, Handler> => ({
  'GET /api/catalog/products': () => ({ status: 200, body: { items: list(), total: list().length, nextCursor: null } }),
  'GET /api/catalog/collections': () => ({ status: 200, body: { items: [] } }),
  'GET /api/catalog/meta': () => ({ status: 200, body: META }),
});

beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    // jsdom always has storage; the guard mirrors the component's
  }
  window.history.replaceState(null, '', '/projects/catalog');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the table', () => {
  it('empty state, then the samples (forward), then an inline price in cents', async () => {
    let items: Json[] = [];
    server({
      ...base(() => items),
      'POST /api/catalog/products/samples': () => {
        items = [listItem(), listItem({ id: 'p2', title: 'Stacking ring', variantCount: 6, priceMin: 4900, priceMax: 8900, stock: 17, single: null })];
        return { status: 200, body: { items: [] } };
      },
      'PATCH /api/catalog/products/p1': (body) => {
        items = items.map((i) => (i.id === 'p1' ? listItem({ priceMin: body!.price, priceMax: body!.price, single: { ...i.single, price: body!.price } }) : i));
        return { status: 200, body: detail() };
      },
    });
    render(<CatalogHome />);
    expect(await screen.findByRole('heading', { name: 'No products yet' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Add product' }).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Add sample products' }));
    expect(await screen.findByRole('button', { name: 'Stacking ring' })).toBeTruthy();
    expect(screen.getByText('49,00 € to 89,00 €')).toBeTruthy();

    // A product with several variants cannot be priced inline; it says why.
    expect(screen.queryByRole('button', { name: 'Price of Stacking ring: edit' })).toBeNull();
    expect(screen.getByText(/Several variants: set their prices in the panel/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Price of Pearl necklace: edit' }));
    const input = screen.getByRole('textbox', { name: 'Price of Pearl necklace' });
    fireEvent.change(input, { target: { value: '99,50' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByText('99,50 €')).toBeTruthy());
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ price: 9950 });
  });

  it('locks the stock cell of a variant without a SKU and refuses a bad number before sending', async () => {
    const items = [listItem({ single: { id: 'v1', sku: null, price: 100, manageInventory: true, stock: 0 }, stock: 0 }), listItem({ id: 'p3', title: 'Gift wrap' })];
    server(base(() => items));
    render(<CatalogHome />);
    await screen.findByRole('button', { name: 'Gift wrap' });
    expect(screen.getByText(/Add a SKU in the panel to track stock/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stock of Gift wrap: edit' }));
    const input = screen.getByRole('textbox', { name: 'Stock of Gift wrap' });
    fireEvent.change(input, { target: { value: '-2' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText('Enter whole units, 0 or more')).toBeTruthy();
    expect(calls.some((c) => c.url.includes('/stock'))).toBe(false);
  });

  it('asks for the filters in the address (resume) and keeps them there when they change', async () => {
    server(base(() => [listItem()]));
    render(<CatalogHome initialQuery="status=published&stock=in_stock&q=pearl" />);
    await screen.findByRole('button', { name: 'Pearl necklace' });
    const first = calls.find((c) => c.url.startsWith('/api/catalog/products'))!;
    expect(first.url).toContain('q=pearl');
    expect(first.url).toContain('status=published');
    expect(first.url).toContain('stock=in_stock');

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'archived' } });
    await waitFor(() => expect(window.location.search).toContain('status=archived'));
    await waitFor(() => expect(calls.some((c) => c.url.includes('status=archived'))).toBe(true));
  });

  it('bulk archives the selection, all or nothing, and shows a refusal', async () => {
    let refuse = true;
    server({
      ...base(() => [listItem(), listItem({ id: 'p2', title: 'Ring' })]),
      'POST /api/catalog/products/bulk': () =>
        refuse
          ? { status: 404, body: { error: { code: 'not_found', message: 'not found for this company; it may have been removed (reload the list)' } } }
          : { status: 200, body: { changed: 2 } },
    });
    render(<CatalogHome />);
    await screen.findByRole('button', { name: 'Ring' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select every product on this page' }));
    const bar = screen.getByRole('toolbar', { name: 'Bulk actions' });
    expect(within(bar).getByText('2 selected')).toBeTruthy();
    fireEvent.click(within(bar).getByRole('button', { name: 'Archive' }));
    expect(await screen.findByText(/it may have been removed/)).toBeTruthy();
    refuse = false;
    fireEvent.click(within(screen.getByRole('toolbar', { name: 'Bulk actions' })).getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(screen.queryByRole('toolbar', { name: 'Bulk actions' })).toBeNull());
    expect(calls.filter((c) => c.url.endsWith('/bulk')).at(-1)!.body).toEqual({ action: 'archive', ids: ['p1', 'p2'] });
  });

  it('remembers the shown columns per person, and works when storage refuses', async () => {
    server(base(() => [listItem()]));
    const { unmount } = render(<CatalogHome />);
    await screen.findByRole('button', { name: 'Pearl necklace' });
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Columns shown' })).getByRole('checkbox', { name: 'Type' }));
    expect(screen.queryByRole('columnheader', { name: 'Type' })).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(columnsKey('me'))!)).not.toContain('type');
    unmount();

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    render(<CatalogHome />);
    await screen.findByRole('button', { name: 'Pearl necklace' });
    expect(screen.getByRole('columnheader', { name: 'Type' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Columns shown' })).getByRole('checkbox', { name: 'Type' }));
    expect(screen.queryByRole('columnheader', { name: 'Type' })).toBeNull();
  });

  it('replaces the area with a page when the company may not use it', async () => {
    server({
      ...base(() => []),
      'GET /api/catalog/products': () => ({ status: 403, body: { error: { code: 'sites_not_enabled', message: 'x' } } }),
    });
    render(<CatalogHome />);
    expect(await screen.findByText(/Lumitra Sites is not enabled for this company/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to projects' })).toBeTruthy();
  });
});

describe('the panel', () => {
  it('resume: a product in the address opens with what the server stored', async () => {
    server({ ...base(() => [listItem()]), 'GET /api/catalog/products/p1': () => ({ status: 200, body: detail({ title: 'Stored title', tags: ['pearls'] }) }) });
    render(<CatalogHome initialQuery="product=p1" />);
    const panel = await screen.findByRole('dialog', { name: 'Stored title' });
    expect((within(panel).getByLabelText('Title') as HTMLInputElement).value).toBe('Stored title');
    expect((within(panel).getByLabelText('Tags') as HTMLInputElement).value).toBe('pearls');
    fireEvent.click(within(panel).getByRole('button', { name: 'Close the panel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(window.location.search).not.toContain('product=');
  });

  it('re-entry: a refused save keeps the stored value; undo puts the last step back; archive and unarchive', async () => {
    let current = detail();
    server({
      ...base(() => [listItem()]),
      'GET /api/catalog/products/p1': () => ({ status: 200, body: current }),
      'PATCH /api/catalog/products/p1': (body) => {
        if (body!.handle === 'taken') {
          return { status: 409, body: { error: { code: 'duplicate_handle', message: 'another product of this company uses this URL handle; choose another one (nothing was saved)' } } };
        }
        if ('archived' in body!) current = detail({ ...current, status: body!.archived ? 'archived' : 'draft', archivedAt: body!.archived ? '2026-10-26T09:00:00.000Z' : null });
        else current = { ...current, ...body };
        return { status: 200, body: current };
      },
    });
    render(<CatalogHome initialQuery="product=p1" />);
    const panel = await screen.findByRole('dialog', { name: 'Pearl necklace' });

    const handle = within(panel).getByLabelText('URL handle') as HTMLInputElement;
    fireEvent.change(handle, { target: { value: 'taken' } });
    fireEvent.blur(handle);
    expect(await within(panel).findByText(/uses this URL handle/)).toBeTruthy();
    fireEvent.keyDown(handle, { key: 'Escape' });
    expect(handle.value).toBe('pearl-necklace');

    const title = within(panel).getByLabelText('Title') as HTMLInputElement;
    fireEvent.change(title, { target: { value: 'Pearl choker' } });
    fireEvent.blur(title);
    await within(screen.getByRole('dialog')).findByRole('heading', { name: 'Pearl choker' });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Undo/ }));
    await within(screen.getByRole('dialog')).findByRole('heading', { name: 'Pearl necklace' });
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([{ handle: 'taken' }, { title: 'Pearl choker' }, { title: 'Pearl necklace' }]);

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Archive' }));
    expect(await within(screen.getByRole('dialog')).findByRole('button', { name: 'Unarchive' })).toBeTruthy();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Unarchive' }));
    expect(await within(screen.getByRole('dialog')).findByRole('button', { name: 'Archive' })).toBeTruthy();
  });

  it('backtrack and revise: the options editor sends the ids of what exists and shows the new variants', async () => {
    let current = detail({
      options: [{ id: 'o1', title: 'Size', values: [{ id: 'a', value: '52' }, { id: 'b', value: '54' }] }],
      variants: [
        { id: 'v52', title: '52', sku: 'R-52', barcode: null, price: 4900, compareAt: null, manageInventory: true, allowBackorder: false, stock: 2, imageId: null, values: [{ optionId: 'o1', valueId: 'a' }] },
        { id: 'v54', title: '54', sku: 'R-54', barcode: null, price: 5900, compareAt: null, manageInventory: true, allowBackorder: false, stock: 4, imageId: null, values: [{ optionId: 'o1', valueId: 'b' }] },
      ],
    });
    server({
      ...base(() => [listItem()]),
      'GET /api/catalog/products/p1': () => ({ status: 200, body: current }),
      'PUT /api/catalog/products/p1/options': () => {
        current = {
          ...current,
          options: [{ id: 'o1', title: 'Size', values: [{ id: 'b', value: '54 mm' }] }],
          variants: [{ ...current.variants[1], title: '54 mm' }],
        };
        return { status: 200, body: current };
      },
    });
    render(<CatalogHome initialQuery="product=p1" />);
    const panel = await screen.findByRole('dialog', { name: 'Pearl necklace' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Remove the value 52' }));
    fireEvent.change(within(panel).getAllByRole('textbox', { name: 'Value of Size' })[0], { target: { value: '54 mm' } });
    expect(within(panel).getByText(/Saving removes 1 variant/)).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: 'Save options (1 variant)' }));
    await waitFor(() => expect(within(screen.getByRole('dialog')).getByText('54 mm')).toBeTruthy());
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ options: [{ id: 'o1', title: 'Size', values: [{ id: 'b', value: '54 mm' }] }] });
    // The kept variant shows its stored figures.
    expect((within(screen.getByRole('dialog')).getByLabelText('Stock') as HTMLInputElement).value).toBe('4');
  });

  it('says so when the product is not the company any more', async () => {
    server(base(() => []));
    render(<CatalogHome initialQuery="product=gone" />);
    expect(await screen.findByText(/not in this company's catalogue any more/)).toBeTruthy();
  });
});

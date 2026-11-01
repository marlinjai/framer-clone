// A product page shows a real product while designing: the first in the
// catalogue, or the chosen one, on product pages only.
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, waitFor } from '@testing-library/react';
import { CommerceDataSourceContext } from '../context';
import type { CommerceDataSource } from '../provider';
import { ProductPreviewProvider, useProductPageParams } from '../productPreview';
import { ProductPreviewPicker } from '@/components/ProductPreviewBar';

afterEach(cleanup);

const source = (listProducts: () => Promise<unknown>) =>
  ({ listProducts, subscribe: () => () => {} }) as unknown as CommerceDataSource;
const catalogue = () =>
  Promise.resolve({
    products: [
      { handle: 'ring', title: 'Ring' },
      { handle: 'chain', title: 'Chain' },
    ],
    total: 2,
  });

function Params({ slug }: { slug: string }) {
  return <span data-testid="params">{JSON.stringify(useProductPageParams(slug))}</span>;
}

function setup({
  ds = source(catalogue),
  enabled = true,
  chosenHandle,
  slug = 'products/:handle',
  onChoose = () => {},
}: {
  ds?: CommerceDataSource;
  enabled?: boolean;
  chosenHandle?: string;
  slug?: string;
  onChoose?: (handle: string) => void;
}) {
  return render(
    <CommerceDataSourceContext.Provider value={ds}>
      <ProductPreviewProvider enabled={enabled} chosenHandle={chosenHandle} onChoose={onChoose}>
        <Params slug={slug} />
        <ProductPreviewPicker slug={slug} tone="light" />
      </ProductPreviewProvider>
    </CommerceDataSourceContext.Provider>,
  );
}

const params = () => screen.getByTestId('params').textContent;

describe('product preview', () => {
  it('shows the first product by default', async () => {
    setup({});
    await waitFor(() => expect(params()).toBe('{"handle":"ring"}'));
    expect((screen.getByLabelText('Product to show') as HTMLSelectElement).value).toBe('ring');
  });

  it('shows the chosen product and reports a new choice', async () => {
    const onChoose = vi.fn();
    setup({ chosenHandle: 'chain', onChoose });
    await waitFor(() => expect(params()).toBe('{"handle":"chain"}'));
    const picker = screen.getByLabelText('Product to show') as HTMLSelectElement;
    picker.value = 'ring';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onChoose).toHaveBeenCalledWith('ring');
  });

  it('falls back to the first product when the chosen one left the catalogue', async () => {
    setup({ chosenHandle: 'gone' });
    await waitFor(() => expect(params()).toBe('{"handle":"ring"}'));
  });

  it('gives any other page no params and no picker', async () => {
    setup({ slug: 'about' });
    await waitFor(() => expect(screen.queryByLabelText('Product to show')).toBeNull());
    expect(params()).toBe('{}');
  });

  it('does not read the catalogue for a project without a product page', async () => {
    const listProducts = vi.fn(catalogue);
    setup({ ds: source(listProducts), enabled: false });
    expect(params()).toBe('{}');
    expect(listProducts).not.toHaveBeenCalled();
  });

  it('says so when the catalogue is empty', async () => {
    setup({ ds: source(() => Promise.resolve({ products: [], total: 0 })) });
    await screen.findByText(/No published products yet/);
    expect(params()).toBe('{}');
  });

  it('surfaces a failed read with its message', async () => {
    setup({ ds: source(() => Promise.reject(new Error('kaput'))) });
    expect((await screen.findByRole('alert')).textContent).toContain('kaput');
    expect(params()).toBe('{}');
  });
});

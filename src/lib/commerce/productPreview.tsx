// A product page (`products/:handle`) is a template: on the published site the
// address names the product, in the editor and its preview nothing does. So the
// editor shows a real one, by default the first in the catalogue, and the person
// designing can switch to another. The choice lives in the editor session only
// (editorUI.previewProductHandle): it is never saved with the project and never
// reaches the published page.
'use client';

import React from 'react';
import { CommerceDataSourceContext } from './context';
import { isProductPageSlug } from '@/lib/pages/slug';

export type ProductPreviewValue =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      products: ReadonlyArray<{ handle: string; title: string }>;
      /** The product shown, or null with an empty catalogue. */
      handle: string | null;
      choose: (handle: string) => void;
    };

const ProductPreviewContext = React.createContext<ProductPreviewValue | null>(null);
ProductPreviewContext.displayName = 'ProductPreviewContext';

type Loaded =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; products: ReadonlyArray<{ handle: string; title: string }> };

/** Inside the commerce data source. Reads the catalogue only for a project with a product page. */
export function ProductPreviewProvider({
  enabled,
  chosenHandle,
  onChoose,
  children,
}: {
  enabled: boolean;
  chosenHandle: string | undefined;
  onChoose: (handle: string) => void;
  children: React.ReactNode;
}) {
  const dataSource = React.useContext(CommerceDataSourceContext);
  const [loaded, setLoaded] = React.useState<Loaded>({ status: 'loading' });

  React.useEffect(() => {
    if (!enabled || !dataSource) return;
    let active = true;
    // Only the latest request may write: an older, slower response must not replace a newer one.
    let latestRequest = 0;
    const load = () => {
      const request = ++latestRequest;
      dataSource
        .listProducts()
        .then((page) => {
          if (active && request === latestRequest) {
            setLoaded({
              status: 'ready',
              products: page.products.map((p) => ({ handle: p.handle, title: p.title })),
            });
          }
        })
        .catch((err: unknown) => {
          if (active && request === latestRequest) {
            setLoaded({ status: 'error', message: err instanceof Error ? err.message : String(err) });
          }
        });
    };
    setLoaded({ status: 'loading' });
    load();
    // The catalogue can change while the editor stays open (a product deleted or renamed):
    // re-read it so a chosen product that left falls back to the first one.
    const unsubscribe = dataSource.subscribe(null, load);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [enabled, dataSource]);

  const value = React.useMemo<ProductPreviewValue | null>(() => {
    if (!enabled) return null;
    if (loaded.status !== 'ready') return loaded;
    // A chosen product that left the catalogue falls back to the first.
    const chosen = loaded.products.find((p) => p.handle === chosenHandle);
    return {
      status: 'ready',
      products: loaded.products,
      handle: chosen?.handle ?? loaded.products[0]?.handle ?? null,
      choose: onChoose,
    };
  }, [enabled, loaded, chosenHandle, onChoose]);

  return <ProductPreviewContext.Provider value={value}>{children}</ProductPreviewContext.Provider>;
}

/** Null outside the editor and its preview, and for a project without a product page. */
export function useProductPreview(): ProductPreviewValue | null {
  return React.useContext(ProductPreviewContext);
}

const NO_PARAMS: Record<string, string> = {};

/** The route params for a page on the canvas or in the preview: the shown product on a product page, otherwise none. */
export function useProductPageParams(slug: string | undefined): Record<string, string> {
  const preview = useProductPreview();
  const handle = preview?.status === 'ready' ? preview.handle : null;
  return React.useMemo(
    () => (handle && slug !== undefined && isProductPageSlug(slug) ? { handle } : NO_PARAMS),
    [handle, slug],
  );
}

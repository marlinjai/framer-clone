'use client';
// src/components/ProductPreviewBar.tsx
//
// Which product a product page shows while designing (src/lib/commerce/productPreview.tsx):
// a small bar in the editor's notice stack, and the same picker in the preview's
// toolbar. Renders nothing on any other page. A catalogue that is empty or could
// not be read says so here, because the canvas alone would only read
// "no product selected".

import React from 'react';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';
import { useProductPreview } from '@/lib/commerce/productPreview';
import { isProductPageSlug } from '@/lib/pages/slug';

const TONES = {
  light: {
    select: 'min-w-0 max-w-[220px] rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-900',
    text: 'text-xs text-gray-600',
    error: 'text-xs text-red-700',
  },
  dark: {
    select: 'min-w-0 max-w-[220px] max-md:max-w-[120px] bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-100',
    text: 'text-xs text-gray-400',
    error: 'text-xs text-red-300',
  },
} as const;

export function ProductPreviewPicker({ slug, tone }: { slug: string; tone: keyof typeof TONES }) {
  const preview = useProductPreview();
  if (!preview || preview.status === 'loading' || !isProductPageSlug(slug)) return null;
  const classes = TONES[tone];

  if (preview.status === 'error') {
    return <span role="alert" className={classes.error}>Products could not be loaded: {preview.message}</span>;
  }
  if (preview.handle === null) {
    return <span className={classes.text}>No published products yet: publish one in the catalogue to see it here.</span>;
  }
  return (
    <select
      aria-label="Product to show"
      title="Product to show"
      value={preview.handle}
      onChange={(e) => preview.choose(e.target.value)}
      className={classes.select}
    >
      {preview.products.map((p) => (
        <option key={p.handle} value={p.handle}>
          {p.title}
        </option>
      ))}
    </select>
  );
}

const ProductPreviewBar = observer(() => {
  const { editorUI } = useStore();
  const preview = useProductPreview();
  const slug = editorUI.currentPage?.slug;
  if (slug === undefined || !preview || preview.status === 'loading' || !isProductPageSlug(slug)) return null;
  return (
    <div
      data-editor-ui="true"
      className="pointer-events-auto flex max-w-[640px] items-center gap-2 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-700 shadow"
    >
      <span className="shrink-0">Showing</span>
      <ProductPreviewPicker slug={slug} tone="light" />
    </div>
  );
});

export default ProductPreviewBar;

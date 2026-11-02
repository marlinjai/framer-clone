// CommercePageProviders: the single client provider shell wrapping a published
// page's body so its commerce islands hydrate against same-origin reads.
//
// Mounted ONCE by the public RSC route around the whole server-rendered tree
// (mirrors PreviewShell lines ~99-100). It provides:
//   - CommerceDataSourceContext = the shared HTTP commerce data source, so the
//     islands' reads hit same-origin /api/commerce/* and checkout POSTs to
//     /api/commerce/orders (the data source is constructed with a relative base
//     URL, i.e. same-origin, by default).
//   - CartProvider = ONE client cart shared across every island on the page, so
//     an add-to-cart in one island is reflected by a cart-view / checkout-button
//     elsewhere on the same page (a per-island cart would not share state).
//
// The server-rendered body is passed through as `children`: a server subtree
// handed to a client component, which is the standard RSC island composition.
'use client';

import React from 'react';
import { CommerceDataSourceContext } from '@/lib/commerce/context';
import { getSharedHttpCommerceDataSource } from '@/lib/commerce/httpCommerceDataSource';
import { CartProvider } from '@/lib/commerce/cart';
import { shopLocaleOf } from '@/lib/commerce/parts';
import { ShopLocaleContext } from '@/lib/commerce/shopRuntime';

export interface CommercePageProvidersProps {
  children: React.ReactNode;
  /** The site language: the shop controls speak it (their fixed notices and default texts). */
  language?: string;
}

export default function CommercePageProviders({ children, language }: CommercePageProvidersProps) {
  return (
    <CommerceDataSourceContext.Provider value={getSharedHttpCommerceDataSource()}>
      <ShopLocaleContext.Provider value={shopLocaleOf(language)}>
        <CartProvider>{children}</CartProvider>
      </ShopLocaleContext.Provider>
    </CommerceDataSourceContext.Provider>
  );
}

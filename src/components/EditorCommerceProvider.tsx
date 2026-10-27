'use client';

// src/components/EditorCommerceProvider.tsx
//
// Mounts the commerce data source for the EDITOR and its preview. The editor is
// not a published storefront, so it must not use the host-resolved storefront
// routes (its host is the editor host, or localhost in dev, and those routes
// would answer 403). Instead it reads through the per-project editor routes
// (/api/projects/<projectId>/commerce/*), which authorize the signed-in
// auth-brain session against that project's workspace and read ONLY the
// project's own tenant schema (never a shared one).
//
// The project id comes from the editor store's current project (the MT-10
// route /projects/<id> hydrates it from the server-loaded snapshot). A project
// that does not exist server-side (the unsaved demo project of the standalone
// `/` dev mount) is answered with a 403 by the server, which the commerce
// components surface as an error rather than as data.
//
// It also holds the project's cart, so the add-to-cart, cart and checkout
// blocks render on the canvas and work in the preview. The cart persists per
// project (every project shares the editor's host) and is remounted when the
// project changes, so one shop's lines never show in another shop's cart. Checkout itself is disabled here with
// a clear message: the order route resolves a published storefront from the request host, which the editor is not.

import React from 'react';
import { observer } from 'mobx-react-lite';

import { CartProvider, CheckoutUnavailableContext, editorCartStorageKey } from '@/lib/commerce/cart';
import { CommerceDataSourceContext } from '@/lib/commerce/context';
import { getEditorCommerceDataSource } from '@/lib/commerce/httpCommerceDataSource';
import { useStore } from '@/hooks/useStore';

const NO_PROJECT_ID = '__no_project__';
const CHECKOUT_PREVIEW_MESSAGE =
  'Checkout is not available in the editor preview. Publish the site to place an order.';

const EditorCommerceProvider = observer(({ children }: { children: React.ReactNode }) => {
  const rootStore = useStore();
  const projectId = rootStore.editorUI.currentProject?.id ?? NO_PROJECT_ID;
  return (
    <CommerceDataSourceContext.Provider value={getEditorCommerceDataSource(projectId)}>
      <CartProvider key={projectId} storageKey={editorCartStorageKey(projectId)}>
        <CheckoutUnavailableContext.Provider value={CHECKOUT_PREVIEW_MESSAGE}>{children}</CheckoutUnavailableContext.Provider>
      </CartProvider>
    </CommerceDataSourceContext.Provider>
  );
});

export default EditorCommerceProvider;

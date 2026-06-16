// React context + hook for the active CommerceDataSource.
//
// Mirrors src/lib/bindings/dataSource/context.tsx (the CMS seam): storefront
// components call useCommerceDataSource() rather than importing a concrete
// provider, so the implementation can be swapped at the root (in-memory double
// today, commerce HTTP client tomorrow) without touching consumer code. This
// is a SECOND seam alongside DataSourceProvider; the CMS seam is unchanged.
'use client';

import { createContext, useContext } from 'react';
import type { CommerceDataSource } from './provider';

export const CommerceDataSourceContext =
  createContext<CommerceDataSource | null>(null);
CommerceDataSourceContext.displayName = 'CommerceDataSourceContext';

/**
 * Returns the active CommerceDataSource. Throws if used outside a provider:
 * we'd rather fail loudly than silently resolve no commerce data.
 */
export function useCommerceDataSource(): CommerceDataSource {
  const ctx = useContext(CommerceDataSourceContext);
  if (!ctx) {
    throw new Error(
      'useCommerceDataSource must be used within a CommerceDataSourceContext.Provider. ' +
        'Wrap your storefront tree with a provider value.',
    );
  }
  return ctx;
}

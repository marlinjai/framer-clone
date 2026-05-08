// React context + hook for the active DataSourceProvider.
//
// The renderer + binding picker use `useDataSource()` rather than importing
// a concrete provider so the implementation can be swapped at the root
// (in-memory mock today, cms HTTP client tomorrow) without touching consumer
// code.
'use client';

import { createContext, useContext } from 'react';
import type { DataSourceProvider } from './provider';

export const DataSourceProviderContext =
  createContext<DataSourceProvider | null>(null);
DataSourceProviderContext.displayName = 'DataSourceProviderContext';

/**
 * Returns the active DataSourceProvider. Throws if used outside a provider —
 * we'd rather fail loudly than silently render no data.
 */
export function useDataSource(): DataSourceProvider {
  const ctx = useContext(DataSourceProviderContext);
  if (!ctx) {
    throw new Error(
      'useDataSource must be used within a DataSourceProviderContext.Provider. ' +
        'Wrap your component tree (e.g. EditorApp / PreviewShell) with a provider value.',
    );
  }
  return ctx;
}

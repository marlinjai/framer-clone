import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import React from 'react';
import { DataSourceProviderContext, useDataSource } from '../context';
import { InMemoryDataSourceProvider } from '../inMemoryProvider';

describe('useDataSource', () => {
  // Suppress the React-thrown-error noise renderHook prints to stderr when
  // the hook throws. We're asserting the error directly.
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('throws when used outside a provider', () => {
    expect(() => renderHook(() => useDataSource())).toThrow(
      /DataSourceProviderContext/,
    );
  });

  it('returns the provider when wrapped', () => {
    const provider = new InMemoryDataSourceProvider();
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(
        DataSourceProviderContext.Provider,
        { value: provider },
        children,
      );
    const { result } = renderHook(() => useDataSource(), { wrapper });
    expect(result.current).toBe(provider);
  });
});

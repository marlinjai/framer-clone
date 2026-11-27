import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import CollectionSettingsDialog from '../CollectionSettingsDialog';
import type { Collection } from '@/lib/bindings/dataSource/types';

afterEach(cleanup);

describe('collection settings icon picker', () => {
  it('outlines only the selected icon in forced colours, where the ring and the wash are dropped', () => {
    const collection = { id: 'c1', name: 'Posts', slug: 'posts' } as unknown as Collection;
    render(<CollectionSettingsDialog collection={collection} busy={false} onClose={vi.fn()} onSave={vi.fn()} />);
    const [first, second] = screen.getAllByRole('button', { name: /^Icon / });
    fireEvent.click(first);
    expect(first.className).toContain('forced-colors:outline-2');
    expect(second.className).not.toContain('forced-colors:');
  });
});
// ci-replay touch

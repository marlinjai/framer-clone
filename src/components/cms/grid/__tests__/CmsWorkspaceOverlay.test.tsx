import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';

// CmsWorkspaceOverlay renders into a portal (document.body) and pulls in
// CmsGrid (server-only + Prisma). Stub both so the test stays headless.
vi.mock('../CmsGrid', () => ({
  default: ({ tableId }: { tableId: string }) =>
    React.createElement('div', { 'data-testid': `cms-grid-stub-${tableId}` }),
}));

vi.mock('../../CollectionRail', () => ({
  default: () => React.createElement('div', { 'data-testid': 'collection-rail-stub' }),
}));

// createPortal normally needs a live document.body. In JSDOM the body exists,
// but React's createPortal won't render into it during testing unless we shim
// it. The simplest workaround: mock createPortal to render children inline.
vi.mock('react-dom', async (orig) => {
  const actual = await orig<typeof import('react-dom')>();
  return {
    ...actual,
    createPortal: (children: React.ReactNode) => children,
  };
});

vi.mock('lucide-react', () => {
  const Icon = () => React.createElement('span', { 'data-testid': 'icon' });
  return {
    X: Icon,
    Upload: Icon,
    Database: Icon,
    ChevronDown: Icon,
  };
});

vi.mock('../../collectionIcon', () => ({
  resolveCollectionIcon: () =>
    function StubIcon() {
      return React.createElement('span', { 'data-testid': 'collection-icon' });
    },
}));

import CmsWorkspaceOverlay from '../CmsWorkspaceOverlay';
import type { Collection } from '@/lib/bindings/dataSource/types';

function makeCollection(overrides: Partial<Collection> = {}): Collection {
  return {
    id: 'col_events',
    slug: 'events',
    name: 'Events',
    columns: [],
    ...overrides,
  };
}

function makeProps(overrides: Partial<React.ComponentProps<typeof CmsWorkspaceOverlay>> = {}) {
  return {
    collections: [makeCollection()],
    activeId: 'col_events',
    busy: false,
    onSetActive: vi.fn(),
    onCreate: vi.fn(),
    onRename: vi.fn(),
    onUpdate: vi.fn(),
    onDelete: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

afterEach(() => cleanup());

describe('CmsWorkspaceOverlay header item count', () => {
  it('renders "1 item" (singular) when itemCount is 1', () => {
    const col = makeCollection({ itemCount: 1 });
    render(<CmsWorkspaceOverlay {...makeProps({ collections: [col] })} />);
    const chip = screen.getByTestId('workspace-item-count');
    expect(chip.textContent?.trim()).toBe('1 item');
  });

  it('renders "0 items" (plural) when itemCount is 0', () => {
    const col = makeCollection({ itemCount: 0 });
    render(<CmsWorkspaceOverlay {...makeProps({ collections: [col] })} />);
    const chip = screen.getByTestId('workspace-item-count');
    expect(chip.textContent?.trim()).toBe('0 items');
  });

  it('renders "12 items" (plural) when itemCount > 1', () => {
    const col = makeCollection({ itemCount: 12 });
    render(<CmsWorkspaceOverlay {...makeProps({ collections: [col] })} />);
    const chip = screen.getByTestId('workspace-item-count');
    expect(chip.textContent?.trim()).toBe('12 items');
  });

  it('renders no count chip when itemCount is undefined', () => {
    const col = makeCollection(); // no itemCount
    render(<CmsWorkspaceOverlay {...makeProps({ collections: [col] })} />);
    expect(screen.queryByTestId('workspace-item-count')).toBeNull();
  });
});

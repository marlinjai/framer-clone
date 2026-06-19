import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import CollectionRail from '../CollectionRail';
import type { Collection } from '@/lib/bindings/dataSource/types';

// Lucide icons pull in SVG - keep them as lightweight stubs so JSDOM doesn't
// need real SVG rendering. Each named export must be explicitly listed so the
// module mock does not need a Proxy (which can cause "no export defined" errors
// in vitest's static mock resolution).
vi.mock('lucide-react', () => {
  const Icon = () => React.createElement('span', { 'data-testid': 'icon' });
  return {
    Plus: Icon,
    MoreHorizontal: Icon,
    Pencil: Icon,
    Trash2: Icon,
    ArrowUpRight: Icon,
    Database: Icon,
    Settings2: Icon,
    ArrowUpDown: Icon,
    ListFilter: Icon,
    Search: Icon,
    X: Icon,
    ChevronDown: Icon,
    Upload: Icon,
    Users: Icon,
    CalendarDays: Icon,
    Package: Icon,
    FileText: Icon,
    Newspaper: Icon,
    Quote: Icon,
    Image: Icon,
    Tag: Icon,
    Layers: Icon,
    MessageSquare: Icon,
    ShoppingBag: Icon,
    Star: Icon,
    MapPin: Icon,
    Briefcase: Icon,
  };
});

// Stub Radix-based components: AlertDialog and DropdownMenu.
vi.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ open, children }: {
    open: boolean;
    onOpenChange?: (o: boolean) => void;
    children: React.ReactNode;
  }) =>
    open ? React.createElement('div', { 'data-testid': 'alert-dialog', role: 'alertdialog' }, children) : null,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'alert-dialog-content' }, children),
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) =>
    React.createElement('h2', null, children),
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) =>
    React.createElement('p', null, children),
  AlertDialogAction: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) =>
    React.createElement('button', { 'data-testid': 'alert-action', onClick }, children),
  AlertDialogCancel: ({ children }: { children: React.ReactNode }) =>
    React.createElement('button', { 'data-testid': 'alert-cancel' }, children),
}));

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'dropdown' }, children),
  DropdownMenuTrigger: ({ children }: { asChild?: boolean; children: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'dropdown-trigger' }, children),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'dropdown-content' }, children),
  DropdownMenuItem: ({ onSelect, children, variant }: {
    onSelect?: () => void;
    children: React.ReactNode;
    variant?: string;
  }) =>
    React.createElement('button', {
      'data-testid': `menu-item-${typeof children === 'string' ? children.toLowerCase() : 'item'}`,
      'data-variant': variant,
      onClick: onSelect,
    }, children),
  DropdownMenuSeparator: () => React.createElement('hr'),
}));

// CollectionSettingsDialog is a complex Radix modal -- stub it out.
vi.mock('../CollectionSettingsDialog', () => ({
  default: () => null,
}));

// collectionIcon -- return a stable icon component so resolveCollectionIcon
// doesn't need actual lucide imports beyond the mock above.
vi.mock('../collectionIcon', () => ({
  resolveCollectionIcon: () =>
    function StubIcon() {
      return React.createElement('span', { 'data-testid': 'collection-icon' });
    },
  COLLECTION_ICON_MAP: {},
  COLLECTION_ICON_KEYS: [],
  collectionIcon: () =>
    function StubIcon() {
      return React.createElement('span', { 'data-testid': 'collection-icon' });
    },
}));

const EVENTS: Collection = {
  id: 'col_events',
  slug: 'events',
  name: 'Events',
  columns: [],
  itemCount: 12,
};

const TEAM: Collection = {
  id: 'col_team',
  slug: 'team',
  name: 'Team',
  columns: [],
  itemCount: 4,
};

const EMPTY_COUNTS: Collection = {
  id: 'col_empty',
  slug: 'empty',
  name: 'Empty',
  columns: [],
  itemCount: 0,
};

function makeProps(overrides: Partial<React.ComponentProps<typeof CollectionRail>> = {}) {
  return {
    collections: [EVENTS, TEAM],
    activeId: null,
    busy: false,
    onOpen: vi.fn(),
    onCreate: vi.fn(),
    onRename: vi.fn(),
    onUpdate: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  };
}

afterEach(() => cleanup());

describe('CollectionRail', () => {
  it('renders one row per collection with its icon, name, and itemCount', () => {
    render(<CollectionRail {...makeProps()} />);

    expect(screen.getByTestId('cms-rail-collection-col_events')).toBeTruthy();
    expect(screen.getByTestId('cms-rail-collection-col_team')).toBeTruthy();

    // Names visible in the DOM.
    expect(screen.getByText('Events')).toBeTruthy();
    expect(screen.getByText('Team')).toBeTruthy();

    // Item counts.
    expect(screen.getByTestId('cms-rail-count-col_events').textContent).toBe('12');
    expect(screen.getByTestId('cms-rail-count-col_team').textContent).toBe('4');
  });

  it('renders count 0 for a collection with zero items', () => {
    render(<CollectionRail {...makeProps({ collections: [EMPTY_COUNTS] })} />);
    expect(screen.getByTestId('cms-rail-count-col_empty').textContent).toBe('0');
  });

  it('does not render a count badge when itemCount is undefined', () => {
    const noCount: Collection = { id: 'col_x', slug: 'x', name: 'X', columns: [] };
    render(<CollectionRail {...makeProps({ collections: [noCount] })} />);
    expect(screen.queryByTestId('cms-rail-count-col_x')).toBeNull();
  });

  it('active row carries the active class (bg-brand/10) on its wrapper', () => {
    render(<CollectionRail {...makeProps({ activeId: 'col_events' })} />);
    const row = screen.getByTestId('cms-rail-collection-col_events');
    expect(row.className).toContain('bg-brand/10');
  });

  it('inactive rows do NOT carry the active class', () => {
    render(<CollectionRail {...makeProps({ activeId: 'col_events' })} />);
    const teamRow = screen.getByTestId('cms-rail-collection-col_team');
    expect(teamRow.className).not.toContain('bg-brand/10');
  });

  it('clicking a non-active row calls onOpen with its id', () => {
    const onOpen = vi.fn();
    render(<CollectionRail {...makeProps({ activeId: 'col_events', onOpen })} />);

    // Team is not active, click should call onOpen.
    fireEvent.click(screen.getByTestId('cms-rail-collection-col_team'));
    expect(onOpen).toHaveBeenCalledWith('col_team');
  });

  it('clicking the already-active row does NOT call onOpen', () => {
    const onOpen = vi.fn();
    render(<CollectionRail {...makeProps({ activeId: 'col_events', onOpen })} />);

    fireEvent.click(screen.getByTestId('cms-rail-collection-col_events'));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('the + toolbar button (New collection) calls onCreate after typing a name', async () => {
    const onCreate = vi.fn();
    render(<CollectionRail {...makeProps({ onCreate })} />);

    // Click the + toolbar button to start creating.
    fireEvent.click(screen.getByTestId('rail-toolbar-new'));

    const input = screen.getByPlaceholderText('Collection name');
    fireEvent.change(input, { target: { value: 'Blog Posts' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith('Blog Posts'));
  });

  it('the "New collection" bottom affordance also calls onCreate', async () => {
    const onCreate = vi.fn();
    render(<CollectionRail {...makeProps({ onCreate })} />);

    fireEvent.click(screen.getByTestId('cms-rail-new-collection'));

    const input = screen.getByPlaceholderText('Collection name');
    fireEvent.change(input, { target: { value: 'Products' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith('Products'));
  });

  it('Fields tab is rendered disabled', () => {
    render(<CollectionRail {...makeProps()} />);
    const fieldsTab = screen.getByTestId('rail-tab-fields');
    expect(fieldsTab).toBeTruthy();
    expect((fieldsTab as HTMLButtonElement).disabled).toBe(true);
  });

  it('Bindings tab is rendered disabled', () => {
    render(<CollectionRail {...makeProps()} />);
    const bindingsTab = screen.getByTestId('rail-tab-bindings');
    expect(bindingsTab).toBeTruthy();
    expect((bindingsTab as HTMLButtonElement).disabled).toBe(true);
  });

  it('sort toolbar button is disabled', () => {
    render(<CollectionRail {...makeProps()} />);
    const btn = screen.getByTestId('rail-toolbar-sort');
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it('filter toolbar button is disabled', () => {
    render(<CollectionRail {...makeProps()} />);
    const btn = screen.getByTestId('rail-toolbar-filter');
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it('search toolbar button is disabled', () => {
    render(<CollectionRail {...makeProps()} />);
    const btn = screen.getByTestId('rail-toolbar-search');
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it('empty state shows "Create your first collection" when no collections exist', () => {
    render(<CollectionRail {...makeProps({ collections: [] })} />);
    expect(screen.getByTestId('cms-rail-empty-state')).toBeTruthy();
    expect(screen.getByText('Create your first collection')).toBeTruthy();
  });
});

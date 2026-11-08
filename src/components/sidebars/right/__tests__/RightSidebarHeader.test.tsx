// RightSidebarHeader collapse toggle tests.
// Asserts:
//   - Expanded state renders "Collapse properties" button + type tile + name.
//   - Clicking "Collapse properties" calls toggleRightSidebar.
//   - Collapsed state renders "Expand properties" button (no dead-end).
//   - Clicking "Expand properties" calls toggleRightSidebar.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { createRootStore } from '@/stores/RootStore';
import type { ComponentInstance } from '@/models/ComponentModel';
import RightSidebarHeader from '../RightSidebarHeader';

// Stub useStore so the component does not need a live MST tree in tests.
// The stub exposes the minimal editorUI shape that RightSidebarHeader reads.
const mockToggle = vi.fn();

function makeStore(collapsed: boolean) {
  return {
    editorUI: {
      rightSidebarCollapsed: collapsed,
      selectedComponent: null,
      selectedViewportNode: null,
      toggleRightSidebar: mockToggle,
    },
  };
}

vi.mock('@/hooks/useStore', () => ({
  useStore: () => currentStore,
}));

// The stub store is swapped per test via this mutable reference.
let currentStore = makeStore(false);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  currentStore = makeStore(false);
});

describe('RightSidebarHeader (expanded)', () => {
  it('renders "Collapse properties" button', () => {
    currentStore = makeStore(false);
    render(<RightSidebarHeader />);
    expect(screen.getByLabelText('Collapse properties')).toBeTruthy();
  });

  it('renders the type tile and default title when no element is selected', () => {
    currentStore = makeStore(false);
    render(<RightSidebarHeader />);
    expect(screen.getByText('Properties')).toBeTruthy();
  });

  it('clicking "Collapse properties" calls toggleRightSidebar', () => {
    currentStore = makeStore(false);
    render(<RightSidebarHeader />);
    fireEvent.click(screen.getByLabelText('Collapse properties'));
    expect(mockToggle).toHaveBeenCalledTimes(1);
  });
});

describe('RightSidebarHeader (collapsed)', () => {
  it('renders "Expand properties" button -- no dead-end', () => {
    currentStore = makeStore(true);
    render(<RightSidebarHeader />);
    expect(screen.getByLabelText('Expand properties')).toBeTruthy();
  });

  it('does NOT render the type tile or title when collapsed', () => {
    currentStore = makeStore(true);
    render(<RightSidebarHeader />);
    expect(screen.queryByText('Properties')).toBeNull();
  });

  it('clicking "Expand properties" calls toggleRightSidebar', () => {
    currentStore = makeStore(true);
    render(<RightSidebarHeader />);
    fireEvent.click(screen.getByLabelText('Expand properties'));
    expect(mockToggle).toHaveBeenCalledTimes(1);
  });
});

describe('RightSidebarHeader title and type tile', () => {
  // A real store: the tile's icon reads the node's kind and layout.
  function realStore() {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = createRootStore();
    store.projectStore.createProject('Header test');
    const project = store.projectStore.findProjectByTitle('Header test')!;
    const page = project.findPageBySlug('')!;
    store.editorUI.setCurrentProject(project);
    store.editorUI.setCurrentPage(page);
    currentStore = store as unknown as typeof currentStore;
    return { store, page };
  }

  it('titles the page root as the page body of its breakpoint, with that device icon', () => {
    const { store, page } = realStore();
    const tablet = page.sortedViewportNodes[1];
    store.editorUI.selectComponent(page.appComponentTree as ComponentInstance, tablet.breakpointId);
    const { container } = render(<RightSidebarHeader />);
    expect(screen.getByText('Page')).toBeTruthy();
    expect(screen.getByText(tablet.label!)).toBeTruthy();
    expect(screen.queryByText('Container')).toBeNull();
    expect(container.querySelector('svg.lucide-tablet')).not.toBeNull();
  });

  it('shows a container with the layout icon its Layers row shows, not a text "T"', () => {
    const { store, page } = realStore();
    const section = page.appComponentTree!.children[0] as ComponentInstance;
    store.editorUI.selectComponent(section, page.sortedViewportNodes[0].breakpointId);
    const { container } = render(<RightSidebarHeader />);
    expect(screen.queryByText('Page')).toBeNull();
    expect(screen.getByText(section.displayName)).toBeTruthy();
    expect(container.querySelector('svg.lucide-type')).toBeNull();
    expect(container.querySelector('svg.lucide-container')).not.toBeNull();
  });
});

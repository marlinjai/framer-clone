// RightSidebarHeader collapse toggle tests.
// Asserts:
//   - Expanded state renders "Collapse properties" button + type tile + name.
//   - Clicking "Collapse properties" calls toggleRightSidebar.
//   - Collapsed state renders "Expand properties" button (no dead-end).
//   - Clicking "Expand properties" calls toggleRightSidebar.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
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

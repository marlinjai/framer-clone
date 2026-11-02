// The bar that shows while a definition is open, and the Layers row of a placement.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRootStore, type RootStoreType } from '@/stores/RootStore';
import type { PageModelType } from '@/models/PageModel';
import type { ProjectModelType } from '@/models/ProjectModel';
import ComponentBreadcrumb from '../ComponentBreadcrumb';

let store: RootStoreType;
let project: ProjectModelType;
let home: PageModelType;
let placementId: string;

vi.mock('@/hooks/useStore', () => ({
  useStore: () => store,
}));

const CARD = {
  id: 'card',
  name: 'Card',
  page: {
    id: 'page-card',
    metadata: { title: 'Card' },
    appComponentTree: { id: 'c-root', type: 'article', componentType: 'host', props: {}, children: [] },
    canvasNodes: {},
  },
  inputs: [],
  states: [],
};

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  store = createRootStore();
  store.projectStore.ingestProjectSnapshot({ id: 'site', metadata: { title: 'Site' }, pages: {}, components: { card: CARD } as never });
  project = store.projectStore.getProject('site') as ProjectModelType;
  home = project.createPage('Home');
  const placed = project.placeComponent(home.id, 'card', { kind: 'appTree' });
  if (!placed.ok) throw new Error(placed.message);
  placementId = placed.placement.id;
  store.editorUI.setCurrentProject(project);
  store.editorUI.setCurrentPage(home);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ComponentBreadcrumb', () => {
  it('shows nothing on a page', () => {
    render(<ComponentBreadcrumb />);
    expect(screen.queryByTestId('component-breadcrumb')).toBeNull();
  });

  it('names the page, the definition and how many placements an edit reaches, and goes back', () => {
    render(<ComponentBreadcrumb />);
    act(() => store.editorUI.enterComponent('card', placementId));
    const bar = screen.getByTestId('component-breadcrumb');
    expect(bar.textContent).toContain('Home');
    expect(bar.textContent).toContain('Card');
    expect(bar.textContent).toContain('1 placement');
    expect(screen.getByText('Card').getAttribute('aria-current')).toBe('page');

    fireEvent.click(screen.getByRole('button', { name: 'Home' }));
    expect(store.editorUI.currentPage?.id).toBe(home.id);
    expect(store.editorUI.selectedComponent?.id).toBe(placementId);
    expect(screen.queryByTestId('component-breadcrumb')).toBeNull();
  });

  it('counts in the plural', () => {
    project.placeComponent(home.id, 'card', { kind: 'appTree' });
    render(<ComponentBreadcrumb />);
    act(() => store.editorUI.enterComponent('card', placementId));
    expect(screen.getByTestId('component-breadcrumb').textContent).toContain('2 placements');
  });
});

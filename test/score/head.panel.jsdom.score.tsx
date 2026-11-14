// The panel column of the head item rows (docs/plans/2026-11-02-theme-and-head.md, slice H3).
// Each cell is a person's action on a real root store: the real Head editor (HeadItemsPanel),
// the kind picked and the fields typed as the row's sample says, Add pressed, once for the
// site's list and once for a page's. A cell passes only when what was stored is exactly the
// sample, and fails with what the panel stored instead.

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createRootStore, type RootStoreType } from '@/stores/RootStore';
import type { StoredHeadItem } from '@/lib/site/headItems';
import pageItems from './data/page-items.json';
import { headSample } from './lib/headRows';
import { writeOut } from './lib/io';
import { pageItemEntries } from './lib/universe';
import { rowKey, type Cell, type SurfaceResults } from './lib/types';

let store: RootStoreType;
vi.mock('@/hooks/useStore', () => ({ useStore: () => store }));

import { HeadItemsPanel } from '@/components/site/HeadItemsDialog';

const key = (id: string) => rowKey('page-item', `head:${id}`);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A person fills the new-item form for this item, as the panel's own labels ask. */
function fill(item: StoredHeadItem): void {
  const form = within(screen.getByTestId('head-new'));
  const set = (label: string, value: string) => fireEvent.change(form.getByLabelText(label), { target: { value } });
  set('Kind', item.kind);
  if (item.kind === 'meta') {
    set('Name', String(item.name));
    set('Content', String(item.content));
  } else if (item.kind === 'property') {
    set('Property', String(item.property));
    set('Content', String(item.content));
  } else if (item.kind === 'link') {
    set('Relation', String(item.rel));
    set('Address', String(item.href));
    if (item.hreflang) set('Language', String(item.hreflang));
  } else {
    set('JSON-LD', JSON.stringify(item.data));
  }
  fireEvent.click(form.getByRole('button', { name: /^Add/ }));
}

/** The list the panel stored for this home after adding the item. */
function added(item: StoredHeadItem, home: 'site' | 'page'): unknown {
  cleanup();
  store = createRootStore();
  store.projectStore.createProject('Head probe');
  const project = store.projectStore.findProjectByTitle('Head probe')!;
  const page = project.findPageBySlug('')!;
  store.editorUI.setCurrentProject(project);
  store.editorUI.setCurrentPage(page);
  render(<HeadItemsPanel scope={home === 'site' ? { kind: 'site', project } : { kind: 'page', project, page }} />);
  fill(item);
  return home === 'site' ? project.site.head : page.metadata.head;
}

function panelCell(item: StoredHeadItem): Cell {
  for (const home of ['site', 'page'] as const) {
    let stored: unknown;
    try {
      stored = added(item, home);
    } catch (error) {
      return { status: 'fail', gap: 'head-items', note: `the ${home} form could not be filled: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}` };
    }
    if (!same(stored, [item])) return { status: 'fail', gap: 'head-items', note: `the ${home} panel stored ${JSON.stringify(stored)}` };
  }
  return { status: 'pass' };
}

describe('head item rows, panel column', () => {
  it('measures every row through the real Head panel, and names nothing that is not a row', () => {
    const panel: SurfaceResults = {};
    for (const id of pageItems.head) panel[key(id)] = panelCell(headSample(id));
    cleanup();
    const rows = new Set(pageItemEntries().map((e) => rowKey(e.kind, e.id)));
    for (const name of Object.keys(panel)) expect(rows.has(name), name).toBe(true);
    writeOut('page-items-head-panel', { panel });
  });

  it('the cell can fail: a panel that stores something else is caught', () => {
    const item = headSample('meta:author');
    expect(same(added(item, 'site'), [item])).toBe(true);
    expect(same(added(item, 'site'), [{ ...item, content: 'other' }])).toBe(false);
    // The canvas has no counterpart, so only this column and the format and published ones are measured.
    expect(panelCell({ kind: 'meta', name: 'description', content: 'owned' }).status).toBe('fail');
  });
});

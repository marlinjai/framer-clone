// The editor-only "Template, not legal advice" notice above a legal page.
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { getSnapshot } from 'mobx-state-tree';
import ProjectModel from '@/models/ProjectModel';
import LegalTemplateNotice from '../LegalTemplateNotice';

let store: { editorUI: { currentPage: unknown; currentProject?: unknown; editorNotice?: unknown } };
vi.mock('@/hooks/useStore', () => ({ useStore: () => store }));

afterEach(cleanup);

function project() {
  const p = ProjectModel.create({ id: 'p', metadata: { title: 'Site' }, pages: {} });
  p.createPage('Home').setSlug('');
  return p;
}

describe('LegalTemplateNotice', () => {
  it('shows above a page made from a legal template, with the placeholder count', () => {
    const p = project();
    const { page } = p.createLegalPage('impressum');
    store = { editorUI: { currentPage: page } };
    render(<LegalTemplateNotice />);
    const note = screen.getByRole('note', { name: 'Legal page template' });
    expect(note.textContent).toContain('Template, not legal advice: review before publishing.');
    expect(note.textContent).toMatch(/Replace the \d+ parts in \[square brackets\]/);
  });

  it('counts a placeholder in a component placed on the page', () => {
    const p = ProjectModel.create({
      id: 'p',
      metadata: { title: 'Site' },
      pages: {},
      components: {
        note: {
          id: 'note',
          name: 'Note',
          page: {
            id: 'note-page',
            metadata: { title: 'Note' },
            canvasNodes: {},
            appComponentTree: { id: 'n', type: 'p', componentType: 'host', props: { children: '[Firma]' } },
          },
        },
      } as never,
    });
    p.createPage('Home').setSlug('');
    const { page } = p.createLegalPage('impressum');
    const stored = getSnapshot(page.appComponentTree) as Record<string, unknown>;
    page.setAppComponentTree({
      ...stored,
      children: [{ id: 'placed', type: '#component', componentType: 'host', props: { component: 'note' } }],
    } as never);
    store = { editorUI: { currentPage: page, currentProject: p } };
    render(<LegalTemplateNotice />);
    expect(screen.getByRole('note').textContent).toContain('Replace the 1 part in [square brackets]');
  });

  it('is absent on every other page', () => {
    const p = project();
    store = { editorUI: { currentPage: p.pagesArray[0] } };
    render(<LegalTemplateNotice />);
    expect(screen.queryByTestId('legal-template-notice')).toBeNull();
  });
});

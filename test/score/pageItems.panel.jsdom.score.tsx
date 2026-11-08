// The panel column of the page-level theme rows (docs/plans/2026-11-02-theme-and-head.md,
// slice T4). Each cell is a person's action on a real root store: the real Theme panel
// (ThemeForm) to make a token, choose a mode or set a page default, and the real
// RightSidebar, a node selected, to put a token on that node through the Styles and
// Typography sections. A cell passes only when the action stored what it promised.

import React from 'react';
import { describe, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createRootStore, getHistoryStore, type RootStoreType } from '@/stores/RootStore';
import type { ComponentInstance } from '@/models/ComponentModel';
import type { ProjectModelType } from '@/models/ProjectModel';
import { DataSourceProviderContext } from '@/lib/bindings/dataSource/context';
import type { DataSourceProvider } from '@/lib/bindings/dataSource/provider';
import { tokenReference } from '@/lib/site/theme';
import { writeOut } from './lib/io';
import { rowKey, type Cell, type SurfaceResults } from './lib/types';

let store: RootStoreType;
vi.mock('@/hooks/useStore', () => ({ useStore: () => store }));

import RightSidebar from '@/components/sidebars/RightSidebar';
import { ThemeForm } from '@/components/site/ThemePanel';

const provider: DataSourceProvider = {
  listCollections: async () => [],
  getCollection: async () => null as never,
  listRows: async () => ({ rows: [] }) as never,
} as unknown as DataSourceProvider;

const key = (id: string) => rowKey('page-item', `theme:${id}`);
const cell = (ok: boolean, note: string): Cell => (ok ? { status: 'pass' } : { status: 'fail', gap: 'theme', note });

function fresh(): { project: ProjectModelType; node: ComponentInstance } {
  cleanup();
  store = createRootStore();
  store.projectStore.createProject('Panel probe');
  const project = store.projectStore.findProjectByTitle('Panel probe')!;
  const page = project.findPageBySlug('')!;
  store.editorUI.setCurrentProject(project);
  store.editorUI.setCurrentPage(page);
  getHistoryStore()!.setTargetStore(store.projectStore);
  const node = (page.appComponentTree as ComponentInstance).children[0] as ComponentInstance;
  return { project, node };
}

const panel = (project: ProjectModelType) => render(<ThemeForm project={project} />);

function addColour(name: string, value: string): void {
  fireEvent.change(screen.getByLabelText('New colour name'), { target: { value: name } });
  const field = screen.getByLabelText('New colour value');
  fireEvent.change(field, { target: { value } });
  fireEvent.blur(field);
  fireEvent.click(screen.getByRole('button', { name: /Add colour/ }));
}

function addFont(name: string, family: string): void {
  fireEvent.change(screen.getByLabelText('New font name'), { target: { value: name } });
  fireEvent.change(screen.getByLabelText('New font family'), { target: { value: family } });
  fireEvent.click(screen.getByRole('button', { name: /Add font/ }));
}

async function probe(run: () => Cell | Promise<Cell>): Promise<Cell> {
  try {
    return await run();
  } catch (err) {
    return cell(false, err instanceof Error ? err.message : String(err));
  }
}

const styleOf = (node: ComponentInstance, prop: string): unknown => (node.props.style as Record<string, unknown> | undefined)?.[prop];
/** A responsive value's stored text, at whichever breakpoint the panel wrote it. */
const written = (value: unknown): string[] => (value && typeof value === 'object' ? Object.values(value as Record<string, unknown>) : [value]).filter((v): v is string => typeof v === 'string');

describe('page-level item rows, panel column', () => {
  it('measures the Theme panel and the node sections', async () => {
    const out: SurfaceResults = {};

    out[key('color-token')] = await probe(() => {
      const { project, node } = fresh();
      panel(project);
      addColour('Accent', '#112233');
      const accent = project.site.theme.tokens.find((t) => t.name === 'Accent');
      if (!accent) return cell(false, 'Add colour stored nothing');
      cleanup();
      store.editorUI.selectComponent(node);
      render(<DataSourceProviderContext.Provider value={provider}><RightSidebar /></DataSourceProviderContext.Provider>);
      const picker = screen.getAllByLabelText(/site colour/i).find((el) => /^Text/.test(el.getAttribute('aria-label') ?? ''));
      if (!picker) return cell(false, 'the Text colour row offers no site colour');
      fireEvent.change(picker, { target: { value: accent.id } });
      return cell(written(styleOf(node, 'color')).includes(tokenReference(accent.id)), `the node's colour is ${JSON.stringify(styleOf(node, 'color'))}`);
    });

    out[key('font-token')] = await probe(() => {
      const { project, node } = fresh();
      panel(project);
      addFont('Display', 'fraunces');
      const display = project.site.theme.tokens.find((t) => t.name === 'Display');
      if (!display) return cell(false, 'Add font stored nothing');
      cleanup();
      store.editorUI.selectComponent(node);
      render(<DataSourceProviderContext.Provider value={provider}><RightSidebar /></DataSourceProviderContext.Provider>);
      const select = screen.getAllByRole('combobox').find((el) => within(el).queryByRole('option', { name: 'Display' }));
      if (!select) return cell(false, 'Typography offers no site font');
      fireEvent.change(select, { target: { value: tokenReference(display.id) } });
      return cell(written(styleOf(node, 'fontFamily')).includes(tokenReference(display.id)), `the node's font is ${JSON.stringify(styleOf(node, 'fontFamily'))}`);
    });

    out[key('dark-value')] = await probe(() => {
      const { project } = fresh();
      panel(project);
      addColour('Accent', '#112233');
      fireEvent.click(screen.getByRole('button', { name: 'Add a dark value' }));
      const dark = screen.getByLabelText('Accent, dark');
      fireEvent.change(dark, { target: { value: '#eeeeee' } });
      fireEvent.blur(dark);
      const token = project.site.theme.tokens.find((t) => t.name === 'Accent');
      return cell(token?.kind === 'color' && token.dark === '#eeeeee', `the dark value is ${token?.kind === 'color' ? token.dark : 'none'}`);
    });

    for (const [mode, label] of [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']] as const) {
      out[key(`mode-${mode}`)] = await probe(() => {
        const { project } = fresh();
        panel(project);
        fireEvent.click(screen.getByRole('button', { name: label }));
        const chosen = project.site.theme.mode === mode;
        fireEvent.click(screen.getByRole('button', { name: 'Not chosen' }));
        return cell(chosen && project.site.theme.mode === undefined, `the mode is ${project.site.theme.mode ?? 'not chosen'}`);
      });
    }

    for (const [row, field, label, kind] of [
      ['document-background', 'backgroundColor', 'Background', 'color'],
      ['document-color', 'color', 'Text', 'color'],
      ['document-font', 'fontFamily', 'Font', 'font'],
    ] as const) {
      out[key(row)] = await probe(() => {
        const { project } = fresh();
        panel(project);
        if (kind === 'color') addColour('Ground', '#ffffff');
        else addFont('Body', 'fraunces');
        const token = project.site.theme.tokens[0];
        fireEvent.change(screen.getByLabelText(label), { target: { value: token.id } });
        return cell(project.site.theme.document[field] === tokenReference(token.id), `the page default is ${project.site.theme.document[field] ?? 'none'}`);
      });
    }

    cleanup();
    writeOut('page-items-panel', { panel: out });
  });
});

// The panel column of the reusable component rows. Each cell is a person's action
// through the real editor panels on a real root store: Create component through
// its dialog, placing from This site in the Components panel, the placement's own
// Size row, and each input type's control in the placement's Component section.
// A cell passes only when the action changed the project as promised, and a value
// the type refuses must not be stored. A row with no probe here stays failed in
// report.ts.

import React from 'react';
import { describe, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createRootStore, type RootStoreType } from '@/stores/RootStore';
import { createIntrinsicComponent, type ComponentInstance } from '@/models/ComponentModel';
import type { ProjectModelType } from '@/models/ProjectModel';
import type { PageModelType } from '@/models/PageModel';
import { DataSourceProviderContext } from '@/lib/bindings/dataSource/context';
import type { DataSourceProvider } from '@/lib/bindings/dataSource/provider';
import { placeDefinition, requestCreateComponent } from '@/lib/components/editorCommands';
import { tapInsertTarget } from '@/lib/layers/tapInsertTarget';
import type { InputType } from '@/lib/components/inputs';
import type { PlacementProps } from '@/lib/components/placement';
import { formatRuns } from '@/lib/components/richText';
import { INPUT_PROBES } from './lib/componentProbes';
import { writeOut } from './lib/io';
import { rowKey, type Cell, type SurfaceResults } from './lib/types';

let store: RootStoreType;

vi.mock('@/hooks/useStore', () => ({
  useStore: () => store,
}));

import RightSidebar from '@/components/sidebars/RightSidebar';
import ComponentsPanel from '@/components/sidebars/left/ComponentsPanel';
import ComponentDialogs from '@/components/ComponentDialogs';

const provider: DataSourceProvider = {
  listCollections: async () => [],
  getCollection: async () => ({ id: 'col', name: 'Posts', columns: [{ id: 'title', name: 'Title', type: 'text' }] }) as never,
  listRows: async () => ({ rows: [] }) as never,
  getRow: async () => null,
  subscribe: () => () => {},
};

const LIVE_TYPES = Object.keys(INPUT_PROBES) as InputType[];
const label = (type: string) => `Probe ${type}`;

/** A site with a Card (one input per live type) and a Badge, and an empty home page. */
function site(): { project: ProjectModelType; page: PageModelType } {
  store = createRootStore();
  const tree = (id: string, type: string, children: unknown[] = []) => ({ id, type, componentType: 'host', props: {}, children });
  store.projectStore.ingestProjectSnapshot({
    id: 'site',
    metadata: { title: 'Site' },
    pages: {},
    components: {
      card: {
        id: 'card', name: 'Card', inputs: LIVE_TYPES.map((type) => ({ id: type, name: label(type), type, ...INPUT_PROBES[type]!.input })), states: [],
        page: { id: 'card-page', metadata: { title: 'Card' }, appComponentTree: tree('c-root', 'article', [tree('c-text', 'h3')]), canvasNodes: {} },
      },
      badge: {
        id: 'badge', name: 'Badge', inputs: [], states: [],
        page: { id: 'badge-page', metadata: { title: 'Badge' }, appComponentTree: tree('b-root', 'div'), canvasNodes: {} },
      },
    } as never,
  });
  const project = store.projectStore.getProject('site')!;
  const page = project.createPage('Home');
  store.editorUI.setCurrentProject(project);
  store.editorUI.setCurrentPage(page);
  return { project, page };
}

const mount = (ui: React.ReactNode) => render(<DataSourceProviderContext.Provider value={provider}>{ui}</DataSourceProviderContext.Provider>);

/** The Components panel as the phone sheet has it: a tap places, by the sheet's own rule. */
const panel = () => (
  <ComponentsPanel
    onTapInsert={() => {}}
    onTapPlace={(id) => placeDefinition(store.editorUI, id, tapInsertTarget(store.editorUI.selectedComponent))}
  />
);
const siteList = () => within(screen.getByTestId('site-components'));

function placed(page: PageModelType, definitionId: string): ComponentInstance[] {
  const out: ComponentInstance[] = [];
  const walk = (node: ComponentInstance) => {
    if (node.type === '#component' && (node.props as Partial<PlacementProps>).component === definitionId) out.push(node);
    node.children.forEach(walk);
  };
  walk(page.appComponentTree as unknown as ComponentInstance);
  return out;
}

async function typeInto(field: HTMLElement, value: string) {
  await act(async () => {
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value } });
  });
  await act(async () => fireEvent.keyDown(field, { key: 'Enter' }));
}

const pass = (): Cell => ({ status: 'pass' });
const fail = (note: string): Cell => ({ status: 'fail', gap: 'reusable-components', note });
const cell = (ok: boolean, note: string): Cell => (ok ? pass() : fail(note));

async function probe(check: () => Promise<Cell>): Promise<Cell> {
  try {
    return await check();
  } catch (err) {
    return fail(err instanceof Error ? err.message.slice(0, 300) : String(err));
  } finally {
    cleanup();
  }
}

/** A placement of the card on the home page, selected, with the right panel mounted. */
function selectedCard(): { project: ProjectModelType; page: PageModelType; node: ComponentInstance } {
  const { project, page } = site();
  const result = project.placeComponent(page.id, 'card', { kind: 'appTree' });
  if (!result.ok) throw new Error(result.message);
  store.editorUI.selectComponent(result.placement);
  mount(<RightSidebar />);
  return { project, page, node: result.placement };
}

/** Operates the type's control with its sample, after first trying the refused sample where it is typed. */
async function operate(type: InputType, node: ComponentInstance): Promise<Cell> {
  const sample = INPUT_PROBES[type]!;
  const stored = () => (node.props as Partial<PlacementProps>).inputs?.[type];
  const name = label(type);
  if (type === 'toggle') {
    await act(async () => fireEvent.click(screen.getByRole('switch', { name })));
    return cell(stored() === true, 'the switch stored no boolean');
  }
  if (type === 'choice' || type === 'cursor') {
    await act(async () => fireEvent.change(screen.getByLabelText(name), { target: { value: sample.value } }));
    return cell(stored() === sample.value, 'the select stored nothing');
  }
  if (type === 'richtext') {
    // Typed in the field's notation, which must store the runs, not the text.
    const field = screen.getByLabelText(name);
    await typeInto(field, formatRuns(sample.refused));
    const refusedKept = stored() === undefined;
    await typeInto(field, formatRuns(sample.value));
    return cell(refusedKept && JSON.stringify(stored()) === JSON.stringify(sample.value), `refused kept out: ${refusedKept}, stored ${JSON.stringify(stored())}`);
  }
  if (type === 'image') {
    const value = sample.value as { src: string; alt: string };
    await typeInto(screen.getByLabelText(`${name} address`), (sample.refused as { src: string }).src);
    const refusedKept = stored() === undefined;
    await typeInto(screen.getByLabelText(`${name} address`), value.src);
    await typeInto(screen.getByLabelText(`${name} description`), value.alt);
    return cell(refusedKept && JSON.stringify(stored()) === JSON.stringify(value), `stored ${JSON.stringify(stored())}`);
  }
  const field = screen.getByLabelText(name);
  // A typed field only makes text: a sample refused for not being text cannot be typed.
  let refusedKept = true;
  if (typeof sample.refused === 'string' || typeof sample.refused === 'number') {
    await typeInto(field, String(sample.refused));
    refusedKept = stored() === undefined;
  }
  await typeInto(field, String(sample.value));
  return cell(refusedKept && stored() === sample.value, `refused kept out: ${refusedKept}, stored ${JSON.stringify(stored())}`);
}

const key = (id: string) => rowKey('component', id);

async function panelCells(): Promise<SurfaceResults> {
  const out: SurfaceResults = {};
  out[key('definition')] = await probe(async () => {
    const { project, page } = site();
    const root = page.appComponentTree as unknown as ComponentInstance;
    root.addChildren([createIntrinsicComponent('hero', 'section', { children: 'Hi' })]);
    store.editorUI.selectComponent(root.children.find((c: ComponentInstance) => c.id === 'hero'));
    mount(<ComponentDialogs />);
    await act(async () => requestCreateComponent(store.editorUI));
    const name = screen.getByLabelText('Component name');
    await act(async () => fireEvent.change(name, { target: { value: 'Hero' } }));
    await act(async () => fireEvent.submit(name.closest('form')!));
    const made = Array.from(project.components.values()).find((d) => d.name === 'Hero');
    return cell(!!made && placed(page, made.id).length === 1 && !root.children.some((c: ComponentInstance) => c.id === 'hero'), 'Create component made no definition and placement');
  });
  out[key('placement')] = await probe(async () => {
    const { page } = site();
    mount(panel());
    await act(async () => fireEvent.click(siteList().getByRole('button', { name: 'Add Card' })));
    await act(async () => fireEvent.click(siteList().getByRole('button', { name: 'Add Card' })));
    return cell(placed(page, 'card').length === 2, 'a tap on This site placed nothing');
  });
  out[key('placement-style')] = await probe(async () => {
    const { node } = selectedCard();
    await typeInto(screen.getByLabelText('Width'), '300');
    const width = (node.props.style as Record<string, unknown> | undefined)?.width;
    return cell(width !== undefined && JSON.stringify(width).includes('300'), `the Width row wrote ${JSON.stringify(width)}`);
  });
  out[key('nested')] = await probe(async () => {
    const { project } = site();
    await act(async () => store.editorUI.enterComponent('card'));
    mount(panel());
    await act(async () => fireEvent.click(siteList().getByRole('button', { name: 'Add Badge' })));
    return cell(placed(project.components.get('card')!.page as PageModelType, 'badge').length === 1, 'nothing was placed inside the definition');
  });
  out[key('cycle-refused')] = await probe(async () => {
    const { project } = site();
    await act(async () => store.editorUI.enterComponent('card'));
    mount(panel());
    const entry = siteList().getByRole('button', { name: 'Add Card' });
    await act(async () => fireEvent.click(entry));
    const inside = placed(project.components.get('card')!.page as PageModelType, 'card').length;
    return cell(entry.getAttribute('aria-disabled') === 'true' && inside === 0 && /Card contains Card/.test(store.editorUI.editorNotice?.message ?? ''), 'the entry was not refused with its reason');
  });
  out[key('collection-template')] = await probe(async () => {
    const { project, page } = site();
    const root = page.appComponentTree as unknown as ComponentInstance;
    root.addChildren([createIntrinsicComponent('list', 'div', { 'data-component-kind': 'collection' })]);
    root.children.find((c: ComponentInstance) => c.id === 'list')!.setBinding('collection', { mode: 'read', expression: 'col' });
    const result = project.placeComponent(page.id, 'card', { kind: 'parent', parentId: 'list' });
    if (!result.ok) throw new Error(result.message);
    store.editorUI.selectComponent(result.placement);
    mount(<RightSidebar />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: `Bind ${label('text')}` })));
    await act(async () => fireEvent.click(await screen.findByRole('button', { name: /\{\{row\.title\}\}/ })));
    return cell(result.placement.bindings['input.text']?.expression === '{{row.title}}', 'the picker wrote no row binding');
  });
  for (const type of LIVE_TYPES) {
    out[key(type)] = await probe(async () => operate(type, selectedCard().node));
  }
  return out;
}

describe('reusable component rows: properties panel', () => {
  it('edits what is built through the real panels', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    writeOut('components-panel', await panelCells());
  });
});

// The canvas column of the reusable component rows. Each cell goes through the real
// ComponentRenderer with a real root store holding a real project, mounted in jsdom
// because a Collection reads its rows in an effect. A row with no probe here stays
// failed in report.ts.

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { getSnapshot } from 'mobx-state-tree';
import { createRootStore, type RootStoreType } from '@/stores/RootStore';
import ComponentRenderer from '@/components/ComponentRenderer';
import { DataSourceProviderContext } from '@/lib/bindings/dataSource/context';
import type { DataSourceProvider } from '@/lib/bindings/dataSource/provider';
import type { InputType } from '@/lib/components/inputs';
import type { ComponentInstance } from '@/models/ComponentModel';
import { CARD, definition, INPUT_PROBES, jsonTrip, placement, read, type Stored } from './lib/componentProbes';
import { BREAKPOINTS } from './lib/published';
import { writeOut } from './lib/io';
import { rowKey, type Cell, type SurfaceResults } from './lib/types';

let store: RootStoreType;

vi.mock('@/hooks/useStore', () => ({
  useStore: () => store,
}));

const withType = (node: Stored, parentId?: string): Record<string, unknown> => ({
  ...node,
  componentType: 'host',
  props: node.props ?? {},
  ...(parentId ? { parentId } : {}),
  children: (node.children ?? []).map((child) => withType(child, node.id)),
});

const provider = (rows: Record<string, unknown>[]): DataSourceProvider => ({
  listCollections: async () => [],
  getCollection: async () => null,
  listRows: async () => ({ rows: rows.map((values, index) => ({ id: `row-${index}`, values })) }) as never,
  getRow: async () => null,
  subscribe: () => () => {},
});

/** A project with these definitions and a home page holding these nodes, drawn on one frame. */
async function canvasHtml(
  children: Stored[],
  definitions: ReturnType<typeof definition>[],
  options: { frame?: number; rows?: Record<string, unknown>[]; expected?: string } = {},
): Promise<string> {
  const frameNode = (node: unknown) => ({ ...(node as object), type: 'div', componentType: 'host' });
  const stored = Object.fromEntries(
    definitions.map((d) => [d.id, jsonTrip({
      ...d,
      page: {
        id: `page-${d.id}`,
        metadata: { title: d.id },
        appComponentTree: withType(d.page.appComponentTree as Stored),
        canvasNodes: Object.fromEntries(Object.entries(d.page.canvasNodes).map(([id, node]) => [id, frameNode(node)])),
      },
    })]),
  );
  store = createRootStore();
  store.projectStore.ingestProjectSnapshot({ id: 'site', metadata: { title: 'Site' }, pages: {}, components: stored as never });
  const project = store.projectStore.getProject('site')!;
  const page = project.createPage('Home');
  const root = getSnapshot(page.appComponentTree) as unknown as { id: string };
  page.setAppComponentTree({ ...root, children: children.map((child) => withType(child, root.id)) } as never);
  store.editorUI.setCurrentProject(project);
  store.editorUI.setCurrentPage(page);
  const frames = page.sortedViewportNodes.map((v: ComponentInstance) => ({ id: v.breakpointId!, minWidth: v.breakpointMinWidth! }));
  const { container } = render(
    <DataSourceProviderContext.Provider value={provider(options.rows ?? [])}>
      <ComponentRenderer component={page.appComponentTree as ComponentInstance} breakpointId={frames[options.frame ?? 0].id} allBreakpoints={frames} />
    </DataSourceProviderContext.Provider>,
  );
  const { expected } = options;
  if (expected) await waitFor(() => expect(container.innerHTML).toContain(expected));
  const html = container.innerHTML;
  cleanup();
  return html;
}

const pass = (): Cell => ({ status: 'pass' });
const fail = (note: string): Cell => ({ status: 'fail', gap: 'reusable-components', note });
const cell = (ok: boolean, note: string): Cell => (ok ? pass() : fail(note));

async function probe(check: () => Promise<Cell>): Promise<Cell> {
  try {
    return await check();
  } catch (err) {
    return fail(err instanceof Error ? err.message.slice(0, 300) : String(err));
  }
}

const key = (id: string) => rowKey('component', id);

/** The text of an element, whatever attributes the canvas gave it. */
const text = (html: string, tag: string): string[] =>
  [...html.matchAll(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'g'))].map((match) => match[1]);

async function canvasCells(): Promise<SurfaceResults> {
  const out: SurfaceResults = {};
  out[key('definition')] = await probe(async () => {
    const html = await canvasHtml([placement('p1', 'card')], [CARD]);
    return cell(text(html, 'h3').includes('Card title'), 'the default did not reach the canvas');
  });
  out[key('placement')] = await probe(async () => {
    const html = await canvasHtml([placement('p1', 'card', { inputs: { title: 'One' } }), placement('p2', 'card', { inputs: { title: 'Two' } })], [CARD]);
    const ids = ['p1', 'p2'].every((id) => html.includes(`data-inner-component-id="${id}"`));
    return cell(ids && text(html, 'h3').join() === 'One,Two', 'two placements were not two units');
  });
  out[key('placement-style')] = await probe(async () => {
    const stored = [placement('p1', 'card', { style: { width: { base: '300px' } } })];
    const large = await canvasHtml(stored, [CARD]);
    const small = await canvasHtml(stored, [CARD], { frame: BREAKPOINTS.length - 1 });
    return cell(large.includes('width: 300px') && small.includes('width: 50%'), 'the merged width did not reach each frame');
  });
  out[key('nested')] = await probe(async () => {
    const outer = definition('outer', { id: 'o', type: 'section', children: [
      placement('in', 'card', {}, { 'input.title': read('{{input.heading}}') }),
    ] }, [{ id: 'heading', name: 'Heading', type: 'text' }]);
    const html = await canvasHtml([placement('p1', 'outer', { inputs: { heading: 'Passed down' } })], [outer, CARD]);
    return cell(text(html, 'h3').includes('Passed down'), 'the outer input did not reach the inner placement');
  });
  out[key('cycle-refused')] = await probe(async () => {
    const a = definition('a', { id: 'a-r', type: 'div', props: { title: 'kept' }, children: [placement('x', 'a')] });
    const html = await canvasHtml([placement('p1', 'a')], [a]);
    return cell(html.includes('title="kept"') && html.includes('Missing component'), 'a cycle did not stop at the first repeat');
  });
  out[key('collection-template')] = await probe(async () => {
    const collection: Stored = {
      id: 'list', type: 'div', props: { 'data-component-kind': 'collection' }, bindings: { collection: read('col') },
      children: [placement('p1', 'card', {}, { 'input.title': read('{{row.title}}') })],
    };
    const html = await canvasHtml([collection], [CARD], { rows: [{ title: 'Row one' }, { title: 'Row two' }], expected: 'Row two' });
    return cell(text(html, 'h3').join() === 'Row one,Row two', 'a row did not reach its card');
  });
  for (const [type, sample] of Object.entries(INPUT_PROBES)) {
    out[key(type)] = await probe(async () => {
      const stored = definition('d', { id: 'r', ...sample.node }, [{ id: 'x', name: 'X', type: type as InputType, ...sample.input }]);
      const html = await canvasHtml([placement('p1', 'd', { inputs: { x: sample.value } })], [stored]);
      const ok = sample.canvas.every((part) => html.includes(part)) && !html.includes('Missing component') && !(sample.absent && html.includes(sample.absent));
      return cell(ok, `expected ${sample.canvas.join(' and ')} in ${html.slice(-200)}`);
    });
  }
  return out;
}

describe('reusable component rows: editor canvas', () => {
  it('draws what is built through the real ComponentRenderer', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    writeOut('components-canvas', await canvasCells());
  });
});

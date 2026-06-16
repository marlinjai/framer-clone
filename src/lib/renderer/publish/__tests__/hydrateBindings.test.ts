// @vitest-environment node
//
// hydrateBindings runs in Node with NO React and NO jsdom: it is the build-time
// counterpart to the live preview renderers, evaluated eagerly through the
// React-free resolver. This suite opts the file into the node environment (the
// repo convention documented in vitest.config.ts) so it exercises the helper
// under the same resolver-runtime node-env config the resolver tests use, and
// asserts that environment explicitly.
import { describe, it, expect } from 'vitest';
import {
  hydrateBindings,
  nodeTextContent,
  type ComponentNode,
} from '@/lib/renderer/publish/hydrateBindings';
import type { CmsReadRepository } from '@/server/cms';
import type { Collection, Query, Row, RowsPage } from '@/lib/bindings/dataSource/types';

// A minimal CmsReadRepository test double. Only listRows / getRow are exercised
// by the hydrator; the collection-metadata methods return inert values.
interface RepoOptions {
  rows?: Record<string, Row[]>;
  listRowsImpl?: (id: string, query?: Query) => Promise<RowsPage>;
  getRowImpl?: (id: string, rowId: string) => Promise<Row | null>;
}

function makeRepo(opts: RepoOptions = {}): CmsReadRepository {
  const rows = opts.rows ?? {};
  return {
    async listCollections(): Promise<Collection[]> {
      return [];
    },
    async getCollection(): Promise<Collection | null> {
      return null;
    },
    async listRows(id: string, query?: Query): Promise<RowsPage> {
      if (opts.listRowsImpl) return opts.listRowsImpl(id, query);
      return { rows: rows[id] ?? [], total: (rows[id] ?? []).length };
    },
    async getRow(id: string, rowId: string): Promise<Row | null> {
      if (opts.getRowImpl) return opts.getRowImpl(id, rowId);
      return (rows[id] ?? []).find((r) => r.id === rowId) ?? null;
    },
  };
}

const EVENTS: Row[] = [
  { id: 'event_1', values: { title: 'Launch', city: 'Berlin' } },
  { id: 'event_2', values: { title: 'Demo', city: 'Munich' } },
  { id: 'event_3', values: { title: 'Workshop', city: 'Berlin' } },
];

// A Collection node bound to col_events whose first child is the per-row
// template: a span bound to {{row.title}}.
function collectionNode(extraProps: Record<string, unknown> = {}): ComponentNode {
  return {
    id: 'collection-1',
    type: 'div',
    props: { 'data-component-kind': 'collection', ...extraProps },
    bindings: { collection: { mode: 'read', expression: 'col_events' } },
    children: [
      {
        id: 'tpl-title',
        type: 'span',
        props: {},
        bindings: { children: { mode: 'read', expression: '{{row.title}}' } },
      },
    ],
  };
}

// A RecordView node bound to col_events, resolving the row from {{page.params.id}}.
function recordViewNode(extraProps: Record<string, unknown> = {}): ComponentNode {
  return {
    id: 'rv-1',
    type: 'article',
    props: { 'data-component-kind': 'record-view', ...extraProps },
    bindings: { record: { mode: 'read', expression: 'col_events' } },
    children: [
      {
        id: 'rv-title',
        type: 'h1',
        props: {},
        bindings: { children: { mode: 'read', expression: '{{row.title}}' } },
      },
    ],
  };
}

describe('hydrateBindings (build-time, Node)', () => {
  it('runs under the resolver-runtime node-env config (no React, no jsdom)', () => {
    expect(typeof window).toBe('undefined');
    expect(typeof document).toBe('undefined');
  });

  it('expands a Collection to one block per row with {{row.field}} baked in (no LOADING)', async () => {
    const repo = makeRepo({ rows: { col_events: EVENTS } });
    const tree = await hydrateBindings(collectionNode(), {}, { cmsRepo: repo });

    expect(tree.children).toHaveLength(3);
    const titles = (tree.children ?? []).map((child) => nodeTextContent(child));
    expect(titles).toEqual(['Launch', 'Demo', 'Workshop']);

    // The values are concrete strings on props, not loading sentinels / text.
    expect(tree.children?.[0]?.props?.children).toBe('Launch');
    expect(JSON.stringify(tree)).not.toContain('Loading');
    expect(JSON.stringify(tree)).not.toContain('LOADING');
  });

  it('narrows expanded rows when a structured props.query filter is set', async () => {
    // The repo honors the filter so the hydrated tree reflects the query.
    const repo = makeRepo({
      listRowsImpl: async (_id, query) => {
        const filtered = query?.filter
          ? EVENTS.filter((r) =>
              query.filter!.every((c) => r.values[c.column] === c.value),
            )
          : EVENTS;
        return { rows: filtered, total: filtered.length };
      },
    });
    const query: Query = { filter: [{ column: 'city', op: 'eq', value: 'Berlin' }] };
    const tree = await hydrateBindings(
      collectionNode({ query }),
      {},
      { cmsRepo: repo },
    );

    const titles = (tree.children ?? []).map((child) => nodeTextContent(child));
    expect(titles).toEqual(['Launch', 'Workshop']);
  });

  it('resolves a RecordView from the page slug params', async () => {
    const repo = makeRepo({ rows: { col_events: EVENTS } });
    const tree = await hydrateBindings(
      recordViewNode(),
      { id: 'event_2' },
      { cmsRepo: repo },
    );

    expect(nodeTextContent(tree)).toBe('Demo');
    expect(tree.children).toHaveLength(1);
    expect(tree.children?.[0]?.props?.children).toBe('Demo');
  });

  it('yields the configured emptyContent for an empty collection', async () => {
    const repo = makeRepo({ rows: { col_events: [] } });
    const tree = await hydrateBindings(
      collectionNode({ emptyContent: 'No events yet' }),
      {},
      { cmsRepo: repo },
    );

    expect(nodeTextContent(tree)).toBe('No events yet');
  });

  it('yields the configured emptyContent when a RecordView row is not found', async () => {
    const repo = makeRepo({ rows: { col_events: EVENTS } });
    const tree = await hydrateBindings(
      recordViewNode({ emptyContent: 'Event not found' }),
      { id: 'missing' },
      { cmsRepo: repo },
    );

    expect(nodeTextContent(tree)).toBe('Event not found');
  });

  it('renders nothing for the slot on a fetch error and NEVER throws the build (Collection)', async () => {
    const repo = makeRepo({
      listRowsImpl: async () => {
        throw new Error('boom: datasource unreachable');
      },
    });

    // The build must not throw; the slot resolves to an empty wrapper.
    const tree = await hydrateBindings(collectionNode(), {}, { cmsRepo: repo });
    expect(tree.children).toEqual([]);
    expect(nodeTextContent(tree)).toBe('');
  });

  it('renders nothing for the slot on a fetch error and NEVER throws the build (RecordView)', async () => {
    const repo = makeRepo({
      getRowImpl: async () => {
        throw new Error('boom: row fetch failed');
      },
    });

    const tree = await hydrateBindings(
      recordViewNode(),
      { id: 'event_1' },
      { cmsRepo: repo },
    );
    expect(tree.children).toEqual([]);
    expect(nodeTextContent(tree)).toBe('');
  });

  it('bakes ordinary read bindings into props without touching the input tree', async () => {
    const repo = makeRepo({ rows: { col_events: EVENTS } });
    const input = collectionNode();
    const before = JSON.stringify(input);
    await hydrateBindings(input, {}, { cmsRepo: repo });
    // The hydrator never mutates its input (pure expansion).
    expect(JSON.stringify(input)).toBe(before);
  });
});

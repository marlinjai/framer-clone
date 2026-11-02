// The reusable component rows that can be measured so far: the format column and
// the published column, for the capabilities expansion delivers and the seven
// first input types. Every check runs the real code: a stored shape goes through
// ComponentModel, a snapshot, JSON and parseComponents, and a page through
// snapshotToComponentNode and renderPublishedPage. A row with no probe here stays
// failed in report.ts, so an unmeasured promise can never count as kept.

import { describe, expect, it, vi } from 'vitest';
import { getSnapshot } from 'mobx-state-tree';
import ComponentModel, { ComponentTypeEnum } from '@/models/ComponentModel';
import { parseComponents, type ComponentDefinitions } from '@/lib/components/definition';
import { expandPlacements } from '@/lib/components/expand';
import { parseInputValue, type InputDefinition, type InputType } from '@/lib/components/inputs';
import { MISSING_TYPE } from '@/lib/components/placement';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { componentEntries } from './lib/universe';
import { CARD, definition, definitionsOf, INPUT_PROBES, jsonTrip, page, placement, read, type Stored } from './lib/componentProbes';
import { BREAKPOINTS, renderThroughPublishedPage } from './lib/published';
import { writeOut } from './lib/io';
import { rowKey, type Cell, type SurfaceResults } from './lib/types';

/** Through the editor's model, a snapshot, JSON and the model again, as a save and load does. */
function savedAndLoaded(node: Stored): Stored {
  const withType = (n: Stored): Record<string, unknown> => ({
    ...n,
    componentType: ComponentTypeEnum.HOST,
    props: n.props ?? {},
    ...(n.children ? { children: n.children.map(withType) } : {}),
  });
  const first = ComponentModel.create(withType(node) as never);
  const second = ComponentModel.create(jsonTrip(getSnapshot(first)));
  return jsonTrip(getSnapshot(second)) as unknown as Stored;
}

const expandedRoot = (children: Stored[], definitions: ComponentDefinitions): ComponentNode => {
  const stored = savedAndLoaded(page(children));
  return expandPlacements(stored as ComponentNode, definitions, BREAKPOINTS);
};

const pass = (): Cell => ({ status: 'pass' });
const fail = (note: string): Cell => ({ status: 'fail', gap: 'reusable-components', note });
const cell = (ok: boolean, note: string): Cell => (ok ? pass() : fail(note));

async function probe(check: () => Promise<Cell> | Cell): Promise<Cell> {
  try {
    return await check();
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

const key = (id: string) => rowKey('component', id);

async function formatCells(): Promise<SurfaceResults> {
  const out: SurfaceResults = {};
  const cards = definitionsOf(CARD);
  out[key('definition')] = await probe(() => {
    const { definitions, refused } = parseComponents(jsonTrip({ card: CARD }));
    const tree = definitions.card?.page.appComponentTree as unknown as Stored | undefined;
    return cell(refused.length === 0 && tree?.children?.[0].id === 'c-title' && definitions.card.inputs.length === 1, 'a definition did not survive JSON and the reader');
  });
  out[key('placement')] = await probe(() => {
    const expanded = expandedRoot([placement('p1', 'card', { inputs: { title: 'Kept' } })], cards);
    return cell(expanded.children?.[0].type === 'article' && JSON.stringify(expanded).includes('Kept'), 'a saved placement did not expand');
  });
  out[key('placement-style')] = await probe(() => {
    const expanded = expandedRoot([placement('p1', 'card', { style: { width: { base: '300px' } } })], cards);
    const width = (expanded.children?.[0].props?.style as Record<string, unknown> | undefined)?.width as Record<string, unknown> | undefined;
    return cell(width?.base === '300px' && width.mobile === '50%', `merged width was ${JSON.stringify(width)}`);
  });
  out[key('nested')] = await probe(() => {
    const outer = definition('outer', { id: 'o', type: 'section', children: [placement('in', 'card')] });
    const expanded = expandedRoot([placement('p1', 'outer')], definitionsOf(outer, CARD));
    return cell(expanded.children?.[0].children?.[0].id === 'p1__in', 'a nested placement did not expand under its path');
  });
  out[key('cycle-refused')] = await probe(() => {
    const a = definition('a', { id: 'a-r', type: 'div', children: [placement('x', 'b')] });
    const b = definition('b', { id: 'b-r', type: 'div', children: [placement('y', 'a')] });
    const expanded = expandedRoot([placement('p1', 'a')], definitionsOf(a, b));
    return cell(expanded.children?.[0].children?.[0].children?.[0].type === MISSING_TYPE, 'a stored cycle was not refused');
  });
  out[key('collection-template')] = await probe(() => {
    const collection: Stored = {
      id: 'list', type: 'div', props: { 'data-component-kind': 'collection' }, bindings: { collection: read('col') },
      children: [placement('p1', 'card', {}, { 'input.title': read('{{row.title}}') })],
    };
    const template = expandedRoot([collection], cards).children?.[0].children?.[0];
    return cell(template?.type === 'article' && JSON.stringify(template.props).includes('{{row.title}}'), 'the row binding did not survive');
  });
  for (const [type, sample] of Object.entries(INPUT_PROBES)) {
    out[key(type)] = await probe(() => {
      const input = jsonTrip({ id: 'x', name: 'X', type, ...sample.input }) as InputDefinition;
      const taken = parseInputValue(input, jsonTrip(sample.value)).ok;
      const stored = parseComponents(jsonTrip({ d: definition('d', { id: 'r', type: 'div' }, [input]) })).refused.length === 0;
      return cell(taken && stored && !parseInputValue(input, sample.refused).ok, 'the input did not take its sample or did not refuse the bad one');
    });
  }
  return out;
}

async function publishedCells(): Promise<SurfaceResults> {
  const out: SurfaceResults = {};
  const cards = definitionsOf(CARD);
  const html = (children: Stored[], definitions: ComponentDefinitions, rows?: Record<string, unknown>[]) =>
    renderThroughPublishedPage({ tree: page(children), definitions, rows }).then((r) => r.html);

  out[key('definition')] = await probe(async () => {
    const page1 = await html([placement('p1', 'card')], cards);
    return cell(page1.includes('<h3>Card title</h3>'), 'the default did not reach the page');
  });
  out[key('placement')] = await probe(async () => {
    const text = await html([placement('p1', 'card', { inputs: { title: 'One' } }), placement('p2', 'card', { inputs: { title: 'Two' } })], cards);
    return cell(text.includes('<h3>One</h3>') && text.includes('<h3>Two</h3>') && !text.includes('#component'), 'two placements were not two cards');
  });
  out[key('placement-style')] = await probe(async () => {
    const { html: text, } = await renderThroughPublishedPage({
      tree: page([placement('p1', 'card', { style: { width: { base: '300px' } } })]),
      definitions: cards,
    });
    return cell(text.includes('width:300px') && text.includes('width:50%'), 'the merged width did not reach the stylesheet');
  });
  out[key('nested')] = await probe(async () => {
    const outer = definition('outer', { id: 'o', type: 'section', children: [
      placement('in', 'card', {}, { 'input.title': read('{{input.heading}}') }),
    ] }, [{ id: 'heading', name: 'Heading', type: 'text' }]);
    const text = await html([placement('p1', 'outer', { inputs: { heading: 'Passed down' } })], definitionsOf(outer, CARD));
    return cell(text.includes('<section><article') && text.includes('<h3>Passed down</h3>'), 'the outer input did not reach the inner placement');
  });
  out[key('cycle-refused')] = await probe(async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = definition('a', { id: 'a-r', type: 'div', props: { title: 'kept' }, children: [placement('x', 'a')] });
    const text = await html([placement('p1', 'a')], definitionsOf(a));
    warn.mockRestore();
    return cell(text.includes('<div title="kept"></div>'), 'a cycle did not stop at the first repeat');
  });
  out[key('collection-template')] = await probe(async () => {
    const collection: Stored = {
      id: 'list', type: 'div', props: { 'data-component-kind': 'collection' }, bindings: { collection: read('col') },
      children: [placement('p1', 'card', {}, { 'input.title': read('{{row.title}}') })],
    };
    const text = await html([collection], cards, [{ title: 'Row one' }, { title: 'Row two' }]);
    return cell(text.includes('<h3>Row one</h3>') && text.includes('<h3>Row two</h3>'), 'a row did not reach its card');
  });
  for (const [type, sample] of Object.entries(INPUT_PROBES)) {
    out[key(type)] = await probe(async () => {
      const stored = definition('d', { id: 'r', ...sample.node }, [{ id: 'x', name: 'X', type: type as InputType, ...sample.input }]);
      const text = await html([placement('p1', 'd', { inputs: { x: sample.value } })], definitionsOf(stored));
      const ok = text.includes(sample.expected) && !(sample.absent && text.includes(sample.absent));
      return cell(ok, `expected ${sample.expected} in ${text.slice(-200)}`);
    });
  }
  return out;
}

describe('reusable component rows', () => {
  it('measures what is built, and names nothing that is not a row', async () => {
    const results = { format: await formatCells(), renderer: await publishedCells() };
    const rows = new Set(componentEntries().map((e) => rowKey(e.kind, e.id)));
    for (const surface of Object.values(results)) {
      for (const name of Object.keys(surface)) expect(rows.has(name), name).toBe(true);
    }
    writeOut('components', results);
  });
});

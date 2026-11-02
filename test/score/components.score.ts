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
import { readRules } from '@/lib/rules/rules';
import { HOVER_GATE } from '@/lib/rules/states';
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

/** A button whose root and label each hold one stored rule for a pointer state, through ComponentModel and JSON. */
const POINTER_KINDS = { 'state-hover': 'hover', 'state-pressed': 'pressed', 'state-focused': 'focused' } as const;
const POINTER_CSS = { hover: ':hover', pressed: ':active', focused: ':is(:focus-visible, :has(:focus-visible))' } as const;
const MARKER = '[data-u-c-btn="btn"]';

function pointerButton(kind: keyof typeof POINTER_CSS) {
  const rule = (style: Record<string, unknown>) => ({ id: `state-${kind}`, componentState: kind, selector: '&', style });
  const tree = savedAndLoaded({
    id: 'b-root', type: 'button', props: { rules: [rule({ color: 'rgb(1, 2, 3)' })] },
    children: [{ id: 'b-label', type: 'span', props: { children: 'Go', rules: [rule({ fontWeight: '700' })] } }],
  });
  return { ...definition('btn', tree), states: [{ id: kind, name: kind, kind }] } as unknown as ReturnType<typeof definition>;
}

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
  for (const [row, kind] of Object.entries(POINTER_KINDS)) {
    out[key(row)] = await probe(() => {
      const { definitions, refused } = parseComponents(jsonTrip({ btn: pointerButton(kind) }));
      const stored = definitions.btn?.page.appComponentTree as unknown as Stored | undefined;
      // Fail closed: the stored rule is refused raw, and only expansion makes it apply.
      const raw = readRules(stored?.props).refused.length === 1;
      const expanded = expandedRoot([placement('p1', 'btn')], definitions).children?.[0];
      const read = readRules(expanded?.props);
      const active = `${MARKER}${POINTER_CSS[kind]}`;
      const compiled = read.refused.length === 0 && read.rules[0]?.kind === 'selector'
        && read.rules[0].parts[0] === `&:where(${active}, ${active} *)`
        && (read.rules[0].at[0] === HOVER_GATE) === (kind === 'hover');
      const marked = expanded?.props?.['data-u-c-btn'] === 'btn' && definitions.btn.states[0]?.kind === kind;
      return cell(refused.length === 0 && raw && compiled && marked, `the ${kind} state did not survive the round trip and compile: ${JSON.stringify(read)}`);
    });
  }
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
  for (const [row, kind] of Object.entries(POINTER_KINDS)) {
    out[key(row)] = await probe(async () => {
      const text = await html([placement('p1', 'btn'), placement('p2', 'btn')], definitionsOf(pointerButton(kind)));
      const active = `${MARKER}${POINTER_CSS[kind]}`;
      const label = `.fc_r-b-label.fc_r-b-label:where(${active}, ${active} *){font-weight:700}`;
      const root = `.fc_r-b-root.fc_r-b-root:where(${active}, ${active} *){color:rgb(1, 2, 3)}`;
      const gated = kind !== 'hover' || text.includes(`@media (hover:hover) and (pointer:fine){\n${root}`);
      const ok = text.split(label).length === 2 && text.includes(root) && gated && (text.match(/<button data-u-c-btn="btn"/g) ?? []).length === 2;
      return cell(ok, `the ${kind} state did not reach the sheet once, relative to both placements: ${text.slice(0, 400)}`);
    });
  }
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

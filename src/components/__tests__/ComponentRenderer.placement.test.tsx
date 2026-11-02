// Placements on the canvas and in the preview. A placement is one unit on the canvas:
// its definition's live tree, resolved at D(P) against the definition's breakpoints,
// with the placement's identity on the root and everything inside passing the pointer
// through. The preview draws the published path's expansion. Both are compared here
// with what the published mapping gives on a page whose frames differ from the
// definition's, which is the one case where the two implementations could drift.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { getSnapshot } from 'mobx-state-tree';
import { createRootStore, type RootStoreType } from '@/stores/RootStore';
import ComponentRenderer from '../ComponentRenderer';
import HeadlessPageRenderer from '@/lib/renderer/HeadlessPageRenderer';
import type { ComponentInstance } from '@/models/ComponentModel';
import type { PageModelType } from '@/models/PageModel';
import type { ProjectModelType } from '@/models/ProjectModel';
import { collectPageFonts } from '@/lib/fonts/registry';
import { mapResponsiveValue } from '@/lib/components/breakpoints';
import { resolveCascade } from '@/lib/responsive/cascade';
import { DataSourceProviderContext } from '@/lib/bindings/dataSource/context';
import type { DataSourceProvider } from '@/lib/bindings/dataSource/provider';

let store: RootStoreType;

vi.mock('@/hooks/useStore', () => ({
  useStore: () => store,
}));

const read = (expression: string) => ({ mode: 'read', expression });

const host = (id: string, type: string, props: Record<string, unknown> = {}, children: unknown[] = [], bindings?: Record<string, unknown>) => ({
  id,
  type,
  componentType: 'host',
  props,
  children,
  ...(bindings ? { bindings } : {}),
});

const placement = (id: string, component: string, props: Record<string, unknown> = {}, bindings?: Record<string, unknown>) =>
  host(id, '#component', { component, ...props }, [], bindings);

const frame = (id: string, minWidth: number) => ({
  id,
  canvasNodeType: 'viewport',
  type: 'div',
  componentType: 'host',
  breakpointId: id,
  breakpointMinWidth: minWidth,
  viewportWidth: minWidth,
  viewportHeight: 600,
  canvasX: 0,
  canvasY: 0,
});

/** Frames of its own, at widths no page uses: 1000 and 500. */
const OWN_FRAMES = { 'def-large': frame('def-large', 1000), 'def-small': frame('def-small', 500) };

const definition = (id: string, tree: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  page: { id: `page-${id}`, metadata: { title: id }, appComponentTree: tree, canvasNodes: OWN_FRAMES },
  inputs: [],
  states: [],
  ...extra,
});

const CARD = definition(
  'card',
  host('c-root', 'article', { style: { width: { base: '100%', 'def-small': '50%' } } }, [
    host('c-title', 'h3', { children: 'Stored' }, [], { children: read('{{input.title}}') }),
    host('c-badge', 'span', { children: 'New' }, [], { visible: read('{{input.badge}}') }),
  ]),
  {
    inputs: [
      { id: 'title', name: 'Title', type: 'text', default: 'Card title' },
      { id: 'badge', name: 'Badge', type: 'toggle', default: true },
    ],
  },
);

/** Three frames, none at the definition's widths. The smallest maps to `def-small`, by the fallback. */
const PAGE_BREAKPOINTS = [
  { id: 'big', minWidth: 1400 },
  { id: 'mid', minWidth: 800 },
  { id: 'tiny', minWidth: 300 },
];

let project: ProjectModelType;
let page: PageModelType;

function setup(components: Record<string, unknown>, ...children: unknown[]) {
  store = createRootStore();
  store.projectStore.ingestProjectSnapshot({ id: 'site', metadata: { title: 'Site' }, pages: {}, components: components as never });
  project = store.projectStore.getProject('site') as ProjectModelType;
  page = project.createPage('Home');
  const canvasNodes = Object.fromEntries(PAGE_BREAKPOINTS.map(({ id, minWidth }) => [id, frame(id, minWidth)]));
  const root = getSnapshot(page.appComponentTree) as unknown as { id: string };
  page.setAppComponentTree({ ...root, children: (children as { id: string }[]).map(child => ({ ...child, parentId: root.id })) } as never);
  for (const viewport of [...page.viewportNodes]) page.removeCanvasNode(viewport.id);
  for (const node of Object.values(canvasNodes)) page.addCanvasNode(node as never);
  store.editorUI.setCurrentProject(project);
  store.editorUI.setCurrentPage(page);
  store.editorUI.clearSelection();
}

const treeOf = () => page.appComponentTree as unknown as ComponentInstance;

const drawn = (breakpointId = 'big', component = treeOf()) =>
  render(<ComponentRenderer component={component} breakpointId={breakpointId} allBreakpoints={PAGE_BREAKPOINTS} />);

const inFrame = (container: HTMLElement, breakpointId: string, id: string) =>
  container.querySelector<HTMLElement>(`[data-component-id="${breakpointId}-${id}"]`);

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('a placement on the canvas', () => {
  it('draws its definition with the placement on the root and the definition on what is inside', () => {
    setup({ card: CARD }, placement('p1', 'card', { inputs: { title: 'One' } }), placement('p2', 'card', { inputs: { title: 'Two' } }));
    const { container } = drawn();
    const root = inFrame(container, 'big', 'p1')!;
    expect(root.tagName).toBe('ARTICLE');
    expect(root.getAttribute('data-inner-component-id')).toBe('p1');
    expect(root.getAttribute('data-placement-root')).toBe('big-c-root');
    expect(container.querySelectorAll('[data-component-id="big-c-title"]')).toHaveLength(2);
    expect([...container.querySelectorAll('h3')].map(h => h.textContent)).toEqual(['One', 'Two']);
  });

  it('selects the placement from a click anywhere inside it, in the frame it was made', () => {
    setup({ card: CARD }, placement('p1', 'card'));
    const { container } = drawn('mid');
    const title = inFrame(container, 'mid', 'c-title')!;
    expect(title.style.pointerEvents).toBe('none');
    fireEvent.click(title);
    expect(store.editorUI.selectedComponent?.id).toBe('p1');
    expect(store.editorUI.selectedViewportNode?.breakpointId).toBe('mid');
  });

  it('never opens inline text editing inside it', () => {
    const plain = definition('plain', host('r', 'p', { children: 'Words' }));
    setup({ plain }, placement('p1', 'plain'));
    const { container } = drawn();
    fireEvent.doubleClick(inFrame(container, 'big', 'p1')!);
    expect(store.editorUI.editingComponent).toBeUndefined();
    expect(inFrame(container, 'big', 'p1')!.getAttribute('contenteditable')).toBeNull();
  });

  it('honours the placement\'s Layers flags, not the definition\'s', () => {
    setup({ card: CARD }, placement('p1', 'card'));
    const node = page.findComponent('p1')!;
    act(() => node.toggleCanvasLock());
    const { container } = drawn();
    const root = inFrame(container, 'big', 'p1')!;
    expect(root.style.pointerEvents).toBe('none');
    fireEvent.click(root);
    expect(store.editorUI.selectedComponent?.id).not.toBe('p1');
  });

  it('resolves each frame by width as the published mapping does, on frames that differ from the definition', () => {
    setup({ card: CARD }, placement('p1', 'card'));
    const stored = { base: '100%', 'def-small': '50%' };
    const own = [{ id: 'def-large', minWidth: 1000 }, { id: 'def-small', minWidth: 500 }];
    const published = mapResponsiveValue(stored, own, PAGE_BREAKPOINTS);
    for (const { id } of PAGE_BREAKPOINTS) {
      const { container, unmount } = drawn(id);
      expect(inFrame(container, id, 'p1')!.style.width).toBe(resolveCascade(published, id, PAGE_BREAKPOINTS).value);
      unmount();
    }
    // The fixture must tell the frames apart, or the loop above proves nothing.
    expect(resolveCascade(published, 'mid', PAGE_BREAKPOINTS).value).toBe('50%');
    expect(resolveCascade(published, 'big', PAGE_BREAKPOINTS).value).toBe('100%');
  });

  it('lays the placement\'s own style over the root, per property and per frame', () => {
    setup({ card: CARD }, placement('p1', 'card', { style: { width: { base: '300px', mid: '200px' }, color: 'red' } }));
    const big = drawn('big');
    expect(inFrame(big.container, 'big', 'p1')!.style.width).toBe('300px');
    big.unmount();
    const mid = drawn('mid');
    expect(inFrame(mid.container, 'mid', 'p1')!.style.width).toBe('200px');
    expect(inFrame(mid.container, 'mid', 'p1')!.style.color).toBe('red');
  });

  it('keeps the definition\'s smaller frames under a placement\'s base, as the published merge does', () => {
    setup({ card: CARD }, placement('p1', 'card', { style: { width: { base: '300px' } } }));
    const big = drawn('big');
    expect(inFrame(big.container, 'big', 'p1')!.style.width).toBe('300px');
    big.unmount();
    const tiny = drawn('tiny');
    expect(inFrame(tiny.container, 'tiny', 'p1')!.style.width).toBe('50%');
  });

  it('lets a bound input beat the placement\'s style, as the published page does', () => {
    const box = definition('box', host('r', 'div', { style: { width: '10px' } }, [], { 'style.width': read('{{input.w}}') }), {
      inputs: [{ id: 'w', name: 'W', type: 'number', unit: 'px', default: 40 }],
    });
    setup({ box }, placement('p1', 'box', { style: { width: '300px' } }));
    const { container } = drawn();
    expect(inFrame(container, 'big', 'p1')!.style.width).toBe('40px');
  });

  it('resolves a responsive colour input to one value on each frame', () => {
    const swatch = definition('swatch', host('r', 'div', {}, [], { 'style.color': read('{{input.tone}}') }), {
      inputs: [{ id: 'tone', name: 'Tone', type: 'color', default: { base: 'red', 'def-small': 'blue' } }],
    });
    setup({ swatch }, placement('p1', 'swatch'), placement('p2', 'swatch', { inputs: { tone: { base: 'green', tiny: 'black' } } }));
    const big = drawn('big');
    expect(inFrame(big.container, 'big', 'p1')!.style.color).toBe('red');
    expect(inFrame(big.container, 'big', 'p2')!.style.color).toBe('green');
    big.unmount();
    const tiny = drawn('tiny');
    expect(inFrame(tiny.container, 'tiny', 'p1')!.style.color).toBe('blue');
    expect(inFrame(tiny.container, 'tiny', 'p2')!.style.color).toBe('black');
  });

  it('takes a value from data in the scope around it, row by row', async () => {
    const provider: DataSourceProvider = {
      listCollections: async () => [],
      getCollection: async () => null,
      listRows: async () => ({ rows: [{ id: 'a', values: { title: 'Row one' } }, { id: 'b', values: { title: 'Row two' } }] }) as never,
      getRow: async () => null,
      subscribe: () => () => {},
    };
    const list = host('list', 'div', { 'data-component-kind': 'collection' }, [
      placement('p1', 'card', {}, { 'input.title': read('{{row.title}}') }),
    ], { collection: read('col') });
    setup({ card: CARD }, list);
    const { container, findByText } = render(
      <DataSourceProviderContext.Provider value={provider}>
        <ComponentRenderer component={treeOf()} breakpointId="big" allBreakpoints={PAGE_BREAKPOINTS} />
      </DataSourceProviderContext.Provider>,
    );
    await findByText('Row two');
    expect([...container.querySelectorAll('h3')].map(h => h.textContent)).toEqual(['Row one', 'Row two']);
  });

  it('takes a bound visible that resolves to false out of the page, and keeps anything else', () => {
    setup({ card: CARD }, placement('p1', 'card', { inputs: { badge: false } }), placement('p2', 'card'));
    const { container } = drawn();
    expect(container.querySelectorAll('[data-component-id="big-c-badge"]')).toHaveLength(1);
  });

  it('refuses an input bound to an address its type does not check, as the published page does', () => {
    const link = definition('link', host('r', 'a', { href: '/stored', children: 'Go' }, [], { href: read('{{input.t}}') }), {
      inputs: [{ id: 't', name: 'T', type: 'text', default: '/from-text' }],
    });
    setup({ link }, placement('p1', 'link'));
    const { container } = drawn();
    expect(inFrame(container, 'big', 'p1')!.getAttribute('href')).toBe('/stored');
  });

  it('follows a definition edit on every placement at once', () => {
    setup({ card: CARD }, placement('p1', 'card'), placement('p2', 'card'));
    const { container } = drawn();
    const definitionRoot = project.components.get('card')!.page.appComponentTree as unknown as ComponentInstance;
    act(() => definitionRoot.setProps({ title: 'Edited' }));
    expect(inFrame(container, 'big', 'p1')!.getAttribute('title')).toBe('Edited');
    expect(inFrame(container, 'big', 'p2')!.getAttribute('title')).toBe('Edited');
  });

  it('draws a floating placement as the largest breakpoint', () => {
    setup({ card: CARD });
    const result = project.placeComponent(page.id, 'card', { kind: 'floating', x: 10, y: 20 });
    expect(result.ok).toBe(true);
    const placed = result.ok ? result.placement : undefined;
    const { container } = drawn('', placed as ComponentInstance);
    expect(container.querySelector<HTMLElement>('article')!.style.width).toBe('100%');
    expect(container.querySelector('article')!.getAttribute('data-component-id')).toBe(`-${placed!.id}`);
  });
});

describe('nesting on the canvas', () => {
  const OUTER = definition(
    'outer',
    host('o-root', 'section', {}, [
      placement('in', 'card', { style: { width: { base: '70%', 'def-small': '30%' } } }, { 'input.title': read('{{input.heading}}') }),
    ]),
    { inputs: [{ id: 'heading', name: 'Heading', type: 'text' }] },
  );

  it('passes an outer input down and keeps everything one unit', () => {
    setup({ outer: OUTER, card: CARD }, placement('p1', 'outer', { inputs: { heading: 'Passed down' } }));
    const { container } = drawn();
    expect(container.querySelector('h3')!.textContent).toBe('Passed down');
    fireEvent.click(container.querySelector('h3')!);
    expect(store.editorUI.selectedComponent?.id).toBe('p1');
    expect(inFrame(container, 'big', 'in')!.style.pointerEvents).toBe('none');
  });

  it('maps an inner placement straight to the page, and keys its own style on what holds it', () => {
    setup({ outer: OUTER, card: CARD }, placement('p1', 'outer'));
    const big = drawn('big');
    expect(inFrame(big.container, 'big', 'in')!.style.width).toBe('70%');
    big.unmount();
    const tiny = drawn('tiny');
    expect(inFrame(tiny.container, 'tiny', 'in')!.style.width).toBe('30%');
  });

  it('stops a stored cycle at the first repeat, with the page standing', () => {
    const a = definition('a', host('a-r', 'div', { title: 'kept' }, [placement('x', 'b')]));
    const b = definition('b', host('b-r', 'div', {}, [placement('y', 'a')]));
    setup({ a, b }, placement('p1', 'a'));
    const { container } = drawn();
    expect(inFrame(container, 'big', 'p1')!.getAttribute('title')).toBe('kept');
    expect(container.textContent).toContain('Missing component');
  });

  it('stops a tree the page does not hold too, where no verdict reaches', () => {
    const a = definition('a', host('a-r', 'div', {}, [placement('x', 'a')]));
    setup({ a });
    const detached = project.components.get('a')!.page.appComponentTree as unknown as ComponentInstance;
    const { container } = drawn('big', detached.children[0] as ComponentInstance);
    expect(container.textContent).toContain('Missing component');
  });

  it('shows a fan-out past the page budget as missing, as a visitor would get nothing for it', () => {
    const leaf = definition('leaf', host('l', 'b', { children: 'x' }));
    const row = (id: string, inner: string) =>
      definition(id, host(`${id}-r`, 'div', {}, Array.from({ length: 10 }, (_, i) => placement(`${id}-${i}`, inner))));
    setup({ leaf, d1: row('d1', 'leaf'), d2: row('d2', 'd1'), d3: row('d3', 'd2'), d4: row('d4', 'd3') }, placement('p1', 'd4'));
    expect(page.expansion.missing.size).toBeGreaterThan(0);
    const { container } = drawn();
    expect(container.textContent).toContain('Missing component');
    expect(container.querySelectorAll('b').length).toBeLessThanOrEqual(5000);
  });
});

describe('a placement that cannot be drawn', () => {
  it('stays selectable and deletable, and comes back with its definition', () => {
    setup({ card: CARD }, placement('p1', 'gone'));
    const { container } = drawn();
    const box = inFrame(container, 'big', 'p1')!;
    expect(box.textContent).toBe('Missing component');
    expect(box.hasAttribute('data-placement-root')).toBe(true);
    fireEvent.click(box);
    expect(store.editorUI.selectedComponent?.id).toBe('p1');
  });
});

describe('the preview', () => {
  const preview = (breakpointId: string) => render(<HeadlessPageRenderer page={page} breakpointId={breakpointId} />);

  it('draws the expansion: an id per placement, input values, and no stored instance', () => {
    setup({ card: CARD }, placement('p1', 'card', { inputs: { title: 'One', badge: false } }), placement('p2', 'card', { inputs: { title: 'Two' } }));
    const { container } = preview('big');
    expect([...container.querySelectorAll('h3')].map(h => h.textContent)).toEqual(['One', 'Two']);
    expect(container.querySelector('[data-component-id="big-p1__c-title"]')).not.toBeNull();
    expect(container.querySelector('[data-component-id="big-p1__c-badge"]')).toBeNull();
    expect(container.querySelector('[data-component-id="big-p2__c-badge"]')).not.toBeNull();
    expect(container.innerHTML).not.toContain('instance');
    expect(container.innerHTML).not.toContain('#component');
  });

  it('agrees with the canvas on frames that differ from the definition', () => {
    setup({ card: CARD }, placement('p1', 'card'));
    for (const { id } of PAGE_BREAKPOINTS) {
      const canvas = drawn(id);
      const shown = inFrame(canvas.container, id, 'p1')!.style.width;
      canvas.unmount();
      const { container, unmount } = preview(id);
      expect(inFrame(container, id, 'p1')!.style.width).toBe(shown);
      unmount();
    }
  });

  it('renders nothing for a placement with no definition', () => {
    setup({}, placement('p1', 'gone'));
    const { container } = preview('big');
    expect(container.textContent).not.toContain('Missing component');
    expect(inFrame(container, 'big', 'p1')).toBeNull();
  });

  it('follows a definition edit', () => {
    setup({ card: CARD }, placement('p1', 'card'));
    const { container } = preview('big');
    const definitionRoot = project.components.get('card')!.page.appComponentTree as unknown as ComponentInstance;
    act(() => definitionRoot.setProps({ title: 'Edited' }));
    expect(inFrame(container, 'big', 'p1')!.getAttribute('title')).toBe('Edited');
  });

  it('shows a definition on its own with its defaults', () => {
    setup({ card: CARD });
    const { container } = render(<HeadlessPageRenderer page={project.components.get('card')!.page as PageModelType} breakpointId="def-large" />);
    expect(container.querySelector('h3')!.textContent).toBe('Card title');
  });
});

describe('fonts on the editor surfaces', () => {
  const faced = (family: string, input?: boolean) =>
    definition(
      'typed',
      host('t', 'p', input ? {} : { style: { fontFamily: family } }, [], input ? { 'style.fontFamily': read('{{input.font}}') } : undefined),
      input ? { inputs: [{ id: 'font', name: 'Font', type: 'choice', options: [{ label: 'F', value: family }] }] } : {},
    );

  it('sees a family used only inside a definition, or passed to one', () => {
    setup({ typed: faced('Fraunces') }, placement('p1', 'typed'));
    expect(collectPageFonts(page.canvasFontRoots).ids).toContain('fraunces');
    expect(collectPageFonts(page.pageFontRoots).ids).toContain('fraunces');
    setup({ typed: faced('Fraunces', true) }, placement('p1', 'typed', { inputs: { font: 'Fraunces' } }));
    expect(collectPageFonts(page.canvasFontRoots).ids).toContain('fraunces');
  });
});

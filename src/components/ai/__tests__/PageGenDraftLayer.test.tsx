// The canvas side of the draft (../PageGenDraftLayer.tsx), with the REAL canvas
// renderer and store: where the draft is drawn for replace, insert and a new
// page, that it is visual only, that it shows only on the page the run started
// on, and the spike of the plan: a detached tree renders through
// HeadlessComponentRenderer inside a frame, with bindings and the site theme,
// without reaching for a project.

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { createRootStore, type RootStoreType } from '@/stores/RootStore';
import type { ComponentInstance } from '@/models/ComponentModel';
import type { PageModelType } from '@/models/PageModel';
import { captureTarget } from '@/lib/ai/pageGen/editorBridge';
import { draftTargetFor, buildDraftTree } from '@/lib/ai/pageGen/draft';
import type { PageGenOutline, PageGenSection } from '@/lib/ai/pageGen/protocol';
import { SKELETON_ATTR } from '@/components/live/SkeletonLayer';
import { validateGeneration } from '@/lib/ai/pageGen/validate';
import { deriveBreakpointKeys } from '@/lib/ai/pageGen/schema';
import { createScope, pushPageFrame } from '@/lib/bindings/resolver/scope';

let store: RootStoreType;
vi.mock('@/hooks/useStore', () => ({ useStore: () => store }));

import ComponentRenderer from '@/components/ComponentRenderer';
import HeadlessComponentRenderer from '@/lib/renderer/HeadlessComponentRenderer';
import {
  DRAFT_BAND_ATTR,
  DRAFT_FRAME_ATTR,
  DRAFT_SECTION_ATTR,
  DRAFT_SKELETON_ATTR,
  DraftPageFrames,
  DraftStyles,
  draftBandText,
  draftHookFor,
  draftRevealCss,
} from '../PageGenDraftLayer';

let page: PageModelType;
let container: ComponentInstance;

function root() {
  return page.appComponentTree as ComponentInstance;
}
function breakpoints() {
  return page.sortedViewportNodes.map((v: ComponentInstance) => ({ id: v.breakpointId!, minWidth: v.breakpointMinWidth!, label: v.label! }));
}

function section(raw: unknown, index: number, target: ReturnType<typeof captureTarget>): PageGenSection {
  const out = validateGeneration({ nodes: [raw] }, { breakpoints: deriveBreakpointKeys(target.breakpoints) });
  if (!out.ok) throw new Error(out.errors.join('; '));
  return { generationId: 'g', index, slot: index, attempt: 1, node: out.result.nodes[0] };
}

const HERO = {
  type: 'section',
  label: 'Hero',
  props: { style: { padding: { base: '64px', mobile: '24px' }, color: 'var(--fc-color-text)' } },
  children: [
    { type: 'h1', props: { children: 'Fresh bread' } },
    { type: 'img', imageQuery: 'sourdough loaf on a board', props: { alt: 'Sourdough' } },
  ],
};

function startDraft(kind: 'newPage' | 'replace' | 'insert', selected?: ComponentInstance, title?: string) {
  const target = captureTarget(kind, page, selected);
  act(() =>
    store.editorUI.pageGenDraft.begin(
      draftTargetFor({ requestKey: 'k1', target, title, rootId: root().id, siteLanguage: 'en' }),
    ),
  );
  return target;
}

function renderPage() {
  const bps = breakpoints();
  return render(
    <div data-viewport-content-id="frame">
      <ComponentRenderer component={root()} breakpointId={bps[0].id} allBreakpoints={bps} scope={pushPageFrame(createScope(), {}, null)} />
    </div>,
  );
}

beforeEach(() => {
  store = createRootStore();
  store.projectStore.createProject('Crumb');
  const project = store.projectStore.findProjectByTitle('Crumb')!;
  page = project.createPage('Home');
  page.ensureDefaultViewports();
  page.insertRegistryComponent('container', { kind: 'appTree' });
  store.editorUI.setCurrentProject(project);
  store.editorUI.setCurrentPage(page);
  container = root().children[0] as ComponentInstance;
});

afterEach(() => cleanup());

describe('spike: a detached tree on the canvas', () => {
  it('renders through HeadlessComponentRenderer with the breakpoint ids, bindings scope and theme of a frame', () => {
    const target = captureTarget('insert', page, root());
    const draftTarget = draftTargetFor({ requestKey: 'k', target, rootId: root().id });
    const tree = buildDraftTree(section(HERO, 0, target), draftTarget)!;
    expect(tree).toBeDefined();
    const mobile = target.breakpoints.find((b) => b.label === 'Mobile')!;
    const { container: dom } = render(
      <div data-fc-theme="frame" data-fc-theme-mode="light">
        <HeadlessComponentRenderer component={tree} breakpointId={mobile.id} allBreakpoints={target.breakpoints} scope={pushPageFrame(createScope(), {}, null)} />
      </div>,
    );
    const el = dom.querySelector('section')!;
    expect(el.style.padding).toBe('24px');
    expect(el.style.color).toBe('var(--fc-color-text)');
    expect(dom.querySelector('h1')).toHaveTextContent('Fresh bread');
    // Images keep the placeholder until the result places the photos.
    expect(dom.querySelector('img')?.getAttribute('src')).toMatch(/^\/images\//);
  });
});

describe('the draft on the canvas', () => {
  it('replace: the target is drawn as the draft sections, which are visual only', () => {
    const target = startDraft('replace', container);
    act(() => void store.editorUI.pageGenDraft.add('k1', section(HERO, 0, target)));
    const { container: dom } = renderPage();
    expect(dom.querySelector(`[data-inner-component-id="${container.id}"]`)).toBeNull();
    const drawn = dom.querySelector(`[${DRAFT_SECTION_ATTR}="0"]`)!;
    expect(drawn).toBeInTheDocument();
    expect(drawn).toHaveAttribute('aria-hidden', 'true');
    // No editor handlers on the draft: it is drawn by the headless renderer.
    expect(drawn.querySelector('h1')).toHaveTextContent('Fresh bread');
    // The motion rules live beside the frames, never inside the page tree.
    expect(dom.querySelector('style')).toBeNull();
    // The band of the next section, with a static tint.
    expect(dom.querySelector(`[${DRAFT_BAND_ATTR}]`)).toHaveTextContent('Writing section 2...');
  });

  it('replace of the page root: the root stays, its children are the draft', () => {
    const target = startDraft('replace', root());
    act(() => void store.editorUI.pageGenDraft.add('k1', section(HERO, 0, target)));
    const { container: dom } = renderPage();
    const rootEl = dom.querySelector(`[data-inner-component-id="${root().id}"]`)!;
    expect(rootEl).toBeInTheDocument();
    expect(rootEl.querySelector(`[data-inner-component-id="${container.id}"]`)).toBeNull();
    expect(rootEl.querySelector(`[${DRAFT_SECTION_ATTR}="0"]`)).toBeInTheDocument();
  });

  it('insert: the draft follows the existing children; nothing is drawn on another page', () => {
    const target = startDraft('insert', root());
    act(() => void store.editorUI.pageGenDraft.add('k1', section(HERO, 0, target)));
    const { container: dom, unmount } = renderPage();
    const rootEl = dom.querySelector(`[data-inner-component-id="${root().id}"]`)!;
    const kids = Array.from(rootEl.children);
    expect(kids[0]).toHaveAttribute('data-inner-component-id', container.id);
    expect(kids[1]).toHaveAttribute(DRAFT_SECTION_ATTR, '0');
    unmount();

    // The same draft is not drawn on another page.
    expect(draftHookFor(store.editorUI.pageGenDraft.target, 'another-page', root().id)).toBeNull();
    expect(draftHookFor(store.editorUI.pageGenDraft.target, page.id, root().id)).toBe('insert');
  });

  it('a section arriving redraws the draft only; a cleared draft leaves the page as it was', () => {
    const target = startDraft('insert', root());
    const { container: dom } = renderPage();
    expect(dom.querySelectorAll(`[${DRAFT_SECTION_ATTR}]`)).toHaveLength(0);
    act(() => void store.editorUI.pageGenDraft.add('k1', section(HERO, 0, target)));
    act(() => void store.editorUI.pageGenDraft.add('k1', section(HERO, 1, target)));
    expect(dom.querySelectorAll(`[${DRAFT_SECTION_ATTR}]`)).toHaveLength(2);
    act(() => store.editorUI.pageGenDraft.clear('k1'));
    expect(dom.querySelectorAll(`[${DRAFT_SECTION_ATTR}]`)).toHaveLength(0);
    expect(dom.querySelector(`[${DRAFT_BAND_ATTR}]`)).toBeNull();
    expect(dom.querySelector(`[data-inner-component-id="${container.id}"]`)).toBeInTheDocument();
  });

  it('only a section the canvas drew counts as shown: one stored while the run page is off screen does not', () => {
    const target = startDraft('insert', root());
    const draft = store.editorUI.pageGenDraft;
    // Stored with nothing mounted (another page on screen): received, not drawn.
    act(() => void draft.add('k1', section(HERO, 0, target)));
    expect(draft.shownSources()).toEqual([]);
    // Mounted: the section is drawn, and the apply may leave it still.
    renderPage();
    expect(draft.shownSources()).toHaveLength(1);
    act(() => void draft.add('k1', section(HERO, 1, target)));
    expect(draft.shownSources()).toHaveLength(2);
  });

  it('new page: draft frames titled after the requested page, beside the real frames', () => {
    const target = startDraft('newPage', undefined, 'Our menu');
    act(() => void store.editorUI.pageGenDraft.add('k1', section(HERO, 0, target)));
    const right = Math.max(...target.viewports.map((v) => v.x + v.width));
    const { container: dom } = render(<DraftPageFrames framesRight={right} />);
    const frames = dom.querySelectorAll(`[${DRAFT_FRAME_ATTR}]`);
    expect(frames).toHaveLength(target.viewports.length);
    expect(frames[0]).toHaveTextContent('Our menu');
    expect(frames[0]).toHaveTextContent('Draft');
    // The frames carry the theme attributes, never the real frames' markers.
    expect(dom.querySelector('[data-fc-theme="frame"]')).toBeInTheDocument();
    expect(dom.querySelector('[data-viewport-id], [data-viewport-content-id]')).toBeNull();
    expect(dom.querySelectorAll(`[${DRAFT_SECTION_ATTR}="0"]`)).toHaveLength(target.viewports.length);
  });

  it('motion: each drawn section reveals node by node, 180ms ease-out, none with reduced motion, no shimmer', () => {
    const target = startDraft('insert', root());
    const { container: dom } = render(<DraftStyles />);
    expect(dom.querySelector('style[data-pagegen-draft-styles]')!.textContent).not.toMatch(/animation|shimmer|infinite/);
    expect(dom.querySelector('style[data-pagegen-draft-reveal]')).toBeNull();
    act(() => void store.editorUI.pageGenDraft.add('k1', section(HERO, 0, target)));
    const tree = store.editorUI.pageGenDraft.sections[0].tree;
    const ids = [tree.id, ...tree.children.map((c: ComponentInstance) => c.id)];
    const css = dom.querySelector('style[data-pagegen-draft-reveal="0"]')!.textContent!;
    expect(css).toBe(draftRevealCss(0, tree));
    // Document order, 45 ms apart, scoped to the section's wrapper.
    ids.forEach((id, i) => {
      expect(css).toContain(`[${DRAFT_SECTION_ATTR}="0"] [data-inner-component-id="${id}"], [${DRAFT_SECTION_ATTR}="0"] [data-component-id$="-${id}"] { animation: fc-live-reveal 180ms ease-out ${i * 45}ms backwards; }`);
    });
    expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{[^}]*animation: none/);
    expect(css).not.toMatch(/shimmer|infinite/);
    // A second section gets its own; the first is not rewritten (it would replay).
    const first = dom.querySelector('style[data-pagegen-draft-reveal="0"]');
    act(() => void store.editorUI.pageGenDraft.add('k1', section(HERO, 1, target)));
    expect(dom.querySelector('style[data-pagegen-draft-reveal="0"]')).toBe(first);
    expect(dom.querySelector('style[data-pagegen-draft-reveal="1"]')).not.toBeNull();
    act(() => store.editorUI.pageGenDraft.clear('k1'));
    expect(dom.querySelector('style[data-pagegen-draft-reveal]')).toBeNull();
  });

  it('a section reveal leaves out an id that is not plain rather than writing it into a selector', () => {
    const css = draftRevealCss(2, { id: 'sec', children: [{ id: 'bad"] { x: y } [a="' }, { id: 'ok_1' }] });
    expect(css).toContain('[data-inner-component-id="sec"]');
    expect(css).toContain('[data-inner-component-id="ok_1"], [data-pagegen-draft-section="2"] [data-component-id$="-ok_1"] { animation: fc-live-reveal 180ms ease-out 90ms backwards; }');
    expect(css).not.toContain('bad');
    expect(draftRevealCss(0, { id: 'not plain' })).toBe('');
  });

  it('the band says what happens next, and gives way to skeletons', () => {
    expect(draftBandText('writing', 0, 2)).toBeNull();
    expect(draftBandText('checking', 0, 1)).toBeNull();
    expect(draftBandText('writing', 0)).toBe('Writing section 1...');
    expect(draftBandText('writing', 2)).toBe('Writing section 3...');
    expect(draftBandText('polishing', 2)).toBeNull();
    expect(draftBandText('polishing', 0)).toBe('Polishing the page...');
    expect(draftBandText('checking', 0)).toBe('Checking the page...');
  });
});

const OUTLINE: PageGenOutline = {
  generationId: 'g',
  attempt: 1,
  outline: [
    { title: 'Hero', kind: 'hero' },
    { title: '', kind: 'faq' },
    { title: 'Footer', kind: 'footer' },
  ],
};

describe('the outline skeletons on the canvas', () => {
  const order = (dom: HTMLElement) => {
    const rootEl = dom.querySelector(`[data-inner-component-id="${root().id}"]`)!;
    return Array.from(rootEl.querySelectorAll(`[${DRAFT_SECTION_ATTR}], [${DRAFT_SKELETON_ATTR}]`)).map((el) =>
      el.hasAttribute(DRAFT_SKELETON_ATTR) ? `skeleton:${el.getAttribute(DRAFT_SKELETON_ATTR)}` : `section:${el.getAttribute(DRAFT_SECTION_ATTR)}`,
    );
  };

  it('draws a skeleton per entry where the result will land, then section i replaces skeleton i', () => {
    const target = startDraft('replace', root());
    const { container: dom } = renderPage();
    act(() => void store.editorUI.pageGenDraft.setOutline('k1', OUTLINE));
    expect(order(dom)).toEqual(['skeleton:0', 'skeleton:1', 'skeleton:2']);
    const first = dom.querySelector(`[${DRAFT_SKELETON_ATTR}="0"]`)!;
    expect(first).toHaveTextContent('Hero');
    expect(first).toHaveAttribute('aria-hidden', 'true');
    // An entry without a title is named after its place.
    expect(dom.querySelector(`[${DRAFT_SKELETON_ATTR}="1"]`)).toHaveTextContent('Section 2');
    // Skeletons stand for what is coming: no band.
    expect(dom.querySelector(`[${DRAFT_BAND_ATTR}]`)).toBeNull();
    // The draft's own marker, never an agent plan's (the presence frame finds those).
    expect(dom.querySelector(`[${SKELETON_ATTR}]`)).toBeNull();

    act(() => void store.editorUI.pageGenDraft.add('k1', section(HERO, 0, target)));
    expect(order(dom)).toEqual(['section:0', 'skeleton:1', 'skeleton:2']);
    act(() => void store.editorUI.pageGenDraft.add('k1', section(HERO, 1, target)));
    expect(order(dom)).toEqual(['section:0', 'section:1', 'skeleton:2']);
  });

  it('the result, a cancel or a failure drops every skeleton with the draft', () => {
    startDraft('insert', root());
    const { container: dom } = renderPage();
    act(() => void store.editorUI.pageGenDraft.setOutline('k1', OUTLINE));
    expect(dom.querySelectorAll(`[${DRAFT_SKELETON_ATTR}]`)).toHaveLength(3);
    act(() => store.editorUI.pageGenDraft.clear('k1'));
    expect(dom.querySelectorAll(`[${DRAFT_SKELETON_ATTR}]`)).toHaveLength(0);
    expect(dom.querySelector(`[data-inner-component-id="${container.id}"]`)).toBeInTheDocument();
  });

  it('new page: the skeletons fill the draft frames before the first section', () => {
    const target = startDraft('newPage', undefined, 'Our menu');
    act(() => void store.editorUI.pageGenDraft.setOutline('k1', OUTLINE));
    const right = Math.max(...target.viewports.map((v) => v.x + v.width));
    const { container: dom } = render(<DraftPageFrames framesRight={right} />);
    expect(dom.querySelectorAll(`[${DRAFT_SKELETON_ATTR}="0"]`)).toHaveLength(target.viewports.length);
  });

  it('the skeletons are never clickable', () => {
    const { container: dom } = render(<DraftStyles />);
    expect(dom.querySelector('style')!.textContent).toContain(`[${DRAFT_SKELETON_ATTR}] * { pointer-events: none !important; }`);
  });
});

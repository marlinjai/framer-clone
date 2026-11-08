// The per-component reveal on the canvas (plan docs/plans/2026-11-08-live-agent-canvas.md,
// section 4): a node in the reveal store draws with data-live-reveal and its
// delay as --live-reveal-delay (the stylesheet plays fc-live-reveal, and turns
// it off under reduced motion); nothing else does. Created and revealed in one
// action, a node is drawn with its reveal from its very first render.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { runInAction } from 'mobx';
import { createRootStore, type RootStoreType } from '@/stores/RootStore';
import { createIntrinsicComponent, type ComponentInstance } from '@/models/ComponentModel';
import { EditorTool } from '@/stores/EditorUIStore';
import { REVEAL_ATTR } from '@/lib/live/reveal';
import ComponentRenderer from '../ComponentRenderer';

let store: RootStoreType;
vi.mock('@/hooks/useStore', () => ({ useStore: () => store }));

let root: ComponentInstance;
let breakpoints: { id: string; minWidth: number }[];

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  store = createRootStore();
  store.projectStore.createProject('Reveal');
  const project = store.projectStore.findProjectByTitle('Reveal')!;
  const page = project.findPageBySlug('')!;
  store.editorUI.setCurrentProject(project);
  store.editorUI.setCurrentPage(page);
  root = page.appComponentTree as ComponentInstance;
  breakpoints = page.sortedViewportNodes.map((v) => ({ id: v.breakpointId!, minWidth: v.breakpointMinWidth ?? 0 }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const el = (id: string) => document.querySelector<HTMLElement>(`[data-inner-component-id="${id}"]`);
const renderTree = () => render(<ComponentRenderer component={root} breakpointId={breakpoints[0].id} allBreakpoints={breakpoints} />);

/** An agent's section arrives with its reveal, in one action, as LiveSync.adopt does. */
function arrive() {
  runInAction(() => {
    const section = createIntrinsicComponent('new-section', 'section', { style: { padding: '8px' } });
    root.addChild(section);
    (root.children.find((c: ComponentInstance) => c.id === 'new-section') as ComponentInstance).addChild(
      createIntrinsicComponent('new-title', 'h2', { children: 'Hello' }),
    );
    store.editorUI.liveReveal.start(new Map([['new-section', 0], ['new-title', 45]]));
  });
}

describe('ComponentRenderer: the reveal', () => {
  it('draws the new nodes with their delay from the first render, and the rest without', () => {
    renderTree();
    const added: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const r of records) if (r.type === 'attributes' && r.attributeName === REVEAL_ATTR && (r.target as Element).hasAttribute(REVEAL_ATTR)) added.push('late');
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: [REVEAL_ATTR] });
    act(() => arrive());
    expect(el('new-section')?.hasAttribute(REVEAL_ATTR)).toBe(true);
    expect(el('new-section')?.style.getPropertyValue('--live-reveal-delay')).toBe('0ms');
    expect(el('new-section')?.style.padding).toBe('8px'); // its own style kept
    expect(el('new-title')?.style.getPropertyValue('--live-reveal-delay')).toBe('45ms');
    expect(el(root.id)?.hasAttribute(REVEAL_ATTR)).toBe(false);
    // Never added to an element already drawn without it (that would hide it for its delay).
    observer.takeRecords();
    observer.disconnect();
    expect(added).toEqual([]);
  });

  it('drops the reveal once it played, so a later redraw appears at once', () => {
    renderTree();
    act(() => arrive());
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(el('new-section')?.hasAttribute(REVEAL_ATTR)).toBe(false);
    expect(el('new-section')?.style.getPropertyValue('--live-reveal-delay')).toBe('');
  });

  it('a node with an animation of its own authored takes no reveal, so the two never fight', () => {
    renderTree();
    act(() => {
      runInAction(() => {
        root.addChild(createIntrinsicComponent('spin', 'section', { style: { animationDuration: '0s' } }));
        store.editorUI.liveReveal.start(new Map([['spin', 0]]));
      });
    });
    expect(el('spin')).not.toBeNull();
    expect(el('spin')?.hasAttribute(REVEAL_ATTR)).toBe(false);
  });

  it('never in Interact, where the page runs as published', () => {
    store.editorUI.setSelectedTool(EditorTool.INTERACT);
    renderTree();
    act(() => arrive());
    expect(el('new-section')).not.toBeNull();
    expect(document.querySelector(`[${REVEAL_ATTR}]`)).toBeNull();
  });
});

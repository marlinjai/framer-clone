// The page that builds itself (src/lib/ai/pageGen/draft.ts) through the
// Generate dialog, against a REAL editor store and history: the preview
// sections are drawn as a draft that never enters the project, the result
// still lands as ONE undo step, and every way out of a run drops the draft.
// The four stateful-flow paths (forward, backtrack, resume, re-entry) plus the
// history cases of the plan's PR 2 list.

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { getSnapshot } from 'mobx-state-tree';
import { createRootStore, getHistoryStore, type RootStoreType } from '@/stores/RootStore';
import type { ComponentInstance } from '@/models/ComponentModel';
import type { PageGenHandlers, PageGenTransport } from '@/lib/ai/pageGen/client';
import type { PageGenRequest, PageGenResultPayload, PageGenSection } from '@/lib/ai/pageGen/protocol';
import { validateGeneration } from '@/lib/ai/pageGen/validate';
import { deriveBreakpointKeys } from '@/lib/ai/pageGen/schema';

const NO_IMAGES = { requested: 0, resolved: 0, fellBack: {}, credits: [] };

let store: RootStoreType;
vi.mock('@/hooks/useStore', () => ({ useStore: () => store }));

import { GeneratePageDialog } from '../GeneratePageDialog';

function manualTransport() {
  const calls: Array<{ req: PageGenRequest; handlers: PageGenHandlers; signal?: AbortSignal }> = [];
  const transport: PageGenTransport = (req, handlers, signal) =>
    new Promise<void>(() => {
      calls.push({ req, handlers, signal });
    });
  return { transport, calls };
}

function manualResume() {
  const calls: Array<{ id: string; handlers: PageGenHandlers; signal?: AbortSignal }> = [];
  const resume = (id: string, handlers: PageGenHandlers, signal?: AbortSignal) =>
    new Promise<void>(() => {
      calls.push({ id, handlers, signal });
    });
  return { resume, calls };
}

function validated(req: PageGenRequest, raw: unknown) {
  const out = validateGeneration(raw, { breakpoints: deriveBreakpointKeys(req.breakpoints) });
  if (!out.ok) throw new Error(out.errors.join('; '));
  return out.result;
}

function resultFor(req: PageGenRequest, raw: unknown, generationId = 'gen-1'): PageGenResultPayload {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { imageRequests, ...result } = validated(req, raw);
  return { generationId, model: 'claude-haiku-5-5', ...result, images: NO_IMAGES };
}

/** The preview section the server would send for `raw` (one top-level node). */
function sectionFor(req: PageGenRequest, raw: unknown, index: number, generationId = 'gen-1'): PageGenSection {
  return { generationId, index, attempt: 1, node: validated(req, { nodes: [raw] }).nodes[0] };
}

const HERO = { type: 'section', label: 'Hero', children: [{ type: 'h1', props: { children: 'Fresh bread' } }] };
const STORY = { type: 'section', label: 'Story', children: [{ type: 'p', props: { children: 'Since 1952' } }] };
const PAGE = { title: 'Bakery', nodes: [HERO, STORY] };

function project() {
  return store.editorUI.currentProject!;
}
function page() {
  return store.editorUI.currentPage!;
}
function root() {
  return page().appComponentTree as ComponentInstance;
}
function draft() {
  return store.editorUI.pageGenDraft;
}
/** Everything a Save would send: the project's own snapshot. */
function savedJson() {
  return JSON.stringify(getSnapshot(project()));
}

function setup(transport: PageGenTransport, resume?: ReturnType<typeof manualResume>['resume']) {
  return render(<GeneratePageDialog open onOpenChange={vi.fn()} transport={transport} resume={resume} />);
}

function typeBrief(text: string) {
  fireEvent.change(screen.getByLabelText('Brief'), { target: { value: text } });
}

function generate() {
  fireEvent.click(screen.getByRole('button', { name: /^Generate$/ }));
}

let heading: ComponentInstance;
let container: ComponentInstance;

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem('framer-clone:visual-review', JSON.stringify({ auto: false, model: 'SONNET' }));
  store = createRootStore();
  store.projectStore.createProject('Crumb');
  const p = store.projectStore.findProjectByTitle('Crumb')!;
  const home = p.createPage('Home');
  home.insertRegistryComponent('container', { kind: 'appTree' });
  home.insertRegistryComponent('text', { kind: 'appTree' });
  store.editorUI.setCurrentProject(p);
  store.editorUI.setCurrentPage(home);
  container = (home.appComponentTree as ComponentInstance).children[0] as ComponentInstance;
  heading = (home.appComponentTree as ComponentInstance).children[1] as ComponentInstance;
  getHistoryStore()!.clear();
});

afterEach(() => cleanup());

describe('the draft: forward', () => {
  it('draws each section as it arrives, keeps it out of the project, then the result is one undo step', async () => {
    const { transport, calls } = manualTransport();
    setup(transport);
    typeBrief('A bakery');
    generate();
    const req = calls[0].req;
    const homeBefore = savedJson();

    act(() => calls[0].handlers.onSection?.(sectionFor(req, HERO, 0)));
    act(() => calls[0].handlers.onSection?.(sectionFor(req, STORY, 1)));
    expect(draft().target?.kind).toBe('newPage');
    expect(draft().sections.map((s) => s.tree.label)).toEqual(['Hero', 'Story']);
    expect(screen.getByTestId('pagegen-progress-panel')).toHaveTextContent('2 sections on the canvas');

    // Never in the project: not in a save, not in the history.
    const ids = draft().sections.map((s) => s.tree.id);
    expect(ids.every((id) => !savedJson().includes(id))).toBe(true);
    expect(savedJson()).toBe(homeBefore);
    expect(getHistoryStore()!.history.length).toBe(0);

    const homeId = page().id;
    await act(async () => calls[0].handlers.onResult?.(resultFor(req, PAGE)));
    expect(draft().target).toBeUndefined();
    expect(draft().sections).toEqual([]);
    expect(getHistoryStore()!.history.length).toBe(1);
    expect(page().metadata.title).toBe('Bakery');

    // One Cmd+Z: the page from before generation, and no draft anywhere.
    act(() => getHistoryStore()!.undo());
    expect(project().getPage(homeId)).toBeDefined();
    expect(project().pagesArray.some((p) => p.metadata.title === 'Bakery')).toBe(false);
    expect(draft().target).toBeUndefined();
  });

  it('an edit made during the run, the final apply, then two undos: both land', async () => {
    store.editorUI.selectComponent(container);
    const { transport, calls } = manualTransport();
    setup(transport);
    fireEvent.click(screen.getByRole('button', { name: 'Replace selection' }));
    typeBrief('A hero');
    generate();
    const req = calls[0].req;
    act(() => calls[0].handlers.onSection?.(sectionFor(req, HERO, 0)));
    expect(draft().target).toMatchObject({ kind: 'replace', componentId: container.id, targetIsRoot: false });

    // The user keeps working while the page builds itself.
    const textBefore = String(heading.props.children ?? '');
    act(() => heading.setTextContent('Edited during the run'));
    expect(getHistoryStore()!.history.length).toBe(1);

    await act(async () => calls[0].handlers.onResult?.(resultFor(req, { nodes: [HERO] })));
    expect(root().children.map((c: ComponentInstance) => c.label)).toEqual(['Hero', heading.label]);
    expect(getHistoryStore()!.history.length).toBe(2);

    act(() => getHistoryStore()!.undo());
    // The generation is gone, the edit stays.
    expect(root().children.map((c: ComponentInstance) => c.id)).toEqual([container.id, heading.id]);
    expect(heading.props.children).toBe('Edited during the run');
    act(() => getHistoryStore()!.undo());
    expect(heading.props.children ?? '').toBe(textBefore);
    expect(root().children.map((c: ComponentInstance) => c.id)).toEqual([container.id, heading.id]);
  });

  it('marks the page root as replaced by its children, and an insert as after the children', () => {
    store.editorUI.selectComponent(root());
    const { transport } = manualTransport();
    setup(transport);
    fireEvent.click(screen.getByRole('button', { name: 'Replace selection' }));
    typeBrief('A whole page');
    generate();
    expect(draft().target).toMatchObject({ kind: 'replace', componentId: root().id, targetIsRoot: true });
  });

  it('the repair round keeps the first draft and says it is polishing', () => {
    const { transport, calls } = manualTransport();
    setup(transport);
    typeBrief('A bakery');
    generate();
    const req = calls[0].req;
    act(() => calls[0].handlers.onSection?.(sectionFor(req, HERO, 0)));
    act(() => calls[0].handlers.onProgress?.({ phase: 'repairing', receivedChars: 2048, attempt: 2 }));
    expect(draft().phase).toBe('polishing');
    expect(draft().sections).toHaveLength(1);
    expect(screen.getByTestId('pagegen-progress-panel')).toHaveTextContent('Polishing the first draft (2.0 KB)...');
  });
});

describe('the draft: backtrack', () => {
  it('cancel mid-stream leaves the page unchanged and no draft; a revised brief starts a clean one', () => {
    const before = savedJson();
    const { transport, calls } = manualTransport();
    setup(transport);
    typeBrief('A bakery');
    generate();
    act(() => calls[0].handlers.onSection?.(sectionFor(calls[0].req, HERO, 0)));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(calls[0].signal?.aborted).toBe(true);
    expect(draft().target).toBeUndefined();
    expect(savedJson()).toBe(before);
    expect(getHistoryStore()!.history.length).toBe(0);

    typeBrief('A florist');
    generate();
    expect(draft().sections).toEqual([]);
    // A late section of the cancelled run is never drawn into the new one.
    act(() => calls[0].handlers.onSection?.(sectionFor(calls[0].req, STORY, 1)));
    expect(draft().sections).toEqual([]);
    act(() => calls[1].handlers.onSection?.(sectionFor(calls[1].req, STORY, 0, 'gen-2')));
    expect(draft().sections.map((s) => s.tree.label)).toEqual(['Story']);
  });
});

describe('the draft: resume', () => {
  it('a reload mid-stream rebuilds the draft from the collected run (repeats drawn once)', async () => {
    const { transport, calls } = manualTransport();
    const r = manualResume();
    const first = setup(transport, r.resume);
    typeBrief('A bakery');
    generate();
    act(() => calls[0].handlers.onStarted?.('gen-1'));
    const req = calls[0].req;
    act(() => calls[0].handlers.onSection?.(sectionFor(req, HERO, 0)));
    first.unmount(); // iOS discarded the tab
    // Leaving the editor only stops following: the draft goes with the canvas.
    expect(draft().target).toBeUndefined();

    setup(transport, r.resume);
    expect(r.calls.map((c) => c.id)).toEqual(['gen-1']);
    expect(draft().target?.kind).toBe('newPage');
    // Every poll of a running run hands back all its sections so far.
    act(() => {
      r.calls[0].handlers.onSection?.(sectionFor(req, HERO, 0));
      r.calls[0].handlers.onSection?.(sectionFor(req, HERO, 0));
      r.calls[0].handlers.onSection?.(sectionFor(req, STORY, 1));
    });
    expect(draft().sections.map((s) => s.index)).toEqual([0, 1]);
    expect(screen.getByTestId('pagegen-progress-panel')).toHaveTextContent('2 sections on the canvas');

    await act(async () => r.calls[0].handlers.onResult?.(resultFor(req, PAGE)));
    expect(draft().target).toBeUndefined();
    expect(page().metadata.title).toBe('Bakery');
    expect(getHistoryStore()!.history.length).toBe(1);
  });
});

describe('the draft: re-entry', () => {
  it('generate another after a result starts from an empty draft', async () => {
    const { transport, calls } = manualTransport();
    setup(transport);
    typeBrief('A bakery');
    generate();
    act(() => calls[0].handlers.onSection?.(sectionFor(calls[0].req, HERO, 0)));
    await act(async () => calls[0].handlers.onResult?.(resultFor(calls[0].req, PAGE)));
    fireEvent.click(screen.getByRole('button', { name: 'Generate another' }));
    typeBrief('A florist');
    generate();
    expect(draft().target).toBeDefined();
    expect(draft().sections).toEqual([]);
  });

  it('an error drops the draft and changes nothing; the next run works', async () => {
    const before = savedJson();
    const { transport, calls } = manualTransport();
    setup(transport);
    typeBrief('A bakery');
    generate();
    act(() => calls[0].handlers.onSection?.(sectionFor(calls[0].req, HERO, 0)));
    act(() => calls[0].handlers.onError?.({ code: 'overloaded', message: 'busy' }));
    expect(draft().target).toBeUndefined();
    expect(screen.getByRole('alert')).toHaveTextContent('overloaded');
    expect(savedJson()).toBe(before);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    act(() => calls[1].handlers.onSection?.(sectionFor(calls[1].req, STORY, 0)));
    expect(draft().sections.map((s) => s.tree.label)).toEqual(['Story']);
    await act(async () => calls[1].handlers.onResult?.(resultFor(calls[1].req, PAGE)));
    expect(draft().target).toBeUndefined();
    expect(getHistoryStore()!.history.length).toBe(1);
  });

  it('a result that cannot be applied drops the draft and says why', async () => {
    store.editorUI.selectComponent(container);
    const { transport, calls } = manualTransport();
    setup(transport);
    fireEvent.click(screen.getByRole('button', { name: 'Replace selection' }));
    typeBrief('A hero');
    generate();
    act(() => calls[0].handlers.onSection?.(sectionFor(calls[0].req, HERO, 0)));
    act(() => {
      page().deleteComponent(container.id);
    });
    await act(async () => calls[0].handlers.onResult?.(resultFor(calls[0].req, { nodes: [HERO] })));
    expect(draft().target).toBeUndefined();
    expect(screen.getByRole('alert')).toHaveTextContent('Nothing was changed');
  });
});

describe('the apply and the per-component reveal (live agent canvas, slice 3)', () => {
  const reveal = () => store.editorUI.liveReveal;
  const subtree = (id: string) => {
    const ids: string[] = [];
    const walk = (n: ComponentInstance) => {
      ids.push(n.id);
      for (const c of n.children) walk(c as ComponentInstance);
    };
    const find = (n: ComponentInstance): ComponentInstance | undefined =>
      n.id === id ? n : n.children.map((c: unknown) => find(c as ComponentInstance)).find(Boolean);
    walk(find(root())!);
    return ids;
  };

  it('sections the draft drew stay still; the result applies without a second reveal', async () => {
    const { transport, calls } = manualTransport();
    setup(transport);
    typeBrief('A bakery');
    generate();
    const req = calls[0].req;
    act(() => calls[0].handlers.onSection?.(sectionFor(req, HERO, 0)));
    act(() => calls[0].handlers.onSection?.(sectionFor(req, STORY, 1)));
    await act(async () => calls[0].handlers.onResult?.(resultFor(req, PAGE)));
    expect(page().metadata.title).toBe('Bakery');
    expect(reveal().size).toBe(0);
  });

  it('a section the draft never drew reveals node by node as the result lands', async () => {
    const { transport, calls } = manualTransport();
    setup(transport);
    typeBrief('A bakery');
    generate();
    const req = calls[0].req;
    act(() => calls[0].handlers.onSection?.(sectionFor(req, HERO, 0)));
    const result = resultFor(req, PAGE);
    await act(async () => calls[0].handlers.onResult?.(result));
    const story = subtree(result.nodes[1].id);
    expect(story).toHaveLength(2);
    expect([...reveal().delays.entries()]).toEqual(story.map((id, i) => [id, i * 45]));
    // Volatile: never in what a save sends, never a step of its own in the history.
    expect(savedJson()).not.toContain('liveReveal');
    expect(getHistoryStore()!.history.length).toBe(1);
  });

  it('no stream at all: the whole result reveals, in document order', async () => {
    store.editorUI.selectComponent(container);
    const { transport, calls } = manualTransport();
    setup(transport);
    fireEvent.click(screen.getByRole('button', { name: 'Replace selection' }));
    typeBrief('Two sections');
    generate();
    const req = calls[0].req;
    const result = resultFor(req, { nodes: [HERO, STORY] });
    await act(async () => calls[0].handlers.onResult?.(result));
    const ids = [...subtree(result.nodes[0].id), ...subtree(result.nodes[1].id)];
    expect([...reveal().delays.keys()]).toEqual(ids);
  });

  it('a failed run reveals nothing', () => {
    const { transport, calls } = manualTransport();
    setup(transport);
    typeBrief('A bakery');
    generate();
    act(() => calls[0].handlers.onError?.({ code: 'model_failed', message: 'nope' } as never));
    expect(reveal().size).toBe(0);
  });
});

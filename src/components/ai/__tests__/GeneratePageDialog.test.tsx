// The Generate dialog against a REAL editor store, with an injected transport
// (no network). Covers the four stateful-flow paths at the UI level plus the
// error surfaces (provider down, invalid output, quota) and the undo button.

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRootStore, getHistoryStore, type RootStoreType } from '@/stores/RootStore';
import type { ComponentInstance } from '@/models/ComponentModel';
import type { PageGenHandlers, PageGenTransport } from '@/lib/ai/pageGen/client';
import type { PageGenRequest, PageGenResultPayload } from '@/lib/ai/pageGen/protocol';
import { validateGeneration } from '@/lib/ai/pageGen/validate';
import { deriveBreakpointKeys } from '@/lib/ai/pageGen/schema';

let store: RootStoreType;
let initialPages = 0;
vi.mock('@/hooks/useStore', () => ({ useStore: () => store }));

import { GeneratePageDialog } from '../GeneratePageDialog';

/** A transport the test drives by hand: each call is captured and resolved later. */
function manualTransport() {
  const calls: Array<{ req: PageGenRequest; handlers: PageGenHandlers; signal?: AbortSignal; finish: () => void }> = [];
  const transport: PageGenTransport = (req, handlers, signal) =>
    new Promise<void>((resolve) => {
      calls.push({ req, handlers, signal, finish: resolve });
    });
  return { transport, calls };
}

function resultFor(req: PageGenRequest, raw: unknown, generationId = 'gen-1'): PageGenResultPayload {
  const out = validateGeneration(raw, { breakpoints: deriveBreakpointKeys(req.breakpoints) });
  if (!out.ok) throw new Error(out.errors.join('; '));
  return { generationId, model: 'claude-sonnet-4-6', ...out.result };
}

const PAGE = {
  title: 'Bakery',
  nodes: [
    { type: 'section', label: 'Hero', children: [{ type: 'h1', props: { children: 'Fresh bread' } }] },
    { type: 'footer', label: 'Footer', props: { children: 'Bye' } },
  ],
};

function setup(transport: PageGenTransport) {
  const onOpenChange = vi.fn();
  const utils = render(<GeneratePageDialog open onOpenChange={onOpenChange} transport={transport} />);
  return { ...utils, onOpenChange };
}

function typeBrief(text: string) {
  fireEvent.change(screen.getByLabelText('Brief'), { target: { value: text } });
}

beforeEach(() => {
  window.localStorage.clear();
  store = createRootStore();
  store.projectStore.createProject('Crumb');
  const project = store.projectStore.findProjectByTitle('Crumb')!;
  const page = project.createPage('Home');
  page.insertRegistryComponent('container', { kind: 'appTree' });
  store.editorUI.setCurrentProject(project);
  store.editorUI.setCurrentPage(page);
  getHistoryStore()!.clear();
  initialPages = project.pages.size;
});

afterEach(() => cleanup());

function project() {
  return store.editorUI.currentProject!;
}

describe('GeneratePageDialog forward', () => {
  it('generates a new page: progress, apply as one history entry, select it, undo removes it', async () => {
    const { transport, calls } = manualTransport();
    setup(transport);
    const generate = screen.getByRole('button', { name: /^Generate$/ });
    expect(generate).toBeDisabled(); // empty brief
    typeBrief('A bakery landing page');
    fireEvent.click(generate);

    expect(calls).toHaveLength(1);
    expect(calls[0].req).toMatchObject({ brief: 'A bakery landing page', model: 'SONNET', target: { kind: 'newPage' } });
    expect(screen.getByLabelText('Brief')).toBeDisabled();

    act(() => calls[0].handlers.onProgress?.({ phase: 'generating', receivedChars: 4096, attempt: 1 }));
    expect(screen.getByText('Designing (4.0 KB written)...')).toBeInTheDocument();

    const homeId = store.editorUI.currentPage!.id;
    await act(async () => {
      calls[0].handlers.onResult?.(resultFor(calls[0].req, PAGE));
      calls[0].finish();
    });
    expect(screen.getByText(/Added 3 components on a new page/)).toBeInTheDocument();
    expect(project().pages.size).toBe(initialPages + 1);
    const created = store.editorUI.currentPage!;
    expect(created.id).not.toBe(homeId);
    expect(created.metadata.title).toBe('Bakery');
    expect(store.editorUI.selectedComponent?.label).toBe('Hero');
    expect(getHistoryStore()!.history.length).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: /Undo \(remove page\)/ }));
    expect(project().pages.size).toBe(initialPages);
    expect(store.editorUI.currentPage!.id).toBe(homeId);
    expect(screen.getByText('The generation was undone.')).toBeInTheDocument();
  });

  it('replaces the selected component and the Undo button restores it', async () => {
    const page = store.editorUI.currentPage!;
    const container = (page.appComponentTree as ComponentInstance).children[0] as ComponentInstance;
    store.editorUI.selectComponent(container);
    const { transport, calls } = manualTransport();
    setup(transport);
    fireEvent.click(screen.getByRole('button', { name: 'Replace selection' }));
    expect(screen.getByText('Replace "Container"')).toBeInTheDocument();
    typeBrief('A hero');
    fireEvent.click(screen.getByRole('button', { name: /^Generate$/ }));
    expect(calls[0].req.target.kind).toBe('replace');
    await act(async () => calls[0].handlers.onResult?.(resultFor(calls[0].req, PAGE)));
    const root = page.appComponentTree as ComponentInstance;
    expect(root.children.map((c: ComponentInstance) => c.label)).toEqual(['Hero', 'Footer']);

    fireEvent.click(screen.getByRole('button', { name: /Undo generation/ }));
    expect(root.children.map((c: ComponentInstance) => c.id)).toEqual([container.id]);
  });

  it('a failed undo (already undone with Cmd+Z) says why', async () => {
    store.editorUI.selectComponent(store.editorUI.currentPage!.appComponentTree as ComponentInstance);
    const { transport, calls } = manualTransport();
    setup(transport);
    fireEvent.click(screen.getByRole('button', { name: 'Add to selection' }));
    typeBrief('A footer');
    fireEvent.click(screen.getByRole('button', { name: /^Generate$/ }));
    await act(async () => calls[0].handlers.onResult?.(resultFor(calls[0].req, PAGE)));
    act(() => getHistoryStore()!.undo());
    fireEvent.click(screen.getByRole('button', { name: /Undo generation/ }));
    expect(screen.getByRole('alert')).toHaveTextContent('This generation was already undone.');
  });
});

describe('GeneratePageDialog errors surface, nothing is applied', () => {
  it.each([
    [{ code: 'provider_unavailable', message: 'x' }, /AI provider is unavailable/],
    [{ code: 'invalid_output', message: 'x', details: ['nodes[0]: node must be an object'] }, /cannot use, so nothing was changed/],
    [{ code: 'rate_limited', message: 'Generation limit reached. Try again in 42 seconds.', retryAfterSec: 42 }, /42 seconds/],
    [{ code: 'authz_unavailable', message: 'x' }, /permission service is unavailable/],
  ])('%j', async (error, text) => {
    const { transport, calls } = manualTransport();
    setup(transport);
    typeBrief('A page');
    fireEvent.click(screen.getByRole('button', { name: /^Generate$/ }));
    await act(async () => calls[0].handlers.onError?.(error));
    expect(screen.getByRole('alert')).toHaveTextContent(text);
    if ('details' in error && error.details) expect(screen.getByText(error.details[0])).toBeInTheDocument();
    expect(project().pages.size).toBe(initialPages);
    expect(getHistoryStore()!.history.length).toBe(0);
    // Inputs are kept for the retry.
    expect(screen.getByLabelText('Brief')).toHaveValue('A page');
    expect(screen.getByRole('button', { name: /Try again/ })).toBeEnabled();
  });

  it('a target that vanished while generating is not replaced by something else', async () => {
    const page = store.editorUI.currentPage!;
    const container = (page.appComponentTree as ComponentInstance).children[0] as ComponentInstance;
    store.editorUI.selectComponent(container);
    const { transport, calls } = manualTransport();
    setup(transport);
    fireEvent.click(screen.getByRole('button', { name: 'Replace selection' }));
    typeBrief('A hero');
    fireEvent.click(screen.getByRole('button', { name: /^Generate$/ }));
    act(() => {
      page.deleteComponent(container.id);
    });
    await act(async () => calls[0].handlers.onResult?.(resultFor(calls[0].req, PAGE)));
    expect(screen.getByRole('alert')).toHaveTextContent(/Nothing was changed: The selected component no longer exists/);
    expect((page.appComponentTree as ComponentInstance).children).toHaveLength(0);
  });

  it('explains why a target is unavailable and blocks Generate', () => {
    store.editorUI.selectComponent(undefined);
    const { transport } = manualTransport();
    setup(transport);
    fireEvent.click(screen.getByRole('button', { name: 'Replace selection' }));
    typeBrief('x');
    expect(screen.getByText('Select a component on the canvas first.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Generate$/ })).toBeDisabled();
  });
});

describe('GeneratePageDialog backtrack and revise', () => {
  it('cancel aborts the request; its late result is never applied; a revised brief runs fresh', async () => {
    const { transport, calls } = manualTransport();
    setup(transport);
    typeBrief('A bakery');
    fireEvent.click(screen.getByRole('button', { name: /^Generate$/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(calls[0].signal?.aborted).toBe(true);
    typeBrief('A florist');
    fireEvent.click(screen.getByRole('button', { name: /^Generate$/ }));
    expect(calls[1].req.brief).toBe('A florist');

    await act(async () => calls[0].handlers.onResult?.(resultFor(calls[0].req, PAGE, 'stale')));
    expect(project().pages.size).toBe(initialPages); // the cancelled run did not land
    await act(async () => calls[1].handlers.onResult?.(resultFor(calls[1].req, PAGE, 'fresh')));
    expect(project().pages.size).toBe(initialPages + 1);
  });

  it('closing the dialog while running aborts it', () => {
    const { transport, calls } = manualTransport();
    setup(transport);
    typeBrief('A bakery');
    fireEvent.click(screen.getByRole('button', { name: /^Generate$/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(calls[0].signal?.aborted).toBe(true);
  });
});

describe('GeneratePageDialog resume and re-entry', () => {
  it('keeps the draft across a close and re-open, scoped to the project', () => {
    const { transport } = manualTransport();
    const { unmount } = setup(transport);
    typeBrief('Half-written brief');
    fireEvent.click(screen.getByRole('button', { name: 'Fast' }));
    unmount();
    setup(transport);
    expect(screen.getByLabelText('Brief')).toHaveValue('Half-written brief');
    expect(screen.getByRole('button', { name: 'Fast' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('re-opening after a completed generation starts clean (no stale result, draft cleared)', async () => {
    const { transport, calls } = manualTransport();
    const first = setup(transport);
    typeBrief('A bakery');
    fireEvent.click(screen.getByRole('button', { name: /^Generate$/ }));
    await act(async () => calls[0].handlers.onResult?.(resultFor(calls[0].req, PAGE)));
    first.unmount();
    setup(transport);
    expect(screen.queryByText(/Added/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Brief')).toHaveValue('');
  });

  it('"Generate another" returns to the form without the old result', async () => {
    const { transport, calls } = manualTransport();
    setup(transport);
    typeBrief('A bakery');
    fireEvent.click(screen.getByRole('button', { name: /^Generate$/ }));
    await act(async () => calls[0].handlers.onResult?.(resultFor(calls[0].req, PAGE)));
    fireEvent.click(screen.getByRole('button', { name: 'Generate another' }));
    expect(screen.getByLabelText('Brief')).toHaveValue('');
    expect(screen.queryByText(/Added/)).not.toBeInTheDocument();
  });
});

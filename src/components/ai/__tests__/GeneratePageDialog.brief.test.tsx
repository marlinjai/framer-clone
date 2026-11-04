// The Generate dialog's idea row and Enhance against a REAL editor store, with
// an injected BriefApi and transport (no network). Covers the four
// stateful-flow paths (knowledge-base/standards/stateful-flow-testing.md):
// forward (pick an idea, generate), backtrack (enhance, undo, edit, enhance
// again), resume (reload with a saved draft, a reload mid-stream keeps the
// original) and re-entry ("Generate another" shows the ideas again), plus a
// stream cut off midway, Stop, a 429 and keyboard use of the chips.

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createRootStore, getHistoryStore, type RootStoreType } from '@/stores/RootStore';
import type { PageGenHandlers, PageGenTransport } from '@/lib/ai/pageGen/client';
import type { PageGenRequest, PageGenResultPayload } from '@/lib/ai/pageGen/protocol';
import type { BriefApi, BriefResult } from '@/lib/ai/brief/client';
import type { EnhanceRequest, IdeasRequest, PageIdea } from '@/lib/ai/brief/schema';
import { validateGeneration } from '@/lib/ai/pageGen/validate';
import { deriveBreakpointKeys } from '@/lib/ai/pageGen/schema';

let store: RootStoreType;
vi.mock('@/hooks/useStore', () => ({ useStore: () => store }));

import { GeneratePageDialog } from '../GeneratePageDialog';
import { __resetIdeaCacheForTests } from '../IdeaBar';

// ---------- fakes ----------

function manualTransport() {
  const calls: Array<{ req: PageGenRequest; handlers: PageGenHandlers; finish: () => void }> = [];
  const transport: PageGenTransport = (req, handlers) =>
    new Promise<void>((resolve) => calls.push({ req, handlers, finish: resolve }));
  return { transport, calls };
}

function manualBriefApi() {
  const ideaCalls: Array<{ req: IdeasRequest; resolve: (r: BriefResult<PageIdea[]>) => void }> = [];
  const enhanceCalls: Array<{
    req: EnhanceRequest;
    onDelta: (t: string) => void;
    signal?: AbortSignal;
    resolve: (r: BriefResult<string>) => void;
  }> = [];
  const api: BriefApi = {
    fetchIdeas: (req) => new Promise((resolve) => ideaCalls.push({ req, resolve })),
    enhance: (req, onDelta, signal) => new Promise((resolve) => enhanceCalls.push({ req, onDelta, signal, resolve })),
  };
  return { api, ideaCalls, enhanceCalls };
}

const TAILORED: PageIdea[] = [
  { title: 'Sourdough class', brief: 'A page for the weekend sourdough class.' },
  { title: 'Wholesale', brief: 'A page for cafes ordering bread wholesale.' },
  { title: 'Seasonal bakes', brief: 'A page for the seasonal bakes.' },
  { title: 'Our flour', brief: 'A page about the mill and the flour.' },
  { title: 'Cakes to order', brief: 'A page for celebration cakes to order.' },
  { title: 'Visit us', brief: 'A page with directions and opening hours.' },
];
const MORE: PageIdea[] = TAILORED.map((i) => ({ title: `${i.title} 2`, brief: `${i.brief} Again.` }));

const NO_IMAGES = { requested: 0, resolved: 0, fellBack: {}, credits: [] };
function resultFor(req: PageGenRequest): PageGenResultPayload {
  const raw = { title: 'Bakery', nodes: [{ type: 'section', label: 'Hero', children: [{ type: 'h1', props: { children: 'Bread' } }] }] };
  const out = validateGeneration(raw, { breakpoints: deriveBreakpointKeys(req.breakpoints) });
  if (!out.ok) throw new Error(out.errors.join('; '));
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { imageRequests, ...result } = out.result;
  return { generationId: 'gen-1', model: 'claude-sonnet-5-5', ...result, images: NO_IMAGES };
}

// ---------- helpers ----------

function setup(api: BriefApi, transport: PageGenTransport = manualTransport().transport) {
  const onOpenChange = vi.fn();
  const utils = render(<GeneratePageDialog open onOpenChange={onOpenChange} transport={transport} briefApi={api} />);
  return { ...utils, onOpenChange };
}

const brief = () => screen.getByLabelText('Brief') as HTMLTextAreaElement;
const typeBrief = (text: string) => fireEvent.change(brief(), { target: { value: text } });
const toolbar = () => screen.getByRole('toolbar', { name: /Ideas/ });
const chip = (name: string) => within(toolbar()).getByRole('button', { name });
const draftKey = () => `framer-clone:page-gen-draft:${store.editorUI.currentProject!.id}`;
const savedBrief = () => {
  const raw = window.localStorage.getItem(draftKey());
  return raw ? (JSON.parse(raw) as { inputs: { brief: string } }).inputs.brief : undefined;
};

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem('framer-clone:visual-review', JSON.stringify({ auto: false, model: 'SONNET' }));
  __resetIdeaCacheForTests();
  store = createRootStore();
  store.projectStore.createProject('Crumb');
  const project = store.projectStore.findProjectByTitle('Crumb')!;
  const page = project.createPage('Home');
  page.insertRegistryComponent('container', { kind: 'appTree' });
  store.editorUI.setCurrentProject(project);
  store.editorUI.setCurrentPage(page);
  getHistoryStore()!.clear();
});

afterEach(() => cleanup());

// ---------- the idea row ----------

describe('idea row', () => {
  it('shows the static ideas at once, then the tailored set for this site while untouched', async () => {
    const { api, ideaCalls } = manualBriefApi();
    setup(api);
    expect(chip('Landing page')).toBeInTheDocument();
    expect(within(toolbar()).getAllByRole('button')).toHaveLength(6);
    expect(screen.getByTestId('pagegen-ideas-skeleton')).toBeInTheDocument();
    expect(toolbar()).toHaveAttribute('aria-busy', 'true');
    expect(ideaCalls).toHaveLength(1);
    expect(ideaCalls[0].req).toMatchObject({ targetKind: 'newPage', projectName: 'Crumb', existingPageTitles: expect.arrayContaining(['Home']) });

    await act(async () => ideaCalls[0].resolve({ ok: true, value: TAILORED }));
    expect(chip('Sourdough class')).toBeInTheDocument();
    expect(screen.queryByText('Landing page')).not.toBeInTheDocument();
    expect(screen.getByText('Ideas for this site')).toBeInTheDocument();
    expect(screen.queryByTestId('pagegen-ideas-skeleton')).not.toBeInTheDocument();
    // The brief is the chip's tooltip and its accessible description.
    expect(chip('Sourdough class')).toHaveAttribute('title', TAILORED[0].brief);
    expect(chip('Sourdough class')).toHaveAccessibleDescription(TAILORED[0].brief);
  });

  it('once the row was touched, the tailored set waits behind the button, and More ideas then fetches a fresh set', async () => {
    const { api, ideaCalls } = manualBriefApi();
    setup(api);
    fireEvent.focus(chip('Landing page'));
    await act(async () => ideaCalls[0].resolve({ ok: true, value: TAILORED }));
    expect(chip('Landing page')).toBeInTheDocument(); // nothing moved under the user

    fireEvent.click(screen.getByRole('button', { name: /Show ideas for this site/ }));
    expect(chip('Sourdough class')).toBeInTheDocument();
    expect(ideaCalls).toHaveLength(1); // shown without a fetch

    fireEvent.click(screen.getByRole('button', { name: /More ideas/ }));
    expect(ideaCalls).toHaveLength(2);
    expect(ideaCalls[1].req.exclude).toEqual(TAILORED.map((i) => i.title));
    await act(async () => ideaCalls[1].resolve({ ok: true, value: MORE }));
    expect(chip('Sourdough class 2')).toBeInTheDocument();
  });

  it('a failed tailored load keeps the static ideas and says why; a failed More ideas is an alert with the wait', async () => {
    const { api, ideaCalls } = manualBriefApi();
    setup(api);
    await act(async () =>
      ideaCalls[0].resolve({ ok: false, error: { code: 'network_error', message: 'Could not reach the server.' } }),
    );
    expect(chip('Landing page')).toBeInTheDocument();
    expect(screen.getByText(/ideas for this site could not load\. Could not reach the server\./)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /More ideas/ }));
    await act(async () =>
      ideaCalls[1].resolve({ ok: false, error: { code: 'rate_limited', message: 'Idea limit reached. Try again in 30 seconds.', retryAfterSec: 30 } }),
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Idea limit reached. Try again in 30 seconds.');
  });

  it('is one tab stop; arrow keys, Home and End move between chips', async () => {
    const { api } = manualBriefApi();
    setup(api);
    const buttons = within(toolbar()).getAllByRole('button');
    expect(buttons.filter((b) => b.tabIndex === 0)).toHaveLength(1);
    buttons[0].focus();
    fireEvent.keyDown(buttons[0], { key: 'ArrowRight' });
    expect(document.activeElement).toBe(buttons[1]);
    expect(buttons[1].tabIndex).toBe(0);
    expect(buttons[0].tabIndex).toBe(-1);
    fireEvent.keyDown(buttons[1], { key: 'End' });
    expect(document.activeElement).toBe(buttons[5]);
    fireEvent.keyDown(buttons[5], { key: 'ArrowRight' });
    expect(document.activeElement).toBe(buttons[0]); // wraps
    fireEvent.keyDown(buttons[0], { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(buttons[5]);
    fireEvent.keyDown(buttons[5], { key: 'Home' });
    expect(document.activeElement).toBe(buttons[0]);
  });

  it('asks for section ideas with the selected component when replacing it', () => {
    const page = store.editorUI.currentPage!;
    store.editorUI.selectComponent(page.appComponentTree.children[0]);
    const { api, ideaCalls } = manualBriefApi();
    setup(api);
    fireEvent.click(screen.getByRole('button', { name: 'Replace selection' }));
    const last = ideaCalls[ideaCalls.length - 1];
    expect(last.req.targetKind).toBe('replace');
    expect(last.req.context).toBeTruthy();
    expect(chip('Landing page')).toHaveAttribute('title', expect.stringMatching(/^A hero section/));
  });
});

// ---------- forward ----------

describe('forward: pick an idea, generate', () => {
  it('fills an empty brief without an undo, and the generation gets that brief', async () => {
    const { api } = manualBriefApi();
    const { transport, calls } = manualTransport();
    setup(api, transport);
    fireEvent.click(chip('Pricing'));
    expect(brief().value).toMatch(/^A pricing page/);
    expect(screen.queryByRole('button', { name: /^Undo/ })).not.toBeInTheDocument();
    expect(savedBrief()).toMatch(/^A pricing page/);

    fireEvent.click(screen.getByRole('button', { name: /^Generate$/ }));
    expect(calls[0].req.brief).toMatch(/^A pricing page/);
  });

  it('never overwrites typed text without an undo', () => {
    const { api } = manualBriefApi();
    setup(api);
    typeBrief('my own words');
    fireEvent.click(chip('Contact'));
    expect(brief().value).toMatch(/^A contact page/);
    expect(screen.getByText(/Your brief was replaced with the idea "Contact"/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(brief().value).toBe('my own words');
    expect(savedBrief()).toBe('my own words');
  });
});

// ---------- backtrack ----------

describe('backtrack: enhance, undo, edit, enhance again', () => {
  it('streams into a read-only brief, undoes to the original, and an edit drops the undo copy', async () => {
    const { api, enhanceCalls } = manualBriefApi();
    setup(api);
    const enhanceBtn = screen.getByRole('button', { name: /Enhance/ });
    expect(enhanceBtn).toBeDisabled(); // empty brief
    typeBrief('bakery page');
    fireEvent.click(screen.getByRole('button', { name: /Enhance/ }));
    expect(enhanceCalls[0].req).toMatchObject({ brief: 'bakery page', targetKind: 'newPage', projectName: 'Crumb' });
    expect(brief()).toHaveAttribute('readonly');
    expect(brief()).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: /Stop/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Generate$/ })).toBeDisabled();
    expect(within(toolbar()).getAllByRole('button')[0]).toBeDisabled();

    act(() => enhanceCalls[0].onDelta('A landing page'));
    expect(brief().value).toBe('A landing page');
    act(() => enhanceCalls[0].onDelta(' for a bakery'));
    expect(brief().value).toBe('A landing page for a bakery');
    expect(savedBrief()).toBe('bakery page'); // the partial text is never persisted

    // Editing another field mid-stream saves the settled brief, not the partial text.
    fireEvent.change(screen.getByLabelText(/Page title/), { target: { value: 'Bakery' } });
    expect(savedBrief()).toBe('bakery page');

    await act(async () => enhanceCalls[0].resolve({ ok: true, value: 'A landing page for a bakery.' }));
    expect(brief().value).toBe('A landing page for a bakery.');
    expect(brief()).not.toHaveAttribute('readonly');
    expect(savedBrief()).toBe('A landing page for a bakery.');

    fireEvent.click(screen.getByRole('button', { name: /Undo enhance/ }));
    expect(brief().value).toBe('bakery page');
    expect(savedBrief()).toBe('bakery page');

    typeBrief('bakery page with cakes');
    fireEvent.click(screen.getByRole('button', { name: /Enhance/ }));
    expect(enhanceCalls[1].req.brief).toBe('bakery page with cakes');
    await act(async () => enhanceCalls[1].resolve({ ok: true, value: 'A bakery page with cakes.' }));
    expect(screen.getByRole('button', { name: /Undo enhance/ })).toBeInTheDocument();

    // The next edit drops the undo copy for good, even when typed back.
    typeBrief('A bakery page with cakes!');
    expect(screen.queryByRole('button', { name: /Undo enhance/ })).not.toBeInTheDocument();
    typeBrief('A bakery page with cakes.');
    expect(screen.queryByRole('button', { name: /Undo enhance/ })).not.toBeInTheDocument();
  });

  it('a stream cut off midway restores the original and shows the error', async () => {
    const { api, enhanceCalls } = manualBriefApi();
    setup(api);
    typeBrief('bakery page');
    fireEvent.click(screen.getByRole('button', { name: /Enhance/ }));
    act(() => enhanceCalls[0].onDelta('A landing pa'));
    await act(async () =>
      enhanceCalls[0].resolve({
        ok: false,
        error: { code: 'stream_interrupted', message: 'The connection dropped while the brief was being rewritten.' },
      }),
    );
    expect(brief().value).toBe('bakery page');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The connection dropped while the brief was being rewritten. Your brief is unchanged.',
    );
    expect(savedBrief()).toBe('bakery page');
    expect(screen.queryByRole('button', { name: /Undo enhance/ })).not.toBeInTheDocument();
    // An edit clears the stale error.
    typeBrief('bakery page!');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a 429 says how long to wait, and Stop aborts and restores the original', async () => {
    const { api, enhanceCalls } = manualBriefApi();
    setup(api);
    typeBrief('bakery page');
    fireEvent.click(screen.getByRole('button', { name: /Enhance/ }));
    await act(async () =>
      enhanceCalls[0].resolve({
        ok: false,
        error: { code: 'rate_limited', message: 'Enhance limit reached. Try again in 42 seconds.', retryAfterSec: 42 },
      }),
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Try again in 42 seconds');

    fireEvent.click(screen.getByRole('button', { name: /Enhance/ }));
    act(() => enhanceCalls[1].onDelta('Half'));
    fireEvent.click(screen.getByRole('button', { name: /Stop/ }));
    expect(enhanceCalls[1].signal?.aborted).toBe(true);
    await act(async () => enhanceCalls[1].resolve({ ok: false, error: { code: 'aborted', message: 'Stopped.' } }));
    expect(brief().value).toBe('bakery page');
    expect(screen.getByText('Enhance stopped. Your brief is unchanged.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('closing the dialog while enhancing stops it and keeps the original', async () => {
    const { api, enhanceCalls } = manualBriefApi();
    const { rerender } = setup(api);
    typeBrief('bakery page');
    fireEvent.click(screen.getByRole('button', { name: /Enhance/ }));
    act(() => enhanceCalls[0].onDelta('Half'));
    rerender(<GeneratePageDialog open={false} onOpenChange={() => {}} briefApi={api} />);
    expect(enhanceCalls[0].signal?.aborted).toBe(true);
    await act(async () => enhanceCalls[0].resolve({ ok: false, error: { code: 'aborted', message: 'Stopped.' } }));
    expect(savedBrief()).toBe('bakery page');
  });
});

// ---------- resume ----------

describe('resume: reload with a saved draft', () => {
  it('a reload mid-stream finds the original brief; a finished rewrite is what reopens', async () => {
    const first = manualBriefApi();
    const view = setup(first.api);
    typeBrief('bakery page');
    fireEvent.click(screen.getByRole('button', { name: /Enhance/ }));
    act(() => first.enhanceCalls[0].onDelta('A landing page'));
    view.unmount(); // the tab reloads mid-stream
    expect(first.enhanceCalls[0].signal?.aborted).toBe(true);

    const second = manualBriefApi();
    const again = setup(second.api);
    expect(brief().value).toBe('bakery page');
    fireEvent.click(screen.getByRole('button', { name: /Enhance/ }));
    await act(async () => second.enhanceCalls[0].resolve({ ok: true, value: 'A landing page for a bakery.' }));
    again.unmount();

    setup(manualBriefApi().api);
    expect(brief().value).toBe('A landing page for a bakery.');
    // The undo copy lives in memory only: none after a reload.
    expect(screen.queryByRole('button', { name: /Undo enhance/ })).not.toBeInTheDocument();
  });

  it('reopening in the same session reuses the cached tailored ideas without a new call', async () => {
    const { api, ideaCalls } = manualBriefApi();
    const view = setup(api);
    await act(async () => ideaCalls[0].resolve({ ok: true, value: TAILORED }));
    view.unmount();
    setup(api);
    expect(chip('Sourdough class')).toBeInTheDocument();
    expect(ideaCalls).toHaveLength(1);
  });

  it('a cached set never shows a title that became a page since it was cached', async () => {
    const { api, ideaCalls } = manualBriefApi();
    const view = setup(api);
    await act(async () => ideaCalls[0].resolve({ ok: true, value: TAILORED }));
    view.unmount();
    store.editorUI.currentProject!.createPage('Wholesale');
    setup(api);
    expect(chip('Sourdough class')).toBeInTheDocument();
    expect(within(toolbar()).queryByRole('button', { name: 'Wholesale' })).not.toBeInTheDocument();
  });

  it('More ideas excludes the titles of every set shown, not only the one on screen', async () => {
    const { api, ideaCalls } = manualBriefApi();
    setup(api);
    await act(async () => ideaCalls[0].resolve({ ok: true, value: TAILORED }));
    fireEvent.click(screen.getByRole('button', { name: /More ideas/ }));
    await act(async () => ideaCalls[1].resolve({ ok: true, value: MORE }));
    fireEvent.click(screen.getByRole('button', { name: /More ideas/ }));
    expect(ideaCalls[2].req.exclude).toEqual([...TAILORED, ...MORE].map((i) => i.title));
  });
});

// ---------- re-entry ----------

describe('re-entry: generate another', () => {
  it('after a generation, "Generate another" shows the ideas again', async () => {
    const { api, ideaCalls } = manualBriefApi();
    const { transport, calls } = manualTransport();
    setup(api, transport);
    await act(async () => ideaCalls[0].resolve({ ok: true, value: TAILORED }));
    fireEvent.click(chip('Wholesale'));
    fireEvent.click(screen.getByRole('button', { name: /^Generate$/ }));
    await act(async () => {
      calls[0].handlers.onResult?.(resultFor(calls[0].req));
      calls[0].finish();
    });
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Generate another' }));
    expect(brief().value).toBe('');
    expect(chip('Sourdough class')).toBeInTheDocument();
    expect(ideaCalls).toHaveLength(1);
    fireEvent.click(chip('Visit us'));
    expect(brief().value).toBe(TAILORED[5].brief);
  });
});

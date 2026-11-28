// The Custom code section in the real RightSidebar, on a real store with its undo history and a
// fake of the guarded route, through the four paths of the stateful flow standard: forward,
// backtrack and revise, resume from what is saved, and re-entry after a completion or a failure.
// Plan docs/plans/2026-11-02-sandboxed-custom-code.md, slice C4 (D101 to D112).
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createRootStore, getHistoryStore, type RootStoreType } from '@/stores/RootStore';
import type { ComponentInstance } from '@/models/ComponentModel';
import type { ProjectModelType } from '@/models/ProjectModel';
import type { PageModelType } from '@/models/PageModel';
import { DataSourceProviderContext } from '@/lib/bindings/dataSource/context';
import { InMemoryDataSourceProvider } from '@/lib/bindings/dataSource/inMemoryProvider';
import { customCodeHash, type CustomCodeDeclaration } from '@/lib/customCode/contract';
import { CustomCodeAuthoringProvider, canInsertCustomCode, type CustomCodeAuthoringValue } from '@/components/customCode/CustomCodeAuthoring';
import { CUSTOM_CODE_READ_TIMEOUT_MS, CUSTOM_CODE_SAVE_TIMEOUT_MS, type CustomCodeStatus } from '@/components/customCode/customCodeClient';

// A whole sidebar on a real store, hashing in the browser's crypto: slow when the suite runs in parallel.
vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 8000 });

let store: RootStoreType;
vi.mock('@/hooks/useStore', () => ({ useStore: () => store }));
// The rich editor's chunk does not load here, so the plain field stays (the fallback D112 keeps).
vi.mock('@/components/customCode/codeMirrorView', () => {
  throw new Error('not in jsdom');
});

// The autosave the panel asks to save the page first (D108): a fake controller per test, or none.
let autosave: { flush: ReturnType<typeof vi.fn>; hasUnsavedWork: ReturnType<typeof vi.fn> } | undefined;
vi.mock('@/lib/projects/autosave', async (original) => ({
  ...(await original<typeof import('@/lib/projects/autosave')>()),
  existingAutosave: () => autosave,
}));

import RightSidebar from '../../RightSidebar';
import ComponentsPanel from '../../left/ComponentsPanel';

const STATES = [
  { id: 'open', name: 'Open', type: 'boolean', initial: false },
  { id: 'step', name: 'Step', type: 'number', initial: 0, min: 0, max: 9 },
  { id: 'label', name: 'Label', type: 'text', initial: '' },
];
const STATUS: CustomCodeStatus = {
  enabled: true, branch: false, canManage: true, serving: true, usedBytes: 0,
  limits: { blockBytes: 262144, siteBytes: 1048576, blocksPerPage: 4, writesPerHour: 30 },
};

interface Blob { title: string; document: string; declaration: CustomCodeDeclaration }
let server: {
  status: typeof STATUS;
  blobs: Map<string, Blob>;
  posts: Record<string, unknown>[];
  refuse: { status: number; code: string; message: string } | null;
  network: boolean;
  /** Holds the POST answer until released, to change the block meanwhile. */
  hold: { release: () => void } | null;
  /** Never answers these requests ('post' or 'blob'); only the client's time limit ends them. */
  hang: 'post' | 'blob' | null;
};
let project: ProjectModelType;
let page: PageModelType;
let main: ComponentInstance;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input), 'http://editor.test');
  if (server.network) throw new TypeError('Failed to fetch');
  const isPost = init?.method === 'POST';
  if ((server.hang === 'post' && isPost) || (server.hang === 'blob' && !isPost && url.searchParams.has('sha256'))) {
    if (isPost) server.posts.push(JSON.parse(String(init!.body)) as Record<string, unknown>);
    // Like a real fetch: it ends only when its signal aborts it.
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
    });
  }
  if (!init?.method || init.method === 'GET') {
    const sha = url.searchParams.get('sha256');
    if (!sha) return json(server.status);
    const blob = server.blobs.get(sha);
    if (!blob) return json({ error: { code: 'blob_not_found', message: 'No such code.' } }, 404);
    return json({ sha256: sha, ...blob, createdAt: '2026-11-23T00:00:00.000Z', blocked: false });
  }
  const body = JSON.parse(String(init.body)) as Record<string, unknown> & Blob;
  server.posts.push(body);
  if (server.hold) await new Promise<void>((resolve) => { server.hold = { release: resolve }; });
  if (server.refuse) return json({ error: server.refuse }, server.refuse.status);
  const sha256 = await customCodeHash(body.document, body.declaration);
  const created = !server.blobs.has(sha256);
  if (created) server.blobs.set(sha256, { title: body.title, document: body.document, declaration: body.declaration });
  return json({ sha256, created }, created ? 201 : 200);
}

beforeEach(() => {
  server = { status: { ...STATUS }, blobs: new Map(), posts: [], refuse: null, network: false, hold: null, hang: null };
  autosave = undefined;
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
  store = createRootStore();
  store.projectStore.createProject('Code');
  project = store.projectStore.findProjectByTitle('Code')!;
  page = project.findPageBySlug('')!;
  store.editorUI.setCurrentProject(project);
  store.editorUI.setCurrentPage(page);
  getHistoryStore()!.setTargetStore(project);
  const root = page.appComponentTree as ComponentInstance;
  root.setBehaviour({ state: STATES });
  main = root.children[0] as ComponentInstance;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(available = true) {
  return render(
    <CustomCodeAuthoringProvider available={available} projectId={project.id}>
      <DataSourceProviderContext.Provider value={new InMemoryDataSourceProvider()}>
        <ComponentsPanel />
        <RightSidebar />
      </DataSourceProviderContext.Provider>
    </CustomCodeAuthoringProvider>,
  );
}

const section = () => within(screen.getByTestId('custom-code-section'));
const codeOf = (node: ComponentInstance) => (node.props as Record<string, unknown>).customCode;
const selected = () => store.editorUI.selectedComponent as ComponentInstance;

async function insertBlock(): Promise<ComponentInstance> {
  fireEvent.click(await screen.findByTestId('insert-custom-code'));
  await screen.findByTestId('custom-code-section');
  return selected();
}

function fill(title: string, code: string) {
  fireEvent.change(section().getByLabelText('Title of the custom code block'), { target: { value: title } });
  fireEvent.change(section().getByLabelText(`Code of ${title}`), { target: { value: code } });
}

/** Presses Save and waits until the panel has finished (hashing, the post, applying). */
async function save() {
  act(() => {
    fireEvent.click(section().getByRole('button', { name: 'Save code' }));
  });
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Saving code…' })).toBeNull());
}

describe('forward: insert, write, save', () => {
  it('adds an empty block from the Components panel, saves its code and names the hash as one undo step', async () => {
    mount();
    const block = await insertBlock();
    expect(codeOf(block)).toBeNull();
    expect(section().getByText(/Tab moves on to the next field/)).toBeTruthy();
    // Only boolean, number and choice values are offered: text cannot cross into the frame.
    expect(section().getByRole('checkbox', { name: 'Read Open' })).toBeTruthy();
    expect(section().queryByRole('checkbox', { name: 'Read Label' })).toBeNull();
    fill('Clock', '<p>tick</p>');
    fireEvent.click(section().getByRole('checkbox', { name: 'Read Open' }));
    fireEvent.click(section().getByRole('checkbox', { name: 'Change Step' }));
    fireEvent.change(section().getByLabelText('Events it can fire, separated by commas'), { target: { value: 'done' } });
    expect(section().getByText(/It can read "Open"/).textContent).toContain('it can change "Step"');
    await save();
    const declaration = { reads: ['open'], writes: ['step'], emits: ['custom:done'], sizing: 'fixed', interactive: true };
    expect(server.posts).toEqual([{ pageId: page.id, nodeId: block.id, title: 'Clock', document: '<p>tick</p>', declaration }]);
    const sha256 = await customCodeHash('<p>tick</p>', declaration as CustomCodeDeclaration);
    expect(codeOf(block)).toEqual({ sha256, title: 'Clock' });
    expect(section().getByText('Code saved. Publish the page to put it live.')).toBeTruthy();
    act(() => getHistoryStore()!.undo());
    expect(codeOf(block)).toBeNull();
  });

  it('refuses in the panel what the route would refuse, with the reason, and posts nothing', async () => {
    mount();
    await insertBlock();
    fill('Clock', '   ');
    await save();
    expect(section().getByRole('alert').textContent).toMatch(/code/i);
    fill('Clock', '<p>x</p>');
    fireEvent.change(section().getByLabelText('Events it can fire, separated by commas'), { target: { value: 'Bad Name' } });
    expect(section().getAllByRole('alert')[0].textContent).toContain('"Bad Name" is not an event name');
    await save();
    expect(server.posts).toEqual([]);
  });
});

describe('backtrack and revise', () => {
  async function savedBlock() {
    mount();
    const block = await insertBlock();
    fill('Clock', '<p>one</p>');
    await save();
    return block;
  }

  it('a changed code posts again with the hash it replaces, and a new hash lands', async () => {
    const block = await savedBlock();
    const first = (codeOf(block) as { sha256: string }).sha256;
    fireEvent.change(section().getByLabelText('Code of Clock'), { target: { value: '<p>two</p>' } });
    await save();
    expect(server.posts[1]).toMatchObject({ document: '<p>two</p>', replaces: first });
    expect((codeOf(block) as { sha256: string }).sha256).not.toBe(first);
  });

  it('a changed declaration alone is a new hash (the hash covers it)', async () => {
    const block = await savedBlock();
    const first = (codeOf(block) as { sha256: string }).sha256;
    fireEvent.click(section().getByRole('switch', { name: 'Visitors can click into it' }));
    await save();
    expect(server.posts).toHaveLength(2);
    expect((codeOf(block) as { sha256: string }).sha256).not.toBe(first);
  });

  it('a changed title alone posts nothing and is one undo step on the node (D105)', async () => {
    const block = await savedBlock();
    const first = codeOf(block) as { sha256: string };
    fireEvent.change(section().getByLabelText('Title of the custom code block'), { target: { value: 'Big clock' } });
    await save();
    expect(server.posts).toHaveLength(1);
    expect(codeOf(block)).toEqual({ sha256: first.sha256, title: 'Big clock' });
    act(() => getHistoryStore()!.undo());
    expect(codeOf(block)).toEqual({ sha256: first.sha256, title: 'Clock' });
  });

  it('Discard edits brings back what is stored, and Save with nothing changed posts nothing', async () => {
    await savedBlock();
    fireEvent.change(section().getByLabelText('Code of Clock'), { target: { value: '<p>scrap</p>' } });
    fireEvent.click(section().getByRole('button', { name: 'Discard edits' }));
    expect((section().getByLabelText('Code of Clock') as HTMLTextAreaElement).value).toBe('<p>one</p>');
    await save();
    expect(server.posts).toHaveLength(1);
    expect(section().getByText('Nothing changed.')).toBeTruthy();
  });

  it('a draft is closed when the block changes underneath it (an undo), and says so (D109)', async () => {
    const block = await savedBlock();
    fireEvent.change(section().getByLabelText('Code of Clock'), { target: { value: '<p>draft</p>' } });
    act(() => getHistoryStore()!.undo());
    expect(codeOf(block)).toBeNull();
    await waitFor(() => expect(screen.getByText(/the unsaved edits were closed/)).toBeTruthy());
    expect((section().getByLabelText(/^Code of/) as HTMLTextAreaElement).value).toBe('');
  });
});

describe('resume from what is saved', () => {
  async function storedBlock(declaration: CustomCodeDeclaration, store_ = true) {
    const sha256 = await customCodeHash('<p>kept</p>', declaration);
    if (store_) server.blobs.set(sha256, { title: 'Kept', document: '<p>kept</p>', declaration });
    const block = page.insertCustomCodeBlock({ kind: 'parent', parentId: main.id })!;
    block.setCustomCode({ sha256, title: 'Kept' });
    mount();
    act(() => store.editorUI.selectComponent(block));
    return block;
  }

  it('reads the stored code and declaration back by the hash on the node', async () => {
    await storedBlock({ reads: ['open'], writes: [], emits: [], sizing: 'content', interactive: false });
    await waitFor(() => expect((section().getByLabelText('Code of Kept') as HTMLTextAreaElement).value).toBe('<p>kept</p>'));
    expect((section().getByRole('checkbox', { name: 'Read Open' }) as HTMLInputElement).checked).toBe(true);
    expect(section().getByText(/Its height follows its content/)).toBeTruthy();
  });

  it('says when the saved declaration names a value the page no longer has', async () => {
    await storedBlock({ reads: ['gone'], writes: [], emits: [], sizing: 'fixed', interactive: true });
    await waitFor(() => expect(screen.getByText(/Until then the published page shows the fallback/)).toBeTruthy());
    expect(section().getByRole('checkbox', { name: 'Read gone, a value that is gone' })).toBeTruthy();
  });

  it('says when the site holds no code under the hash (copied from another site)', async () => {
    await storedBlock({ reads: [], writes: [], emits: [], sizing: 'fixed', interactive: true }, false);
    await waitFor(() => expect(screen.getByText(/holds no code under this block's hash/)).toBeTruthy());
  });
});

describe('re-entry after a failure or a completion', () => {
  it('shows a refusal with its reason, changes nothing, and saves on the next try', async () => {
    mount();
    const block = await insertBlock();
    fill('Clock', '<p>x</p>');
    server.refuse = { status: 429, code: 'rate_limited', message: 'This site wrote 30 blocks in the last hour. Try again in 50 minutes.' };
    await save();
    expect(section().getByRole('alert').textContent).toContain('Try again in 50 minutes');
    expect(codeOf(block)).toBeNull();
    server.refuse = null;
    await save();
    expect((codeOf(block) as { title: string }).title).toBe('Clock');
  });

  it('says the server could not be reached, keeps the draft, and changes nothing', async () => {
    mount();
    const block = await insertBlock();
    fill('Clock', '<p>x</p>');
    server.network = true;
    await save();
    expect(section().getByRole('alert').textContent).toContain('could not be reached');
    expect((section().getByLabelText('Code of Clock') as HTMLTextAreaElement).value).toBe('<p>x</p>');
    expect(codeOf(block)).toBeNull();
  });

  it('applies no answer to a block that changed while saving (D109)', async () => {
    mount();
    const block = await insertBlock();
    fill('Clock', '<p>x</p>');
    server.hold = { release: () => {} };
    act(() => {
      fireEvent.click(section().getByRole('button', { name: 'Save code' }));
    });
    await waitFor(() => expect(server.posts).toHaveLength(1));
    act(() => { block.setCustomCode({ sha256: 'cd'.repeat(32), title: 'Other tab' }); });
    await act(async () => { server.hold!.release(); });
    await waitFor(() => expect(screen.getByText(/The block changed while saving/)).toBeTruthy());
    expect(codeOf(block)).toEqual({ sha256: 'cd'.repeat(32), title: 'Other tab' });
  });

  it('R3-L1: gives back what was posted as a draft when the block changed while saving, and saves it on the next try', async () => {
    mount();
    const block = await insertBlock();
    fill('Clock', '<p>two</p>');
    fireEvent.change(section().getByLabelText('Events it can fire, separated by commas'), { target: { value: 'done' } });
    server.hold = { release: () => {} };
    act(() => {
      fireEvent.click(section().getByRole('button', { name: 'Save code' }));
    });
    await waitFor(() => expect(server.posts).toHaveLength(1));
    const held = server.hold!;
    server.hold = null;
    // Another tab's save lands meanwhile.
    act(() => { block.setCustomCode({ sha256: 'cd'.repeat(32), title: 'Other tab' }); });
    await act(async () => { held.release(); });
    await waitFor(() => expect(document.querySelector('[data-custom-code-problem]')?.textContent).toBe('The block changed while saving, so nothing was applied to it. Your code is back in the panel; save it again to use it.'));
    expect(codeOf(block)).toEqual({ sha256: 'cd'.repeat(32), title: 'Other tab' });
    expect((section().getByLabelText('Code of Clock') as HTMLTextAreaElement).value).toBe('<p>two</p>');
    expect((section().getByLabelText('Title of the custom code block') as HTMLInputElement).value).toBe('Clock');
    expect((section().getByLabelText('Events it can fire, separated by commas') as HTMLInputElement).value).toBe('done');
    // Kept across another selection too.
    act(() => store.editorUI.selectComponent(main));
    act(() => store.editorUI.selectComponent(block));
    expect((section().getByLabelText('Code of Clock') as HTMLTextAreaElement).value).toBe('<p>two</p>');
    // "Save it again" is one click, and it replaces what the block now names.
    // (This test site holds no code under the other tab's hash, so the read ends in "missing", where Save is offered.)
    await waitFor(() => expect((section().getByRole('button', { name: 'Save code' }) as HTMLButtonElement).disabled).toBe(false));
    await save();
    expect(server.posts).toHaveLength(2);
    expect(server.posts[1]).toMatchObject({ document: '<p>two</p>', title: 'Clock', replaces: 'cd'.repeat(32) });
    expect((codeOf(block) as { title: string }).title).toBe('Clock');
  });

  it('opens a second block after the first with its own empty draft', async () => {
    mount();
    await insertBlock();
    fill('Clock', '<p>x</p>');
    await save();
    act(() => store.editorUI.selectComponent(main));
    const second = await insertBlock();
    expect(codeOf(second)).toBeNull();
    expect((section().getByLabelText('Title of the custom code block') as HTMLInputElement).value).toBe('');
  });
});

describe('who may write, and where', () => {
  it('offers no insert item and no Save to a person who is not a workspace admin, and says why', async () => {
    server.status = { ...STATUS, canManage: false };
    const block = page.insertCustomCodeBlock({ kind: 'parent', parentId: main.id })!;
    mount();
    act(() => store.editorUI.selectComponent(block));
    await waitFor(() => expect(screen.getByText(/Only a workspace admin can change custom code/)).toBeTruthy());
    expect(screen.queryByTestId('insert-custom-code')).toBeNull();
    expect(section().queryByRole('button', { name: 'Save code' })).toBeNull();
  });

  it('writes nothing on a branch and says to open the main site', async () => {
    server.status = { ...STATUS, branch: true };
    const block = page.insertCustomCodeBlock({ kind: 'parent', parentId: main.id })!;
    mount();
    act(() => store.editorUI.selectComponent(block));
    await waitFor(() => expect(screen.getByText(/written on the main site, not on a branch/)).toBeTruthy());
    expect(screen.queryByTestId('insert-custom-code')).toBeNull();
  });

  it('says Lumitra switched the site off, with the operator\'s reason, and offers no Save (D118)', async () => {
    server.status = { ...STATUS, enabled: false, disabledByLumitra: { reason: 'phishing form reported', at: '2026-11-27T12:00:00.000Z' } };
    const block = page.insertCustomCodeBlock({ kind: 'parent', parentId: main.id })!;
    mount();
    act(() => store.editorUI.selectComponent(block));
    await waitFor(() => expect(screen.getByText(/Lumitra switched custom code off for this site/)).toBeTruthy());
    expect(screen.getByText(/Reason given: phishing form reported/)).toBeTruthy();
    expect(screen.queryByText(/not switched on for this site/)).toBeNull();
    expect(section().queryByRole('button', { name: 'Save code' })).toBeNull();
  });

  it('keeps the plain sentence when the site\'s own people switched it off', async () => {
    server.status = { ...STATUS, enabled: false, disabledByLumitra: null };
    const block = page.insertCustomCodeBlock({ kind: 'parent', parentId: main.id })!;
    mount();
    act(() => store.editorUI.selectComponent(block));
    await waitFor(() => expect(screen.getByText(/not switched on for this site/)).toBeTruthy());
    expect(screen.queryByText(/Lumitra switched custom code off/)).toBeNull();
  });

  it('reads nothing from the route and offers nothing while CUSTOM_CODE_AVAILABLE is off', async () => {
    const block = page.insertCustomCodeBlock({ kind: 'parent', parentId: main.id })!;
    mount(false);
    act(() => store.editorUI.selectComponent(block));
    expect(screen.getByText(/not available on this server yet/)).toBeTruthy();
    expect(screen.queryByTestId('insert-custom-code')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shows the status read failure with a Retry that reads again', async () => {
    server.network = true;
    const block = page.insertCustomCodeBlock({ kind: 'parent', parentId: main.id })!;
    mount();
    act(() => store.editorUI.selectComponent(block));
    await waitFor(() => expect(screen.getByText(/could not be read/)).toBeTruthy());
    server.network = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry reading the custom code settings' }));
    await waitFor(() => expect(screen.getByTestId('insert-custom-code')).toBeTruthy());
  });

  it('the fallback switch shows the fallback for that block only, never stored', async () => {
    mount();
    const block = await insertBlock();
    const before = JSON.stringify(block.props);
    fireEvent.click(section().getByRole('switch', { name: 'Show the fallback on the canvas' }));
    expect((section().getByRole('switch', { name: 'Show the fallback on the canvas' }) as HTMLElement).getAttribute('aria-checked')).toBe('true');
    expect(JSON.stringify(block.props)).toBe(before);
  });
});

describe('the page is saved before the code (D108)', () => {
  it('asks the autosave to save the page, then posts', async () => {
    const order: string[] = [];
    autosave = { flush: vi.fn(async () => { order.push('flush'); }), hasUnsavedWork: vi.fn(() => false) };
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') order.push('post');
      return fakeFetch(input, init);
    });
    mount();
    const block = await insertBlock();
    fill('Clock', '<p>x</p>');
    await save();
    expect(order).toEqual(['flush', 'post']);
    expect((codeOf(block) as { title: string }).title).toBe('Clock');
  });

  it('posts nothing while the page is not saved, and says so', async () => {
    autosave = { flush: vi.fn(async () => {}), hasUnsavedWork: vi.fn(() => true) };
    mount();
    const block = await insertBlock();
    fill('Clock', '<p>x</p>');
    await save();
    expect(autosave.flush).toHaveBeenCalledTimes(1);
    expect(server.posts).toEqual([]);
    expect(section().getByRole('alert').textContent).toContain('The page is not saved yet');
    expect(codeOf(block)).toBeNull();
  });
});

describe('what the stored code says about itself', () => {
  it('says when the code was taken down', async () => {
    const declaration: CustomCodeDeclaration = { reads: [], writes: [], emits: [], sizing: 'fixed', interactive: true };
    const sha256 = await customCodeHash('<p>bad</p>', declaration);
    server.blobs.set(sha256, { title: 'Bad', document: '<p>bad</p>', declaration });
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await fakeFetch(input, init);
      if (!String(input).includes('sha256=')) return res;
      return json({ ...(await res.json()), blocked: true });
    });
    const block = page.insertCustomCodeBlock({ kind: 'parent', parentId: main.id })!;
    block.setCustomCode({ sha256, title: 'Bad' });
    mount();
    act(() => store.editorUI.selectComponent(block));
    await waitFor(() => expect(screen.getByText(/This code was taken down by Lumitra/)).toBeTruthy());
  });

  it('on a branch, sends to the main site for code it does not hold, instead of asking to save', async () => {
    server.status = { ...STATUS, branch: true };
    const block = page.insertCustomCodeBlock({ kind: 'parent', parentId: main.id })!;
    block.setCustomCode({ sha256: 'ef'.repeat(32), title: 'Main\'s' });
    mount();
    act(() => store.editorUI.selectComponent(block));
    await waitFor(() => expect(screen.getByText(/A branch holds no code of its own/)).toBeTruthy());
    expect(screen.queryByText(/Write the code and save it/)).toBeNull();
  });

  it('shows the pointer as text, not a switch, to a person who cannot write', async () => {
    server.status = { ...STATUS, canManage: false };
    const block = page.insertCustomCodeBlock({ kind: 'parent', parentId: main.id })!;
    mount();
    act(() => store.editorUI.selectComponent(block));
    await waitFor(() => expect(screen.getByText(/Only a workspace admin/)).toBeTruthy());
    expect(section().queryByRole('switch', { name: 'Visitors can click into it' })).toBeNull();
    expect(section().getByText('Visitors can click into it')).toBeTruthy();
    expect((section().getByLabelText(/^Code of/) as HTMLTextAreaElement).readOnly).toBe(true);
  });
});

describe('canInsertCustomCode (D101)', () => {
  const value = (over: Partial<CustomCodeAuthoringValue>, status: Partial<typeof STATUS> = {}): CustomCodeAuthoringValue => ({
    available: true,
    projectId: 'p',
    state: { phase: 'ready', status: { ...STATUS, ...status } },
    reload: () => {},
    fallbackShown: new Set(),
    setFallbackShown: () => {},
    draftOf: () => null,
    saveOf: () => undefined,
    saveNow: () => undefined,
    updateSave: () => {},
    announce: () => {},
    keepDraft: () => {},
    ...over,
  });

  it('offers the block only with the server switch on, the site enabled, an admin, and not a branch', () => {
    expect(canInsertCustomCode(value({}))).toBe(true);
    // The server switch decides even over a status read some other way.
    expect(canInsertCustomCode(value({ available: false }))).toBe(false);
    expect(canInsertCustomCode(value({}, { enabled: false }))).toBe(false);
    expect(canInsertCustomCode(value({}, { canManage: false }))).toBe(false);
    expect(canInsertCustomCode(value({}, { branch: true }))).toBe(false);
    expect(canInsertCustomCode(value({ state: { phase: 'loading' } }))).toBe(false);
    expect(canInsertCustomCode(value({ state: { phase: 'failed', message: 'x' } }))).toBe(false);
  });
});

describe('review 1 of #459', () => {
  it('M1: freezes the fields while a save runs, so what is typed meanwhile is not lost, and says so', async () => {
    mount();
    const block = await insertBlock();
    fill('Clock', '<p>one</p>');
    server.hold = { release: () => {} };
    act(() => {
      fireEvent.click(section().getByRole('button', { name: 'Save code' }));
    });
    await waitFor(() => expect(server.posts).toHaveLength(1));
    const field = section().getByLabelText('Code of Clock') as HTMLTextAreaElement;
    expect(field.readOnly).toBe(true);
    expect((section().getByLabelText('Title of the custom code block') as HTMLInputElement).readOnly).toBe(true);
    expect(screen.getByText('Saving the code. The fields are locked until the server answers.')).toBeTruthy();
    // Every field, the Height dropdown and the pointer switch too (review 2 of #459, L3).
    const height = section().getByLabelText('Height of the frame') as HTMLSelectElement;
    const pointer = section().getByRole('switch', { name: 'Visitors can click into it' });
    expect(height.getAttribute('aria-disabled')).toBe('true');
    expect(pointer.getAttribute('aria-disabled')).toBe('true');
    fireEvent.change(height, { target: { value: 'content' } });
    fireEvent.click(pointer);
    expect(height.value).toBe('fixed');
    expect(pointer.getAttribute('aria-checked')).toBe('true');
    // A keystroke meanwhile is not taken: the field keeps what is being saved.
    fireEvent.change(field, { target: { value: '<p>one and two</p>' } });
    fireEvent.click(section().getByRole('checkbox', { name: 'Read Open' }));
    expect(field.value).toBe('<p>one</p>');
    await act(async () => { server.hold!.release(); });
    await waitFor(() => expect(codeOf(block)).not.toBeNull());
    expect((section().getByLabelText('Code of Clock') as HTMLTextAreaElement).value).toBe('<p>one</p>');
    expect((section().getByRole('checkbox', { name: 'Read Open' }) as HTMLInputElement).checked).toBe(false);
    expect((section().getByLabelText('Code of Clock') as HTMLTextAreaElement).readOnly).toBe(false);
  });

  it('M1: a failed save keeps the edits and unfreezes the fields', async () => {
    mount();
    await insertBlock();
    fill('Clock', '<p>one</p>');
    server.refuse = { status: 429, code: 'rate_limited', message: 'Try again in 50 minutes.' };
    await save();
    const field = section().getByLabelText('Code of Clock') as HTMLTextAreaElement;
    expect(field.value).toBe('<p>one</p>');
    expect(field.readOnly).toBe(false);
    fireEvent.change(field, { target: { value: '<p>two</p>' } });
    expect((section().getByLabelText('Code of Clock') as HTMLTextAreaElement).value).toBe('<p>two</p>');
  });

  it('L3: keeps a block\'s draft while another element is selected, and says it is back', async () => {
    mount();
    const block = await insertBlock();
    fill('Clock', '<p>draft</p>');
    act(() => store.editorUI.selectComponent(main));
    expect(screen.queryByTestId('custom-code-section')).toBeNull();
    act(() => store.editorUI.selectComponent(block));
    expect((section().getByLabelText('Code of Clock') as HTMLTextAreaElement).value).toBe('<p>draft</p>');
    expect(screen.getByText('Your unsaved edits to this block are back.')).toBeTruthy();
    // An undo meanwhile still closes it (D109).
    act(() => store.editorUI.selectComponent(main));
    act(() => { block.setCustomCode({ sha256: 'cd'.repeat(32), title: 'Elsewhere' }); });
    act(() => store.editorUI.selectComponent(block));
    await waitFor(() => expect(screen.getByText(/the unsaved edits were closed/)).toBeTruthy());
    expect((section().getByLabelText('Title of the custom code block') as HTMLInputElement).value).toBe('Elsewhere');
  });

  it('L4: posts the code when this site does not hold the hash, even if it is the same code', async () => {
    const declaration: CustomCodeDeclaration = { reads: [], writes: [], emits: [], sizing: 'fixed', interactive: true };
    const sha256 = await customCodeHash('<p>copied</p>', declaration);
    const block = page.insertCustomCodeBlock({ kind: 'parent', parentId: main.id })!;
    block.setCustomCode({ sha256, title: 'Copied' });
    mount();
    act(() => store.editorUI.selectComponent(block));
    await waitFor(() => expect(screen.getByText(/holds no code under this block's hash/)).toBeTruthy());
    fireEvent.change(section().getByLabelText('Code of Copied'), { target: { value: '<p>copied</p>' } });
    await save();
    expect(server.posts).toHaveLength(1);
    expect(server.blobs.has(sha256)).toBe(true);
    expect(screen.queryByText('Nothing changed.')).toBeNull();
  });

  it('L4: offers no Save while the stored code failed to load, and Retry loads it', async () => {
    const declaration: CustomCodeDeclaration = { reads: [], writes: [], emits: [], sizing: 'fixed', interactive: true };
    const sha256 = await customCodeHash('<p>kept</p>', declaration);
    server.blobs.set(sha256, { title: 'Kept', document: '<p>kept</p>', declaration });
    const block = page.insertCustomCodeBlock({ kind: 'parent', parentId: main.id })!;
    block.setCustomCode({ sha256, title: 'Kept' });
    let failBlob = true;
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (failBlob && String(input).includes('sha256=')) return json({ error: { code: 'custom_code_failed', message: 'The custom code could not be read.' } }, 500);
      return fakeFetch(input, init);
    });
    mount();
    act(() => store.editorUI.selectComponent(block));
    await waitFor(() => expect(screen.getByText(/cannot be saved over until it is loaded/)).toBeTruthy());
    expect((section().getByRole('button', { name: 'Save code' }) as HTMLButtonElement).disabled).toBe(true);
    failBlob = false;
    fireEvent.click(section().getByRole('button', { name: 'Retry loading the stored code' }));
    await waitFor(() => expect((section().getByLabelText('Code of Kept') as HTMLTextAreaElement).value).toBe('<p>kept</p>'));
    expect((section().getByRole('button', { name: 'Save code' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('review 2 of #459', () => {
  /** Fills the block, presses Save with the post held, and waits for the post to be sent. */
  async function saveHeld(block: ComponentInstance) {
    fill('Clock', '<p>one</p>');
    server.hold = { release: () => {} };
    act(() => {
      fireEvent.click(section().getByRole('button', { name: 'Save code' }));
    });
    await waitFor(() => expect(server.posts).toHaveLength(1));
    // Away to another element (the fallback switch leads there) and back.
    act(() => store.editorUI.selectComponent(main));
    expect(screen.queryByTestId('custom-code-section')).toBeNull();
    act(() => store.editorUI.selectComponent(block));
  }

  it('M1: a section opened again mid-save stays locked, keeps no lost typing, and then says Code saved', async () => {
    mount();
    const block = await insertBlock();
    await saveHeld(block);
    const field = section().getByLabelText('Code of Clock') as HTMLTextAreaElement;
    expect(field.readOnly).toBe(true);
    expect((section().getByLabelText('Title of the custom code block') as HTMLInputElement).readOnly).toBe(true);
    expect(section().getByRole('button', { name: 'Saving code…' })).toBeTruthy();
    fireEvent.change(field, { target: { value: '<p>one and later</p>' } });
    expect(field.value).toBe('<p>one</p>');
    await act(async () => { server.hold!.release(); });
    await waitFor(() => expect(codeOf(block)).not.toBeNull());
    await waitFor(() => expect(section().getByText('Code saved. Publish the page to put it live.')).toBeTruthy());
    expect(screen.queryByText(/the unsaved edits were closed/)).toBeNull();
    expect(section().queryByRole('alert')).toBeNull();
    const after = section().getByLabelText('Code of Clock') as HTMLTextAreaElement;
    expect(after.value).toBe('<p>one</p>');
    expect(after.readOnly).toBe(false);
  });

  it('M1: Save cannot be pressed again while the first save runs, so one post goes out', async () => {
    mount();
    const block = await insertBlock();
    await saveHeld(block);
    const button = section().getByRole('button', { name: 'Saving code…' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    await act(async () => { server.hold!.release(); });
    await waitFor(() => expect(section().getByRole('button', { name: 'Save code' })).toBeTruthy());
    expect(server.posts).toHaveLength(1);
    server.hold = null;
    expect(section().queryByText(/save it again to use it/)).toBeNull();
    // The next save from this section replaces the hash the first one wrote.
    const first = (codeOf(block) as { sha256: string }).sha256;
    fireEvent.change(section().getByLabelText('Code of Clock'), { target: { value: '<p>two</p>' } });
    await save();
    expect(server.posts).toHaveLength(2);
    expect(server.posts[1].replaces).toBe(first);
  });

  it('M1: a save that ends while another element is selected says so when the block is selected again', async () => {
    mount();
    const block = await insertBlock();
    await saveHeld(block);
    act(() => store.editorUI.selectComponent(main));
    await act(async () => { server.hold!.release(); });
    await waitFor(() => expect(codeOf(block)).not.toBeNull());
    act(() => store.editorUI.selectComponent(block));
    await waitFor(() => expect(section().getByText('Code saved. Publish the page to put it live.')).toBeTruthy());
    expect(screen.queryByText(/the unsaved edits were closed/)).toBeNull();
    expect(screen.queryByText('Your unsaved edits to this block are back.')).toBeNull();
    await waitFor(() => expect((section().getByLabelText('Code of Clock') as HTMLTextAreaElement).value).toBe('<p>one</p>'));
  });

  it('M1: a refusal that arrives while another element is selected is shown with its reason on return', async () => {
    mount();
    const block = await insertBlock();
    server.refuse = { status: 429, code: 'rate_limited', message: 'Try again in 50 minutes.' };
    await saveHeld(block);
    act(() => store.editorUI.selectComponent(main));
    await act(async () => { server.hold!.release(); });
    act(() => store.editorUI.selectComponent(block));
    await waitFor(() => expect(section().getByRole('alert').textContent).toBe('Try again in 50 minutes.'));
    expect(codeOf(block)).toBeNull();
    const field = section().getByLabelText('Code of Clock') as HTMLTextAreaElement;
    expect(field.value).toBe('<p>one</p>');
    expect(field.readOnly).toBe(false);
    expect(section().getByRole('button', { name: 'Save code' })).toBeTruthy();
  });

  it('L1: the restored-draft notice is a change in a live region that existed before, and shows on screen', async () => {
    mount();
    const block = await insertBlock();
    const region = document.querySelector('[data-custom-code-announcement]');
    expect(region).not.toBeNull();
    fill('Clock', '<p>draft</p>');
    expect(section().queryByText('Unsaved edits from earlier')).toBeNull();
    act(() => store.editorUI.selectComponent(main));
    expect(document.querySelector('[data-custom-code-announcement]')).toBe(region);
    act(() => store.editorUI.selectComponent(block));
    await waitFor(() => expect(region!.textContent).toBe('Your unsaved edits to this block are back.'));
    expect(document.querySelector('[data-custom-code-announcement]')).toBe(region);
    expect(region!.getAttribute('aria-live')).toBe('polite');
    expect(section().getByText('Unsaved edits from earlier')).toBeTruthy();
    fireEvent.click(section().getByRole('button', { name: 'Discard edits' }));
    expect(section().queryByText('Unsaved edits from earlier')).toBeNull();
  });

  it('says the same sentence twice as two changes of the live region (review 3 of #459)', async () => {
    mount();
    await insertBlock();
    const region = document.querySelector('[data-custom-code-announcement]')!;
    const changes: string[] = [];
    const watcher = new MutationObserver(() => changes.push(region.textContent ?? ''));
    watcher.observe(region, { childList: true, characterData: true, subtree: true });
    const discard = async () => {
      fill('Clock', '<p>draft</p>');
      fireEvent.click(section().getByRole('button', { name: 'Discard edits' }));
      await waitFor(() => expect(region.textContent?.trim()).toBe('Edits discarded.'));
    };
    await discard();
    const first = region.textContent;
    await discard();
    // A region whose text does not change is not read again: the second time differs by a no-break space.
    expect(region.textContent).not.toBe(first);
    expect(region.textContent?.replace(/\u00a0/g, '')).toBe('Edits discarded.');
    await discard();
    expect(region.textContent).toBe(first);
    watcher.disconnect();
    expect(changes.filter((text) => text.trim() === 'Edits discarded.').length).toBeGreaterThanOrEqual(3);
  });

  it('L2: Retry stays focused while it retries and hands focus to the first field once the code loads', async () => {
    const declaration: CustomCodeDeclaration = { reads: [], writes: [], emits: [], sizing: 'fixed', interactive: true };
    const sha256 = await customCodeHash('<p>kept</p>', declaration);
    server.blobs.set(sha256, { title: 'Kept', document: '<p>kept</p>', declaration });
    const block = page.insertCustomCodeBlock({ kind: 'parent', parentId: main.id })!;
    block.setCustomCode({ sha256, title: 'Kept' });
    let fails = true;
    let held = false;
    let releaseBlob = () => {};
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('sha256=')) {
        if (held) await new Promise<void>((resolve) => { releaseBlob = resolve; });
        if (fails) return json({ error: { code: 'custom_code_failed', message: 'The custom code could not be read.' } }, 500);
      }
      return fakeFetch(input, init);
    });
    mount();
    act(() => store.editorUI.selectComponent(block));
    const retry = await waitFor(() => section().getByRole('button', { name: 'Retry loading the stored code' }));
    // Fails again: the same button keeps focus.
    held = true;
    retry.focus();
    fireEvent.click(retry);
    await waitFor(() => expect(retry.getAttribute('aria-disabled')).toBe('true'));
    expect(retry.getAttribute('aria-label')).toBe('Retrying: loading the stored code');
    expect(document.activeElement).toBe(retry);
    await act(async () => { releaseBlob(); });
    await waitFor(() => expect(retry.getAttribute('aria-disabled')).toBeNull());
    expect(retry.getAttribute('aria-label')).toBe('Retry loading the stored code');
    expect(document.activeElement).toBe(retry);
    // Succeeds: focus goes to the first field, never to the page body.
    fails = false;
    fireEvent.click(retry);
    await waitFor(() => expect(retry.getAttribute('aria-disabled')).toBe('true'));
    expect(document.activeElement).toBe(retry);
    await act(async () => { releaseBlob(); });
    await waitFor(() => expect((section().getByLabelText('Code of Kept') as HTMLTextAreaElement).value).toBe('<p>kept</p>'));
    await waitFor(() => expect(document.activeElement).toBe(section().getByLabelText('Title of the custom code block')));
  });

  it('L2: with the network down, the two Retry buttons have distinct names and each reads again', async () => {
    const declaration: CustomCodeDeclaration = { reads: [], writes: [], emits: [], sizing: 'fixed', interactive: true };
    const sha256 = await customCodeHash('<p>kept</p>', declaration);
    server.blobs.set(sha256, { title: 'Kept', document: '<p>kept</p>', declaration });
    const block = page.insertCustomCodeBlock({ kind: 'parent', parentId: main.id })!;
    block.setCustomCode({ sha256, title: 'Kept' });
    server.network = true;
    mount();
    act(() => store.editorUI.selectComponent(block));
    const settings = await waitFor(() => section().getByRole('button', { name: 'Retry reading the custom code settings' }));
    const code = await waitFor(() => section().getByRole('button', { name: 'Retry loading the stored code' }));
    expect(settings).not.toBe(code);
    server.network = false;
    settings.focus();
    fireEvent.click(settings);
    await waitFor(() => expect(section().queryByRole('button', { name: /reading the custom code settings/ })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(section().getByLabelText('Title of the custom code block')));
    fireEvent.click(section().getByRole('button', { name: 'Retry loading the stored code' }));
    await waitFor(() => expect((section().getByLabelText('Code of Kept') as HTMLTextAreaElement).value).toBe('<p>kept</p>'));
  });
});

describe('review 2 of #459, Info 5: a request that hangs', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a save the server never answers ends after the time limit: unlocked, edits kept, block unchanged, and saves on the next try', async () => {
    mount();
    const block = await insertBlock();
    fill('Clock', '<p>one</p>');
    server.hang = 'post';
    act(() => {
      fireEvent.click(section().getByRole('button', { name: 'Save code' }));
    });
    await waitFor(() => expect(server.posts).toHaveLength(1));
    expect((section().getByLabelText('Code of Clock') as HTMLTextAreaElement).readOnly).toBe(true);
    await act(async () => { vi.advanceTimersByTime(CUSTOM_CODE_SAVE_TIMEOUT_MS - 1000); });
    expect((section().getByLabelText('Code of Clock') as HTMLTextAreaElement).readOnly).toBe(true);
    await act(async () => { vi.advanceTimersByTime(1000); });
    await waitFor(() => expect(section().getByRole('alert').textContent).toMatch(/did not answer in time, so the block was not changed and your edits are kept/));
    const field = section().getByLabelText('Code of Clock') as HTMLTextAreaElement;
    expect(field.readOnly).toBe(false);
    expect(field.value).toBe('<p>one</p>');
    expect(codeOf(block)).toBeNull();
    server.hang = null;
    await save();
    expect(server.posts).toHaveLength(2);
    expect(codeOf(block)).not.toBeNull();
  });

  it('a page save that never finishes ends after the time limit and sends no code', async () => {
    mount();
    const block = await insertBlock();
    fill('Clock', '<p>one</p>');
    autosave = { flush: vi.fn(() => new Promise<void>(() => {})), hasUnsavedWork: vi.fn(() => false) };
    act(() => {
      fireEvent.click(section().getByRole('button', { name: 'Save code' }));
    });
    await waitFor(() => expect(autosave!.flush).toHaveBeenCalledTimes(1));
    await act(async () => { vi.advanceTimersByTime(CUSTOM_CODE_SAVE_TIMEOUT_MS); });
    await waitFor(() => expect(section().getByRole('alert').textContent).toMatch(/did not finish saving in time, so the code was not sent/));
    expect(server.posts).toHaveLength(0);
    expect(codeOf(block)).toBeNull();
    const field = section().getByLabelText('Code of Clock') as HTMLTextAreaElement;
    expect(field.readOnly).toBe(false);
    expect(field.value).toBe('<p>one</p>');
  });

  it('a read of the stored code the server never answers ends after the time limit with a Retry', async () => {
    const declaration: CustomCodeDeclaration = { reads: [], writes: [], emits: [], sizing: 'fixed', interactive: true };
    const sha256 = await customCodeHash('<p>kept</p>', declaration);
    server.blobs.set(sha256, { title: 'Kept', document: '<p>kept</p>', declaration });
    const block = page.insertCustomCodeBlock({ kind: 'parent', parentId: main.id })!;
    block.setCustomCode({ sha256, title: 'Kept' });
    server.hang = 'blob';
    mount();
    act(() => store.editorUI.selectComponent(block));
    await waitFor(() => expect(section().getByText('Loading the stored code…')).toBeTruthy());
    await act(async () => { vi.advanceTimersByTime(CUSTOM_CODE_READ_TIMEOUT_MS); });
    await waitFor(() => expect(section().getByText(/did not answer in time\. Nothing was changed; try again\. The code cannot be saved over/)).toBeTruthy());
    server.hang = null;
    fireEvent.click(section().getByRole('button', { name: 'Retry loading the stored code' }));
    await waitFor(() => expect((section().getByLabelText('Code of Kept') as HTMLTextAreaElement).value).toBe('<p>kept</p>'));
  });
});
// ci-replay touch

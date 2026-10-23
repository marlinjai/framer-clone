// src/app/projects/books/composer/__tests__/TemplateComposer.test.tsx
//
// The template composer against a scripted /api/books server (fetch stubbed),
// the four stateful-flow paths at the interface:
//   1. forward: select a block, change it, save: the whole document goes with
//      the version it was made on, the new version is shown and announced, the
//      working copy is cleared;
//   2. backtrack and revise: undo and redo from the keyboard; a save the gate
//      refuses names the problems next to the blocks and keeps every edit; a
//      required block cannot be removed; an invalid field pauses the preview;
//   3. resume: a working copy on the current version is restored with a
//      notice; one on an older version is offered, never applied, until the
//      user applies or discards it;
//   4. re-entry: a save that lost the race (409) says so and loads the newest
//      version, offering the edits there; an unknown template says so.
// The PDF canvas is a stand-in (jsdom cannot run pdf.js); the real canvas is
// proven in the browser. All data is synthetic.

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { preset } from '@/server/books/template/presets';

vi.mock('../PdfCanvas', () => ({
  default: function CanvasStandIn(props: {
    layout: { blocks: Array<{ blockId: string }> } | null;
    counter: number | null;
    labelOf: (id: string) => string;
    onSelect: (id: string) => void;
    onDrawn: (n: number) => void;
  }) {
    React.useEffect(() => {
      if (props.counter !== null) props.onDrawn(props.counter);
    }, [props.counter]); // eslint-disable-line react-hooks/exhaustive-deps
    return (
      <div data-testid="canvas">
        {props.layout?.blocks.map((b) => (
          <button key={b.blockId} type="button" data-block-id={b.blockId} onClick={() => props.onSelect(b.blockId)}>
            {`Select ${props.labelOf(b.blockId)}`}
          </button>
        ))}
      </div>
    );
  },
}));

import TemplateComposer from '../TemplateComposer';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Handler = (body: Json | null) => { status: number; body: unknown };
let routes: Record<string, Handler>;
let calls: Array<{ method: string; url: string; body: Json | null }>;

function server(r: Record<string, Handler>) {
  routes = r;
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Json) : null;
      calls.push({ method, url, body });
      const handler = routes[`${method} ${url.split('?')[0]}`];
      if (!handler) return new Response(JSON.stringify({ error: { code: 'not_found', message: 'nf' } }), { status: 404 });
      const res = handler(body);
      return new Response(JSON.stringify(res.body), { status: res.status });
    }),
  );
}

function template(version = 1, document: unknown = preset('klassisch')) {
  return {
    id: 'tpl1',
    name: 'Hausvorlage',
    isDefault: true,
    currentVersionId: `v${version}`,
    version,
    document,
    accentColor: '#333340',
    footerBlocks: [],
    defaultIntroText: null,
    defaultOutroText: null,
  };
}

const BLOCK_IDS = ['title', 'introText', 'lineTable', 'totals', 'taxNote', 'paymentDetails', 'outroText'];
const previewAnswer = (problems: unknown[] = []) => ({
  status: 200,
  body: {
    pdf: 'JVBERi0=',
    layout: { page: { width: 595.28, height: 841.89 }, pageCount: 1, blocks: BLOCK_IDS.map((id) => ({ blockId: id, region: 'body', page: 1, x: 0, y: 0, width: 10, height: 10 })), tables: [], issues: [] },
    renderMs: 4,
    problems,
  },
});

function baseRoutes(version = 1): Record<string, Handler> {
  return {
    'GET /api/books/templates/tpl1': () => ({ status: 200, body: template(version) }),
    'GET /api/books/templates/tpl1/versions': () => ({
      status: 200,
      body: { items: [{ id: `v${version}`, version, createdAt: '2026-10-21T09:00:00.000Z', current: true, documentCount: 4 }] },
    }),
    'POST /api/books/templates/preview': () => previewAnswer(),
    'GET /api/books/documents': () => ({ status: 200, body: { items: [], nextCursor: null } }),
  };
}

const live = () => document.querySelector('p[aria-live]')!.textContent ?? '';
const header = () => document.querySelector('header')!.textContent ?? '';
async function opened() {
  await screen.findByDisplayValue('Hausvorlage');
  await screen.findByRole('button', { name: 'Select Title' });
}
function selectInOutline(id: string) {
  const row = document.querySelector<HTMLButtonElement>(`[data-outline-select="${id}"]`)!;
  fireEvent.click(row);
  return row;
}

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('the template composer: forward', () => {
  it('selects a block, changes it, and saves the whole document on the version it was made on', async () => {
    server({
      ...baseRoutes(),
      'PATCH /api/books/templates/tpl1': (body) => ({ status: 200, body: template(2, body!.document) }),
    });
    render(<TemplateComposer id="tpl1" />);
    await opened();
    expect(header()).toContain('Version 1');

    fireEvent.click(screen.getByRole('button', { name: 'Select Title' }));
    expect(screen.getByRole('heading', { name: 'Title' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Text size'), { target: { value: '20' } });
    expect(header()).toContain('unsaved changes');
    expect(JSON.parse(window.localStorage.getItem('books-composer:tpl1')!)).toMatchObject({ baseVersionId: 'v1', baseVersion: 1 });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(header()).toContain('Version 2'));
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.body!.baseVersionId).toBe('v1');
    expect(patch.body!.document.regions.body.find((b: Json) => b.id === 'title').style.sizePt).toBe(20);
    await waitFor(() => expect(live()).toBe('Saved as version 2.'));
    expect(window.localStorage.getItem('books-composer:tpl1')).toBeNull();
    expect(header()).not.toContain('unsaved');
    // The version list is read again, with the issued documents per version.
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith('/versions')).length).toBeGreaterThanOrEqual(2));
    expect(screen.getByText(/used by 4 documents/)).toBeTruthy();
  });

  it('adds a block after the selected one and announces it', async () => {
    server(baseRoutes());
    render(<TemplateComposer id="tpl1" />);
    await opened();
    selectInOutline('title');
    fireEvent.click(screen.getAllByRole('button', { name: /^Text/ })[0]);
    expect(screen.getByRole('heading', { name: 'Text' })).toBeTruthy();
    const order = Array.from(document.querySelectorAll('[data-outline-select]')).map((b) => b.getAttribute('data-outline-select'));
    expect(order.indexOf('freeText')).toBe(order.indexOf('title') + 1);
    await waitFor(() => expect(live()).toBe('Text added to the body.'));
  });
});

describe('the template composer: backtrack and revise', () => {
  it('undoes and redoes from the keyboard, outside text fields', async () => {
    server(baseRoutes());
    render(<TemplateComposer id="tpl1" />);
    await opened();
    const row = selectInOutline('title');
    fireEvent.change(screen.getByLabelText('Text size'), { target: { value: '20' } });
    row.focus();
    fireEvent.keyDown(row, { key: 'z', ctrlKey: true });
    expect((screen.getByLabelText('Text size') as HTMLSelectElement).value).toBe('14');
    expect(header()).not.toContain('unsaved');
    fireEvent.keyDown(row, { key: 'y', ctrlKey: true });
    expect((screen.getByLabelText('Text size') as HTMLSelectElement).value).toBe('20');
    fireEvent.keyDown(row, { key: 'z', metaKey: true, shiftKey: true });
    expect((screen.getByLabelText('Text size') as HTMLSelectElement).value).toBe('20');
  });

  it('a refused save names each problem, leads to its block, and keeps every edit', async () => {
    server({
      ...baseRoutes(),
      'PATCH /api/books/templates/tpl1': () => ({
        status: 422,
        body: {
          error: {
            code: 'template_invalid',
            message: 'the template cannot be saved',
            problems: [
              { code: 'CONTRAST_TOO_LOW', message: 'the accent colour has a contrast of 1.2:1', field: 'theme.accent' },
              { code: 'PROBE_INCOMPLETE', message: 'x', field: 'Leistungsdatum', probe: 'longInvoice' },
              { code: 'LAYOUT_PROBLEM', message: 'y', field: 'BLOCK_TOO_TALL', blockId: 'totals', region: 'body', probe: 'regular' },
            ],
          },
        },
      }),
    });
    render(<TemplateComposer id="tpl1" />);
    await opened();
    selectInOutline('outroText');
    fireEvent.change(screen.getByLabelText('Text size'), { target: { value: '11' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const panel = await screen.findByRole('region', { name: 'What stops this template from being saved' });
    expect(panel.textContent).toContain('Not saved. To fix: 3 problems');
    expect(panel.textContent).toContain('The accent colour is too light to read on white paper');
    expect(panel.textContent).toContain('a 40-line invoice over three pages would lack a required field (Leistungsdatum)');
    expect(panel.textContent).toContain('A block is taller than a page. (Seen with an invoice with two tax rates.)');
    await waitFor(() => expect(live()).toBe('Not saved: 3 problems to fix. They are listed above the preview.'));
    fireEvent.click(within(panel).getByRole('button', { name: 'Show' }));
    expect(screen.getByRole('heading', { name: 'Totals' })).toBeTruthy();
    expect(header()).toContain('Version 1, unsaved changes');
  });

  it('a required block has no remove action, and Delete says why instead', async () => {
    server(baseRoutes());
    render(<TemplateComposer id="tpl1" />);
    await opened();
    const row = selectInOutline('totals');
    expect(screen.queryByRole('button', { name: 'Remove block' })).toBeNull();
    row.focus();
    fireEvent.keyDown(row, { key: 'Delete' });
    await waitFor(() => expect(live()).toContain('Required by law on every invoice'));
    expect(document.querySelector('[data-outline-select="totals"]')).not.toBeNull();

    const optional = selectInOutline('paymentDetails');
    optional.focus();
    fireEvent.keyDown(optional, { key: 'Delete' });
    expect(document.querySelector('[data-outline-select="paymentDetails"]')).toBeNull();
    await waitFor(() => expect(live()).toBe('Payment details removed. Undo with Ctrl+Z or Cmd+Z.'));
  });

  it('a field the schema refuses pauses the preview and says what to fix', async () => {
    server(baseRoutes());
    render(<TemplateComposer id="tpl1" />);
    await opened();
    selectInOutline('title');
    fireEvent.click(screen.getAllByRole('button', { name: /^Text/ })[0]);
    const previewsBefore = calls.filter((c) => c.url.endsWith('/preview')).length;
    fireEvent.change(screen.getByRole('textbox', { name: 'Text' }), { target: { value: '   ' } });
    expect(await screen.findByText('Some fields need a value before the preview can update:')).toBeTruthy();
    expect(screen.getByText('Text: enter a text, or remove the block.')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 450));
    expect(calls.filter((c) => c.url.endsWith('/preview')).length).toBe(previewsBefore);
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });
});

describe('the template composer: resume', () => {
  function storeCopy(baseVersion: number, change: (doc: Json) => void) {
    const doc = preset('klassisch') as unknown as Json;
    change(doc);
    window.localStorage.setItem(
      'books-composer:tpl1',
      JSON.stringify({ format: 1, baseVersionId: `v${baseVersion}`, baseVersion, document: doc, savedAt: '2026-10-23T08:15:00.000Z' }),
    );
  }

  it('restores unsaved edits made on the current version, as one undoable step', async () => {
    storeCopy(1, (d) => (d.regions.body[0].style.sizePt = 20));
    server(baseRoutes());
    render(<TemplateComposer id="tpl1" />);
    await opened();
    expect(screen.getByText(/Your unsaved changes from .* are back/)).toBeTruthy();
    expect(header()).toContain('unsaved changes');
    const row = selectInOutline('title');
    expect((screen.getByLabelText('Text size') as HTMLSelectElement).value).toBe('20');
    row.focus();
    fireEvent.keyDown(row, { key: 'z', ctrlKey: true });
    expect((screen.getByLabelText('Text size') as HTMLSelectElement).value).toBe('14');
  });

  it('offers edits made on an older version and applies nothing until asked', async () => {
    storeCopy(1, (d) => (d.regions.body[0].style.sizePt = 20));
    server(baseRoutes(2));
    render(<TemplateComposer id="tpl1" />);
    await opened();
    const offer = screen.getByRole('alert');
    expect(offer.textContent).toContain('They were made on version 1; version 2 was saved since.');
    selectInOutline('title');
    expect((screen.getByLabelText('Text size') as HTMLSelectElement).value).toBe('14');
    // The copy is not overwritten while it is offered.
    expect(JSON.parse(window.localStorage.getItem('books-composer:tpl1')!).baseVersion).toBe(1);
    fireEvent.click(within(offer).getByRole('button', { name: 'Apply them anyway' }));
    expect((screen.getByLabelText('Text size') as HTMLSelectElement).value).toBe('20');
    // Now kept on the current version.
    expect(JSON.parse(window.localStorage.getItem('books-composer:tpl1')!).baseVersionId).toBe('v2');
  });

  it('discarding the offered edits removes them', async () => {
    storeCopy(1, (d) => (d.regions.body[0].style.sizePt = 20));
    server(baseRoutes(2));
    render(<TemplateComposer id="tpl1" />);
    await opened();
    fireEvent.click(screen.getByRole('button', { name: 'Discard them' }));
    expect(window.localStorage.getItem('books-composer:tpl1')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a stored copy the schema refuses is dropped, never applied', async () => {
    storeCopy(1, (d) => (d.theme.fontFamily = 'comic-sans'));
    server(baseRoutes());
    render(<TemplateComposer id="tpl1" />);
    await opened();
    expect(screen.queryByText(/are back/)).toBeNull();
    expect(window.localStorage.getItem('books-composer:tpl1')).toBeNull();
  });
});

describe('the template composer: re-entry', () => {
  it('a save that lost the race says so, and the newest version opens with the edits offered', async () => {
    let version = 1;
    server({
      ...baseRoutes(),
      'GET /api/books/templates/tpl1': () => ({ status: 200, body: template(version) }),
      'PATCH /api/books/templates/tpl1': () => ({ status: 409, body: { error: { code: 'concurrent_edit', message: 'newer', currentVersionId: 'v2' } } }),
    });
    render(<TemplateComposer id="tpl1" />);
    await opened();
    selectInOutline('title');
    fireEvent.change(screen.getByLabelText('Text size'), { target: { value: '20' } });
    version = 2;
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const alert = await screen.findByText(/Someone saved a newer version of this template meanwhile/);
    await act(async () => {
      fireEvent.click(within(alert.closest('[role=alert]') as HTMLElement).getByRole('button', { name: 'Load the newest version' }));
    });
    await waitFor(() => expect(header()).toContain('Version 2'));
    expect(screen.getByText(/They were made on version 1; version 2 was saved since/)).toBeTruthy();
  });

  it('an unknown or removed template says so and leads back', async () => {
    server({
      'GET /api/books/templates/tpl1': () => ({ status: 404, body: { error: { code: 'template_not_found', message: 'nf' } } }),
    });
    render(<TemplateComposer id="tpl1" />);
    expect(await screen.findByText(/This template does not exist or was removed/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to the templates' }).getAttribute('href')).toBe('/projects/books?tab=templates');
  });
});

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
      // A logo upload sends the file itself, not JSON.
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Json) : init?.body ? { file: init.body } : null;
      calls.push({ method, url, body });
      const handler = routes[`${method} ${url.split('?')[0]}`];
      if (!handler) return new Response(JSON.stringify({ error: { code: 'not_found', message: 'nf' } }), { status: 404 });
      const res = handler(body);
      // A 204 has no body (the Response constructor refuses one).
      return res.status === 204 ? new Response(null, { status: 204 }) : new Response(JSON.stringify(res.body), { status: res.status });
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
    'GET /api/books/assets': () => ({ status: 200, body: { items: [] } }),
  };
}

const live = () => document.querySelector('p[aria-live]')!.textContent ?? '';
const header = () => document.querySelector('header')!.textContent ?? '';
// The first mount loads the template and renders the whole composer, which
// takes over a second on a busy machine; Testing Library's default 1000ms
// find budget made every test that starts here flaky under load. The per-test
// limit is raised to match, so a slow mount is never cut off mid-test.
const MOUNT_WAIT = { timeout: 5000 };
vi.setConfig({ testTimeout: 15_000 });
async function opened() {
  await screen.findByDisplayValue('Hausvorlage', {}, MOUNT_WAIT);
  await screen.findByRole('button', { name: 'Select Title' }, MOUNT_WAIT);
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

  it('a copy that ended mid-edit (an emptied text) is restored with the preview paused; one that is not a template is dropped', async () => {
    storeCopy(1, (d) => {
      d.regions.body.splice(1, 0, { id: 'freeText', type: 'freeText', style: {}, heading: null, text: '', variant: 'normal' });
      d.regions.body[0].style.sizePt = 20;
    });
    server(baseRoutes());
    render(<TemplateComposer id="tpl1" />);
    await screen.findByDisplayValue('Hausvorlage');
    expect(await screen.findByText(/Your unsaved changes from .* are back/)).toBeTruthy();
    expect(screen.getByText('Text: enter a text, or remove the block.')).toBeTruthy();
    expect(calls.some((c) => c.url.endsWith('/preview'))).toBe(false);
    cleanup();

    window.localStorage.setItem(
      'books-composer:tpl1',
      JSON.stringify({ format: 1, baseVersionId: 'v1', baseVersion: 1, document: { v: 2, regions: { body: [{ id: 'x', type: 'hologram', style: {} }] } }, savedAt: '2026-10-23T08:15:00.000Z' }),
    );
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
    // Focus lands on the offer, which now blocks editing.
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Apply them anyway'));
  });

  it('the documents list says when it could not be loaded, and opening it again retries', async () => {
    let fail = true;
    server({
      ...baseRoutes(),
      'GET /api/books/documents': () =>
        fail
          ? { status: 503, body: { error: { code: 'contacts_unavailable', message: 'down' } } }
          : { status: 200, body: { items: [{ id: 'd1', documentNumber: 'TEST-1', customerName: 'Probekunde' }], nextCursor: null } },
    });
    render(<TemplateComposer id="tpl1" />);
    await opened();
    const subject = screen.getByLabelText('Preview with') as HTMLSelectElement;
    fireEvent.focus(subject);
    expect(await screen.findByText('Your documents could not be loaded. Open this list again to retry.')).toBeTruthy();
    fail = false;
    fireEvent.mouseDown(subject);
    expect(await screen.findByText('TEST-1, Probekunde')).toBeTruthy();
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

describe('the template composer: keyboard', () => {
  const order = () => Array.from(document.querySelectorAll('[data-outline-select]')).map((b) => b.getAttribute('data-outline-select'));

  it('Alt+Up and Alt+Down move the selected block, keep focus on it and say where it is', async () => {
    server(baseRoutes());
    render(<TemplateComposer id="tpl1" />);
    await opened();
    const row = selectInOutline('introText');
    row.focus();
    fireEvent.keyDown(row, { key: 'ArrowUp', altKey: true });
    expect(order().indexOf('introText')).toBeLessThan(order().indexOf('title'));
    await waitFor(() => expect(document.activeElement?.getAttribute('data-outline-select')).toBe('introText'));
    await waitFor(() => expect(live()).toBe('Intro text, body, position 1.'));
  });

  it('a refused Alt+Up says so and never pulls focus away later', async () => {
    server(baseRoutes());
    render(<TemplateComposer id="tpl1" />);
    await opened();
    // The recipient may stand only in the address field, below the return line it may not pass.
    const row = selectInOutline('recipient');
    row.focus();
    fireEvent.keyDown(row, { key: 'ArrowDown', altKey: true });
    await waitFor(() => expect(live()).toBe('Recipient cannot move further down.'));
    // Typing in an inspector field afterwards keeps the focus there.
    selectInOutline('title');
    const size = screen.getByLabelText('Text size');
    size.focus();
    fireEvent.change(size, { target: { value: '20' } });
    expect(document.activeElement).toBe(size);
  });

  it('Delete on a block moves focus to the block that takes the selection', async () => {
    server(baseRoutes());
    render(<TemplateComposer id="tpl1" />);
    await opened();
    const row = selectInOutline('paymentDetails');
    row.focus();
    fireEvent.keyDown(row, { key: 'Delete' });
    await waitFor(() => expect(document.activeElement?.getAttribute('data-outline-select')).toBe('outroText'));
  });

  it('Enter on a block selects it and opens its inspector; Escape returns to page and theme', async () => {
    server(baseRoutes());
    render(<TemplateComposer id="tpl1" />);
    await opened();
    const row = document.querySelector<HTMLButtonElement>('[data-outline-select="totals"]')!;
    row.focus();
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(screen.getByRole('heading', { name: 'Totals' })).toBeTruthy();
    await waitFor(() => expect(document.querySelector('aside')!.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.getByRole('heading', { name: 'Page and theme' })).toBeTruthy();
  });

  it('Cmd+S saves from anywhere, a text field included', async () => {
    server({ ...baseRoutes(), 'PATCH /api/books/templates/tpl1': (body) => ({ status: 200, body: template(2, body!.document) }) });
    render(<TemplateComposer id="tpl1" />);
    await opened();
    selectInOutline('title');
    const size = screen.getByLabelText('Text size');
    fireEvent.change(size, { target: { value: '20' } });
    fireEvent.keyDown(size, { key: 's', metaKey: true });
    await waitFor(() => expect(header()).toContain('Version 2'));
  });

  it('a drag handle keeps its keys: Delete there removes nothing', async () => {
    server(baseRoutes());
    render(<TemplateComposer id="tpl1" />);
    await opened();
    selectInOutline('paymentDetails');
    const handle = screen.getByRole('button', { name: 'Move Payment details' });
    handle.focus();
    fireEvent.keyDown(handle, { key: 'Delete' });
    expect(document.querySelector('[data-outline-select="paymentDetails"]')).not.toBeNull();
  });
});

describe('the template composer: name, cells and the offer of earlier edits', () => {
  it('Escape cancels a rename; renaming back to the first name is saved', async () => {
    let name = 'Hausvorlage';
    server({
      ...baseRoutes(),
      'GET /api/books/templates/tpl1': () => ({ status: 200, body: { ...template(1), name } }),
      'PATCH /api/books/templates/tpl1': (body) => {
        name = body!.name;
        return { status: 200, body: { ...template(1), name } };
      },
    });
    render(<TemplateComposer id="tpl1" />);
    await opened();
    const input = screen.getByLabelText('Template name') as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: 'Typo' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.blur(input);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    await waitFor(() => expect(input.value).toBe('Hausvorlage'));

    fireEvent.change(input, { target: { value: 'Blau' } });
    fireEvent.blur(input);
    await waitFor(() => expect(name).toBe('Blau'));
    fireEvent.change(input, { target: { value: 'Hausvorlage' } });
    fireEvent.blur(input);
    await waitFor(() => expect(name).toBe('Hausvorlage'));
  });

  it('a columns row offers only blocks its region allows, and a full row cannot take another cell', async () => {
    server(baseRoutes());
    render(<TemplateComposer id="tpl1" />);
    await opened();
    selectInOutline('title');
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    expect(screen.getByRole('heading', { name: 'Columns' })).toBeTruthy();
    const options = Array.from((screen.getAllByLabelText('Add to this cell')[0] as HTMLSelectElement).options).map((o) => o.textContent);
    // A body row: no logo (it may not stand in the body), no second payment details.
    expect(options).toEqual(['Text', 'Payment QR code', 'Space', 'Line']);
    expect(screen.getByText('To add a cell, make one of the cells narrower first: the row is full.')).toBeTruthy();
  });

  it('while earlier edits are offered, the panels and saving wait for the choice', async () => {
    const doc = preset('klassisch') as unknown as Json;
    doc.regions.body[0].style.sizePt = 20;
    window.localStorage.setItem(
      'books-composer:tpl1',
      JSON.stringify({ format: 1, baseVersionId: 'v1', baseVersion: 1, document: doc, savedAt: '2026-10-23T08:15:00.000Z' }),
    );
    server(baseRoutes(2));
    render(<TemplateComposer id="tpl1" />);
    await screen.findByDisplayValue('Hausvorlage');
    await screen.findByText(/They were made on version 1/);
    expect(document.querySelector('[inert]')).not.toBeNull();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Discard them' }));
    expect(document.querySelector('[inert]')).toBeNull();
  });
});

describe('the template composer: re-entry after a save', () => {
  it('opening the template again after a save starts clean: the saved version, no notice, nothing to undo', async () => {
    let stored: unknown = preset('klassisch');
    let version = 1;
    server({
      ...baseRoutes(),
      'GET /api/books/templates/tpl1': () => ({ status: 200, body: template(version, stored) }),
      'PATCH /api/books/templates/tpl1': (body) => {
        version += 1;
        stored = body!.document;
        return { status: 200, body: template(version, stored) };
      },
    });
    const first = render(<TemplateComposer id="tpl1" />);
    await opened();
    selectInOutline('title');
    fireEvent.change(screen.getByLabelText('Text size'), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(header()).toContain('Version 2'));
    first.unmount();

    render(<TemplateComposer id="tpl1" />);
    await opened();
    expect(header()).toContain('Version 2');
    expect(header()).not.toContain('unsaved');
    expect(screen.queryByText(/are back/)).toBeNull();
    expect((screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(true);
    selectInOutline('title');
    expect((screen.getByLabelText('Text size') as HTMLSelectElement).value).toBe('20');
  });
});

describe('the template composer: the logo', () => {
  const SHA = 'a'.repeat(64);

  it('an uploaded logo goes to every logo block, and a refused upload says why', async () => {
    const modern = preset('modern') as unknown as Json;
    // A second logo block, in the page 2 header.
    modern.regions.followingPageHeader.push({ id: 'logo2', type: 'logo', style: {}, widthMm: 20, assetSha256: null });
    let refuse = true;
    server({
      ...baseRoutes(),
      'GET /api/books/templates/tpl1': () => ({ status: 200, body: template(1, modern) }),
      'POST /api/books/assets': () =>
        refuse
          ? { status: 422, body: { error: { code: 'asset_invalid', message: 'the image is wider than 2000 pixels' } } }
          : { status: 201, body: { sha256: SHA, contentType: 'image/png', byteSize: 120, widthPx: 400, heightPx: 100 } },
      'PATCH /api/books/templates/tpl1': (body) => ({ status: 200, body: template(2, body!.document) }),
    });
    render(<TemplateComposer id="tpl1" />);
    await screen.findByDisplayValue('Hausvorlage');
    await waitFor(() => expect(document.querySelector('[data-outline-select="logo"]')).not.toBeNull());
    selectInOutline('logo');
    expect(screen.getByText('No image yet: the block prints nothing until one is chosen.')).toBeTruthy();
    expect(screen.getByText(/A template prints one logo: every logo block shows it./)).toBeTruthy();
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'logo.png', { type: 'image/png' });

    fireEvent.change(screen.getByLabelText('Upload a logo'), { target: { files: [file] } });
    expect(await screen.findByText(/The logo cannot be used: the image is wider than 2000 pixels/)).toBeTruthy();
    expect(header()).not.toContain('unsaved');

    refuse = false;
    fireEvent.change(screen.getByLabelText('Upload a logo'), { target: { files: [file] } });
    expect(await screen.findByText('Logo set (400 × 100 pixels).')).toBeTruthy();
    expect(screen.getByAltText('The current logo').getAttribute('src')).toBe(`/api/books/assets/${SHA}`);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(header()).toContain('Version 2'));
    const saved = calls.find((c) => c.method === 'PATCH')!.body!.document;
    expect(saved.regions.firstPageHeader[0].assetSha256).toBe(SHA);
    expect(saved.regions.followingPageHeader.find((b: Json) => b.id === 'logo2').assetSha256).toBe(SHA);
  });

  it('a file that is not an image is refused before anything is sent', async () => {
    server({ ...baseRoutes(), 'GET /api/books/templates/tpl1': () => ({ status: 200, body: template(1, preset('modern')) }) });
    render(<TemplateComposer id="tpl1" />);
    await screen.findByDisplayValue('Hausvorlage');
    await waitFor(() => expect(document.querySelector('[data-outline-select="logo"]')).not.toBeNull());
    selectInOutline('logo');
    const file = new File(['%PDF-'], 'brief.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByLabelText('Upload a logo'), { target: { files: [file] } });
    expect(await screen.findByText('Choose a PNG, JPEG or SVG file.')).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST' && c.url.startsWith('/api/books/assets'))).toBe(false);
  });
});


describe('the template composer: your logos (choose a stored one, delete one nobody uses)', () => {
  const A = 'a'.repeat(64);
  const B = 'b'.repeat(64);
  const C = 'c'.repeat(64);
  const stored = (sha256: string, widthPx: number, inUse: boolean) => ({
    sha256,
    contentType: 'image/png',
    byteSize: 120,
    widthPx,
    heightPx: 100,
    createdAt: '2026-10-22T09:00:00.000Z',
    inUse,
  });

  async function openLogo(extra: Record<string, Handler>) {
    const modern = preset('modern') as unknown as Json;
    modern.regions.followingPageHeader.push({ id: 'logo2', type: 'logo', style: {}, widthMm: 20, assetSha256: null });
    server({
      ...baseRoutes(),
      'GET /api/books/templates/tpl1': () => ({ status: 200, body: template(1, modern) }),
      'PATCH /api/books/templates/tpl1': (body) => ({ status: 200, body: template(2, body!.document) }),
      ...extra,
    });
    render(<TemplateComposer id="tpl1" />);
    await screen.findByDisplayValue('Hausvorlage');
    await waitFor(() => expect(document.querySelector('[data-outline-select="logo"]')).not.toBeNull());
    selectInOutline('logo');
  }
  const logoList = () => screen.findByRole('list', { name: 'Your logos' });

  it('lists the stored logos; choosing one sets it on every logo block and announces it; one in use offers no delete', async () => {
    await openLogo({
      'GET /api/books/assets': () => ({ status: 200, body: { items: [stored(A, 400, false), stored(B, 300, true)] } }),
    });
    const list = await logoList();
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    // The logo in use says so and has no delete; the other one may be deleted.
    expect(within(items[1]).getByText('In use')).toBeTruthy();
    expect(within(items[1]).queryByRole('button', { name: /^Delete/ })).toBeNull();
    expect(within(items[0]).getByRole('button', { name: 'Delete the logo 400 × 100 pixels, uploaded 22.10.2026' })).toBeTruthy();

    const choose = within(list).getByRole('button', { name: 'Choose the logo 400 × 100 pixels, uploaded 22.10.2026' });
    expect(choose.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(choose);
    expect(await screen.findByText('Logo set (400 × 100 pixels).')).toBeTruthy();
    expect(screen.getByText('Logo set (400 × 100 pixels).').getAttribute('role')).toBe('status');
    expect(screen.getByAltText('The current logo').getAttribute('src')).toBe(`/api/books/assets/${A}`);
    // Chosen: pressed, and no delete (the working copy names it).
    const row = within(screen.getByRole('list', { name: 'Your logos' })).getAllByRole('listitem')[0];
    expect(within(row).getByRole('button', { name: /^Choose the logo 400/ }).getAttribute('aria-pressed')).toBe('true');
    expect(within(row).queryByRole('button', { name: /^Delete/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(header()).toContain('Version 2'));
    const saved = calls.find((c) => c.method === 'PATCH')!.body!.document;
    expect(saved.regions.firstPageHeader[0].assetSha256).toBe(A);
    expect(saved.regions.followingPageHeader.find((b: Json) => b.id === 'logo2').assetSha256).toBe(A);
  });

  it('deletes an unused logo after a confirmation that it cannot be undone; the focus moves to the list, then to the upload', async () => {
    let items = [stored(A, 400, false), stored(C, 200, false)];
    await openLogo({
      'GET /api/books/assets': () => ({ status: 200, body: { items } }),
      [`DELETE /api/books/assets/${A}`]: () => {
        items = items.filter((i) => i.sha256 !== A);
        return { status: 204, body: null };
      },
      [`DELETE /api/books/assets/${C}`]: () => {
        items = items.filter((i) => i.sha256 !== C);
        return { status: 204, body: null };
      },
    });
    const list = await logoList();

    // Cancel first: nothing is deleted, the focus goes back to the Delete button.
    const deleteA = within(list).getByRole('button', { name: /^Delete the logo 400/ });
    fireEvent.click(deleteA);
    let dialog = await screen.findByRole('alertdialog', { name: 'Delete this logo?' });
    expect(dialog.textContent).toContain('This cannot be undone.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(deleteA));

    // Confirmed: deleted, announced, the list drawn again and the focus on its first logo.
    fireEvent.click(deleteA);
    dialog = await screen.findByRole('alertdialog', { name: 'Delete this logo?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Logo deleted.')).toBeTruthy();
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Your logos' })).getAllByRole('listitem')).toHaveLength(1));
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual([`/api/books/assets/${A}`]);
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^Choose the logo 200/));

    // The last one: the focus goes to the upload.
    fireEvent.click(screen.getByRole('button', { name: /^Delete the logo 200/ }));
    dialog = await screen.findByRole('alertdialog', { name: 'Delete this logo?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('No logos stored yet. An uploaded logo appears here.')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Upload a logo')));
  });

  it('a logo that came into use meanwhile is refused (409): the reason is announced and the list shows it in use', async () => {
    let inUse = false;
    await openLogo({
      'GET /api/books/assets': () => ({ status: 200, body: { items: [stored(A, 400, inUse)] } }),
      [`DELETE /api/books/assets/${A}`]: () => {
        inUse = true;
        return { status: 409, body: { error: { code: 'asset_in_use', message: 'the logo is printed on an issued document', sha256: A } } };
      },
    });
    const list = await logoList();
    fireEvent.click(within(list).getByRole('button', { name: /^Delete the logo 400/ }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete this logo?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('This logo is printed on an issued document or used by a template, so it stays.')).toBeTruthy();
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Your logos' })).getByText('In use')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /^Delete the logo/ })).toBeNull();
    // The refused row is still there: the focus is back on it, not somewhere else in the list.
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^Choose the logo 400/));
  });

  it('a delete whose list cannot be read again moves the focus to the upload and says why', async () => {
    let failing = false;
    await openLogo({
      'GET /api/books/assets': () =>
        failing ? { status: 500, body: { error: { code: 'internal', message: 'boom' } } } : { status: 200, body: { items: [stored(A, 400, false)] } },
      [`DELETE /api/books/assets/${A}`]: () => {
        failing = true;
        return { status: 204, body: null };
      },
    });
    const list = await logoList();
    fireEvent.click(within(list).getByRole('button', { name: /^Delete the logo 400/ }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete this logo?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Logo deleted.')).toBeTruthy();
    expect((await screen.findByText(/^Your logos could not be loaded\./)).getAttribute('role')).toBe('alert');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Upload a logo')));
  });

  it('after a save the list is read again: a logo the saved version names shows "In use"', async () => {
    let saved = false;
    await openLogo({
      'GET /api/books/assets': () => ({ status: 200, body: { items: [stored(A, 400, saved)] } }),
      'PATCH /api/books/templates/tpl1': (body) => {
        saved = true;
        return { status: 200, body: template(2, body!.document) };
      },
    });
    const list = await logoList();
    fireEvent.click(within(list).getByRole('button', { name: /^Choose the logo 400/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(header()).toContain('Version 2'));
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Your logos' })).getByText('In use')).toBeTruthy());
    expect(calls.filter((c) => c.method === 'GET' && c.url === '/api/books/assets').length).toBeGreaterThanOrEqual(2);
  });

  it('an uploaded logo appears in the list; a list that cannot be read says so and the upload still works', async () => {
    let failing = true;
    let items: Array<ReturnType<typeof stored>> = [];
    await openLogo({
      'GET /api/books/assets': () =>
        failing ? { status: 500, body: { error: { code: 'internal', message: 'boom' } } } : { status: 200, body: { items } },
      'POST /api/books/assets': () => {
        items = [stored(A, 400, false)];
        return { status: 201, body: { sha256: A, contentType: 'image/png', byteSize: 120, widthPx: 400, heightPx: 100 } };
      },
    });
    // Announced: the message is an alert.
    expect((await screen.findByText(/^Your logos could not be loaded\./)).getAttribute('role')).toBe('alert');
    failing = false;
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'logo.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('Upload a logo'), { target: { files: [file] } });
    expect(await screen.findByText('Logo set (400 × 100 pixels).')).toBeTruthy();
    const list = await screen.findByRole('list', { name: 'Your logos' });
    expect(within(list).getByRole('button', { name: /^Choose the logo 400/ }).getAttribute('aria-pressed')).toBe('true');
  });
});

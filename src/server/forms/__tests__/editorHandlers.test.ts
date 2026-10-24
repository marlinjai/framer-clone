// The editor's submissions API handlers: the guard's answer is passed through
// untouched, the scope (tenant group + site) reaches every repository call,
// the cursor round-trips, a foreign or missing id answers 404, the CSV is an
// attachment that never caches, and a database failure is a loud 500.

import { describe, expect, it, vi, beforeEach } from 'vitest';

const repo = vi.hoisted(() => ({
  listFormSubmissions: vi.fn(),
  summarizeForms: vi.fn(),
  setFormSubmissionRead: vi.fn(),
  deleteFormSubmission: vi.fn(),
  exportFormSubmissions: vi.fn(),
}));
vi.mock('../repository', () => repo);

import {
  handleDeleteSubmission,
  handleExportSubmissions,
  handleListSubmissions,
  handlePatchSubmission,
} from '../editorHandlers';
import type { EditorFormsDeps } from '../editorHandlers';

const scope = { db: {} as never, tenantGroupId: 'tg-1' as never, siteId: 'site-1', workspaceId: 'ws-1' };
const allow: EditorFormsDeps = { resolve: async () => ({ ok: true, scope }) };
const deny: EditorFormsDeps = { resolve: async () => ({ ok: false, response: Response.json({ error: { code: 'forbidden' } }, { status: 403 }) }) };

const sub = (id: string, createdAt = '2026-10-24T10:00:00.000Z') => ({
  id,
  siteId: 'site-1',
  pageId: 'p',
  pagePath: '/kontakt',
  formId: 'form-1',
  formName: 'Contact',
  fields: [{ key: 'name', label: 'Name', type: 'text', value: 'Ana' }],
  readAt: null,
  createdAt: new Date(createdAt),
});

const req = (url: string, init?: RequestInit) => new Request(`https://app.example${url}`, init);

beforeEach(() => vi.clearAllMocks());

describe('editor submissions handlers', () => {
  it('pass a guard refusal through and touch nothing', async () => {
    const res = await handleListSubmissions(req('/x'), 'site-1', deny);
    expect(res.status).toBe(403);
    expect((await handleDeleteSubmission(req('/x'), 'site-1', 's1', deny)).status).toBe(403);
    expect(repo.listFormSubmissions).not.toHaveBeenCalled();
    expect(repo.deleteFormSubmission).not.toHaveBeenCalled();
  });

  it('list newest first with a cursor that round-trips, scoped to the site, no-store', async () => {
    repo.listFormSubmissions.mockResolvedValue({ submissions: [sub('s2'), sub('s1', '2026-10-23T10:00:00.000Z')], hasMore: true });
    repo.summarizeForms.mockResolvedValue([{ formId: 'form-1', formName: 'Contact', total: 3, unread: 1 }]);
    const res = await handleListSubmissions(req('/x?form=form-1&limit=2'), 'site-1', allow);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const json = await res.json();
    expect(json.submissions.map((s: { id: string }) => s.id)).toEqual(['s2', 's1']);
    expect(repo.listFormSubmissions).toHaveBeenCalledWith(scope.db, { tenantId: 'tg-1', siteId: 'site-1' }, { formId: 'form-1', limit: 2, before: undefined });
    await handleListSubmissions(req(`/x?cursor=${json.nextCursor}`), 'site-1', allow);
    expect(repo.listFormSubmissions.mock.calls[1][2].before).toEqual({ createdAt: new Date('2026-10-23T10:00:00.000Z'), id: 's1' });
    expect((await handleListSubmissions(req('/x?cursor=garbage'), 'site-1', allow)).status).toBe(400);
  });

  it('mark read validates the body and answers 404 for a row the site does not have', async () => {
    repo.setFormSubmissionRead.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const patch = (body: unknown) => req('/x', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await handlePatchSubmission(patch({ read: true }), 'site-1', 's1', allow)).status).toBe(200);
    expect((await handlePatchSubmission(patch({ read: true }), 'site-1', 'foreign', allow)).status).toBe(404);
    expect((await handlePatchSubmission(patch({ read: 'yes' }), 'site-1', 's1', allow)).status).toBe(400);
    expect(repo.setFormSubmissionRead).toHaveBeenCalledWith(scope.db, { tenantId: 'tg-1', siteId: 'site-1' }, 's1', true);
  });

  it('delete is real and answers 404 for an unknown id', async () => {
    repo.deleteFormSubmission.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await (await handleDeleteSubmission(req('/x', { method: 'DELETE' }), 'site-1', 's1', allow)).json()).toEqual({ id: 's1', deleted: true });
    expect((await handleDeleteSubmission(req('/x', { method: 'DELETE' }), 'site-1', 's1', allow)).status).toBe(404);
  });

  it('export answers a CSV attachment and says when it was cut at the cap', async () => {
    repo.exportFormSubmissions.mockResolvedValue({ submissions: [sub('s1')], truncated: true });
    const res = await handleExportSubmissions(req('/x/export?form=form-1'), 'site-1', allow);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="form-submissions-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(res.headers.get('x-export-truncated')).toBe('true');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toContain('Contact,/kontakt,no,Ana');
    expect(repo.exportFormSubmissions.mock.calls[0][2]).toEqual({ formId: 'form-1', max: 10_000 });
  });

  it('a database failure is a loud 500', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    repo.listFormSubmissions.mockRejectedValue(new Error('db down'));
    repo.summarizeForms.mockResolvedValue([]);
    const res = await handleListSubmissions(req('/x'), 'site-1', allow);
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('forms_failed');
    spy.mockRestore();
  });
});

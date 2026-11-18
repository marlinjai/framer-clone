// The editor's Form submissions view against a fake API: newest first, filter
// by form, open marks read, mark unread, delete one with an in-page
// confirmation, export link, load older, and failures shown with a retry.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import FormSubmissionsPanel, { type SubmissionItem } from '../FormSubmissionsPanel';

const BASE = '/api/projects/proj-1/forms/submissions';

function item(id: string, over: Partial<SubmissionItem> = {}): SubmissionItem {
  return {
    id,
    formId: 'form-a',
    formName: 'Contact',
    pageId: 'p1',
    pagePath: '/kontakt',
    fields: [
      { key: 'name', label: 'Name', type: 'text', value: `Visitor ${id}` },
      { key: 'consent', label: 'Consent', type: 'consent', value: true },
    ],
    readAt: null,
    createdAt: '2026-10-24T10:00:00.000Z',
    ...over,
  };
}

let rows: SubmissionItem[];
const forms = () => [
  { formId: 'form-a', formName: 'Contact', total: rows.filter((r) => r.formId === 'form-a').length, unread: rows.filter((r) => r.formId === 'form-a' && !r.readAt).length },
  { formId: 'form-b', formName: 'Booking', total: rows.filter((r) => r.formId === 'form-b').length, unread: 0 },
];
let failList = false;
let resendAnswer: { status: number; code?: string; message?: string } = { status: 200 };
let calls: { method: string; url: string; body?: unknown }[];

beforeEach(() => {
  rows = [item('s3'), item('s2', { readAt: '2026-10-24T11:00:00.000Z' }), item('s1', { formId: 'form-b', formName: 'Booking' })];
  failList = false;
  resendAnswer = { status: 200 };
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (method === 'GET') {
        if (failList) return new Response(JSON.stringify({ error: { message: 'database down' } }), { status: 500 });
        const u = new URL(url, 'http://x');
        const form = u.searchParams.get('form');
        const cursor = u.searchParams.get('cursor');
        let list = form ? rows.filter((r) => r.formId === form) : rows;
        if (!form && !cursor) list = list.slice(0, 2);
        else if (!form && cursor) list = rows.slice(2);
        return Response.json({ submissions: list, hasMore: !form && !cursor, nextCursor: !form && !cursor ? 'c1' : null, forms: forms() });
      }
      if (method === 'POST' && url.endsWith('/resend')) {
        if (resendAnswer.status !== 200) {
          return new Response(JSON.stringify({ error: { code: resendAnswer.code, message: resendAnswer.message } }), { status: resendAnswer.status });
        }
        return Response.json({ id: url.split('/').slice(-2)[0], queued: true });
      }
      const id = url.split('/').pop()!;
      if (method === 'PATCH') {
        const read = (JSON.parse(String(init!.body)) as { read: boolean }).read;
        rows = rows.map((r) => (r.id === id ? { ...r, readAt: read ? 'now' : null } : r));
        return Response.json({ id, read });
      }
      if (method === 'DELETE') {
        rows = rows.filter((r) => r.id !== id);
        return Response.json({ id, deleted: true });
      }
      return new Response(null, { status: 405 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('FormSubmissionsPanel', () => {
  it('lists newest first, offers the forms with counts, and an export link per filter', async () => {
    render(<FormSubmissionsPanel projectId="proj-1" />);
    const list = await screen.findByRole('list');
    const entries = within(list).getAllByRole('listitem');
    expect(entries[0].textContent).toContain('Visitor s3');
    expect(entries[0].textContent).toContain('(unread)');
    expect(screen.getByRole('option', { name: 'Contact (2, 1 unread)' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Export CSV/ }).getAttribute('href')).toBe(`${BASE}/export`);
    fireEvent.change(screen.getByLabelText('Form'), { target: { value: 'form-b' } });
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(1));
    expect(screen.getByRole('link', { name: /Export CSV/ }).getAttribute('href')).toBe(`${BASE}/export?form=form-b`);
  });

  it('opening an unread submission shows every field and marks it read; it can be marked unread again', async () => {
    render(<FormSubmissionsPanel projectId="proj-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Visitor s3/ }));
    expect(screen.getByText('Yes')).toBeTruthy();
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH' && c.url.endsWith('/s3'))).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ read: true });
    fireEvent.click(await screen.findByRole('button', { name: /Mark unread/ }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(2));
    expect(calls.filter((c) => c.method === 'PATCH')[1].body).toEqual({ read: false });
  });

  it('deletes only after the in-page confirmation, and "Keep" cancels', async () => {
    render(<FormSubmissionsPanel projectId="proj-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Visitor s2/ }));
    fireEvent.click(screen.getByRole('button', { name: /Delete/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /Delete/ }));
    const confirm = screen.getByRole('group', { name: 'Confirm delete' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByText(/Visitor s2/)).toBeNull());
    expect(calls.find((c) => c.method === 'DELETE')!.url).toBe(`${BASE}/s2`);
  });

  it('loads older submissions', async () => {
    render(<FormSubmissionsPanel projectId="proj-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Load older submissions' }));
    await screen.findByText(/Visitor s1/);
    expect(calls.some((c) => c.url.includes('cursor=c1'))).toBe(true);
    expect(screen.queryByRole('button', { name: 'Load older submissions' })).toBeNull();
  });

  it('a failed load is shown with a retry', async () => {
    failList = true;
    render(<FormSubmissionsPanel projectId="proj-1" />);
    expect((await screen.findByRole('alert')).textContent).toContain('database down');
    failList = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('list');
  });

  it('an empty site says how submissions arrive', async () => {
    rows = [];
    render(<FormSubmissionsPanel projectId="proj-1" />);
    await screen.findByText(/No submissions yet/);
  });

  describe('the email to the owner', () => {
    const failed = { status: 'failed' as const, reason: 'Lumitra Mail refused sending: api_key_revoked (401).', recipient: 'owner@bakery.example' };

    it('says nothing for a submission from before notifications, and "sent" without a resend button', async () => {
      rows = [item('s3', { notification: { status: 'sent', reason: null, recipient: 'owner@bakery.example' } }), item('s2')];
      render(<FormSubmissionsPanel projectId="proj-1" />);
      fireEvent.click(await screen.findByRole('button', { name: /Visitor s3/ }));
      expect(screen.getByTestId('submission-email-status').textContent).toContain('Email sent to owner@bakery.example');
      expect(screen.queryByRole('button', { name: /Send email again/ })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: /Visitor s2/ }));
      expect(screen.queryAllByTestId('submission-email-status')).toHaveLength(0);
    });

    it('a failed one is flagged in the list, shows why, and "Send email again" queues it', async () => {
      rows = [item('s3', { notification: failed })];
      render(<FormSubmissionsPanel projectId="proj-1" />);
      expect(await screen.findByText(/no email sent/)).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: /Visitor s3/ }));
      expect(screen.getByRole('alert').textContent).toContain('api_key_revoked');
      // Opening marks it read first; the button waits for that to finish.
      await waitFor(() => expect((screen.getByRole('button', { name: /Send email again/ }) as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(screen.getByRole('button', { name: /Send email again/ }));
      await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === `${BASE}/s3/resend`)).toBe(true));
      await waitFor(() => expect(screen.getByTestId('submission-email-status').textContent).toContain('is being sent'));
      expect(screen.queryByRole('button', { name: /Send email again/ })).toBeNull();
    });

    it('a resend the server refuses shows its message and keeps the button', async () => {
      resendAnswer = { status: 409, code: 'mail_not_connected', message: 'connect Lumitra Mail on the payments page first, then send this again' };
      rows = [item('s3', { notification: { status: 'skipped', reason: 'not_connected', recipient: 'owner@bakery.example' } })];
      render(<FormSubmissionsPanel projectId="proj-1" />);
      fireEvent.click(await screen.findByRole('button', { name: /Visitor s3/ }));
      expect(screen.getByTestId('submission-email-status').textContent).toContain('payments page');
      await waitFor(() => expect((screen.getByRole('button', { name: /Send email again/ }) as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(screen.getByRole('button', { name: /Send email again/ }));
      await waitFor(() =>
        expect(screen.getAllByRole('alert').some((el) => el.textContent?.includes('connect Lumitra Mail on the payments page first'))).toBe(true),
      );
      expect(screen.getByRole('button', { name: /Send email again/ })).toBeTruthy();
    });
  });
});

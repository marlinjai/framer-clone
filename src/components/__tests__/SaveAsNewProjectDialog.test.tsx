// "Save as a new project" for the browser-only demo editor.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';

const push = vi.fn();
const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace }) }));

import SaveAsNewProjectDialog from '../SaveAsNewProjectDialog';
import { takeStashedDemoProject } from '@/lib/projects/demoStash';

const fetchMock = vi.fn();
const onSaved = vi.fn();
const SNAPSHOT = { id: 'demo', metadata: { title: 'Framer Clone Demo' }, pages: { p1: { slug: '' } } };

beforeEach(() => {
  push.mockReset();
  replace.mockReset();
  onSaved.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderDialog() {
  return render(
    <SaveAsNewProjectDialog
      open
      onOpenChange={() => {}}
      defaultName="Framer Clone Demo"
      getSnapshot={() => SNAPSHOT}
      currentPageId="p1"
      onSaved={onSaved}
    />,
  );
}

const fail = (code: string, status = 403) =>
  new Response(JSON.stringify({ error: { code, message: code } }), { status });

describe('Save as a new project', () => {
  it('prefills the name; saving creates the project from the pages and opens it on the same page', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ siteId: 'new-site' }), { status: 200 }));
    renderDialog();
    const input = screen.getByLabelText('Project name') as HTMLInputElement;
    expect(input.value).toBe('Framer Clone Demo');
    fireEvent.change(input, { target: { value: '  Crumb & Hearth  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save project' }));
    // replace, not push: Back must not reopen the (now saved) demo.
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/projects/new-site?page=p1'));
    expect(push).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/projects');
    expect(JSON.parse(init.body)).toEqual({ name: 'Crumb & Hearth', project: { pages: SNAPSHOT.pages } });
  });

  it('an empty name is refused with a message and nothing is sent', () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: '  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save project' }));
    expect(screen.getByRole('alert').textContent).toBe('A project needs a name.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('no company with Lumitra Sites: says so and what to do', async () => {
    fetchMock.mockResolvedValue(fail('sites_not_enabled'));
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Save project' }));
    expect((await screen.findByRole('alert')).textContent).toContain('None of your companies has Lumitra Sites');
    expect(replace).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('no company chosen: offers the chooser (and back), and keeps the work for the trip', async () => {
    fetchMock.mockResolvedValue(fail('no_active_company'));
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Save project' }));
    await screen.findByRole('alert');
    const link = screen.getByRole('link', { name: 'Choose a company' });
    expect(link.getAttribute('href')).toBe('/projects?switch=1&next=/');
    // Nothing is stashed until the person actually leaves through the link.
    expect(takeStashedDemoProject()).toBeNull();
    fireEvent.click(link);
    expect(takeStashedDemoProject()).toEqual({ snapshot: SNAPSHOT, pageId: 'p1' });
  });

  it('a failure keeps the dialog open with the reason', async () => {
    fetchMock.mockResolvedValue(fail('forbidden'));
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Save project' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'You need to be an administrator of this company to create a project in it.',
    );
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});

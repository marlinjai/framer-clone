// PublishButton tests.
//
// Asserts the editor Publish action: a click serializes the live project and
// POSTs it to /api/projects/publish, and BOTH outcomes surface loudly:
//   - success renders a confirmation with the published page count,
//   - a structured server error (e.g. 403) renders that error message,
//   - a network failure renders the thrown error (never a silent no-op).
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from '@testing-library/react';
import ProjectModel from '@/models/ProjectModel';
import PublishButton from '../PublishButton';

// A real MST project so getSnapshot(project) in the component works unmocked.
function makeProject() {
  const p = ProjectModel.create({
    id: 'site_1',
    metadata: { title: 'Demo', description: '' },
    pages: {},
  });
  p.createPage('Home');
  return p;
}

let currentStore: { editorUI: { currentProject: unknown } };

vi.mock('@/hooks/useStore', () => ({
  useStore: () => currentStore,
}));

const fetchMock = vi.fn();

beforeEach(() => {
  currentStore = { editorUI: { currentProject: makeProject() } };
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PublishButton', () => {
  it('POSTs the serialized project to the publish endpoint and shows a success confirmation', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        siteId: 'site_1',
        status: 'published',
        publishedPages: ['', 'about'],
      }),
    });

    render(<PublishButton />);
    fireEvent.click(screen.getByRole('button', { name: /publish/i }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/projects/publish');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.project.id).toBe('site_1');

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('Published 2 pages'),
    );
  });

  it('surfaces the live URL as a clickable link after a successful publish', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        siteId: 'site_1',
        status: 'published',
        publishedPages: [''],
        subdomain: 'demo',
        liveUrl: 'https://demo.sites.lumitra.co',
      }),
    });

    render(<PublishButton />);
    fireEvent.click(screen.getByRole('button', { name: /publish/i }));

    const link = (await screen.findByRole('link', {
      name: /live at/i,
    })) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://demo.sites.lumitra.co');
    expect(link.textContent).toContain('demo.sites.lumitra.co');
  });

  it('shows the bare subdomain (no link) when liveUrl is null in local dev', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        siteId: 'site_1',
        status: 'published',
        publishedPages: [''],
        subdomain: 'demo',
        liveUrl: null,
      }),
    });

    render(<PublishButton />);
    fireEvent.click(screen.getByRole('button', { name: /publish/i }));

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('live at demo'),
    );
    expect(screen.queryByRole('link', { name: /live at/i })).toBeNull();
  });

  it('surfaces a structured server error (403) instead of silently succeeding', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: { code: 'forbidden', message: 'Forbidden' } }),
    });

    render(<PublishButton />);
    fireEvent.click(screen.getByRole('button', { name: /publish/i }));

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Forbidden'),
    );
  });

  it('surfaces a network failure loudly', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));

    render(<PublishButton />);
    fireEvent.click(screen.getByRole('button', { name: /publish/i }));

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('offline'),
    );
  });
});

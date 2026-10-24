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
import { SiteAddressProvider, useSiteAddress } from '@/contexts/SiteAddressContext';

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

  it('tells the page settings panel where the site now lives', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ publishedPages: [''], liveUrl: 'https://abc123.sites.lumitra.co', subdomain: 'abc123' }),
    });
    const Address = () => {
      const { address } = useSiteAddress();
      return <span data-testid="address">{`${address.host ?? 'none'}|${address.everPublished}`}</span>;
    };
    render(
      <SiteAddressProvider>
        <PublishButton />
        <Address />
      </SiteAddressProvider>,
    );
    expect(screen.getByTestId('address').textContent).toBe('none|false');
    fireEvent.click(screen.getByRole('button', { name: /publish/i }));
    await waitFor(() =>
      expect(screen.getByTestId('address').textContent).toBe('abc123.sites.lumitra.co|true'),
    );
  });
});

describe('PublishButton legal check', () => {
  const ok = { ok: true, status: 200, json: async () => ({ publishedPages: [''] }) };

  function businessProject() {
    const p = makeProject();
    const base = p.site;
    p.updateSiteSettings({ ...base, language: 'de', business: { ...base.business, legalName: 'Bäckerei Müller GmbH' } });
    return p;
  }

  it('warns in the page, not with a browser dialog, when business data has no Impressum', () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    const project = businessProject();
    const setCurrentPage = vi.fn();
    currentStore = { editorUI: { currentProject: project, setCurrentPage } } as typeof currentStore;
    render(<PublishButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
    const notice = screen.getByRole('dialog', { name: 'Your site has no Impressum yet' });
    expect(document.activeElement).toBe(notice);

    fireEvent.click(screen.getByRole('button', { name: 'Create Impressum' }));
    const created = project.findPageBySlug('impressum');
    expect(created?.metadata.legalTemplate).toBe('impressum');
    expect(setCurrentPage).toHaveBeenCalledWith(created);
    expect(screen.queryByTestId('publish-legal-notice')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('publishes anyway on request', async () => {
    fetchMock.mockResolvedValue(ok);
    currentStore = { editorUI: { currentProject: businessProject(), setCurrentPage: vi.fn() } } as typeof currentStore;
    render(<PublishButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    fireEvent.click(screen.getByRole('button', { name: 'Publish anyway' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Published 1 page'));
  });

  it('Escape and Cancel close the notice without publishing', () => {
    currentStore = { editorUI: { currentProject: businessProject(), setCurrentPage: vi.fn() } } as typeof currentStore;
    render(<PublishButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    fireEvent.keyDown(screen.getByTestId('publish-legal-notice'), { key: 'Escape' });
    expect(screen.queryByTestId('publish-legal-notice')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('publish-legal-notice')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lists legal pages that still hold placeholders and opens them', () => {
    const project = businessProject();
    const { page } = project.createLegalPage('impressum');
    const setCurrentPage = vi.fn();
    currentStore = { editorUI: { currentProject: project, setCurrentPage } } as typeof currentStore;
    render(<PublishButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(screen.getByRole('dialog', { name: 'Your legal pages still have placeholders' })).toBeTruthy();
    expect(screen.getByTestId('publish-legal-notice').textContent).toMatch(/Impressum: \d+ parts in \[square brackets\]/);
    fireEvent.click(screen.getByRole('button', { name: 'Open Impressum' }));
    expect(setCurrentPage).toHaveBeenCalledWith(page);
  });

  it('publishes straight away for a site without business data', () => {
    fetchMock.mockResolvedValue(ok);
    render(<PublishButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('publish-legal-notice')).toBeNull();
  });
});

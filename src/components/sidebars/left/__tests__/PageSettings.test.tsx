// Page settings panel: opened from the PAGES list (settings button, double
// click, context menu), saves name + slug + description through the model,
// explains invalid input inline, keeps the home page's URL fixed, and tells
// the owner when old links will redirect.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen, within } from '@testing-library/react';
import ProjectModel, { type ProjectModelType } from '@/models/ProjectModel';
import type { PageModelType } from '@/models/PageModel';
import { SiteAddressProvider, type SiteAddress } from '@/contexts/SiteAddressContext';
import PagesPanel from '../PagesPanel';

let project: ProjectModelType;
let about: PageModelType;
let home: PageModelType;
let currentPage: PageModelType | undefined;

vi.mock('@/hooks/useStore', () => ({
  useStore: () => ({
    editorUI: {
      get currentProject() {
        return project;
      },
      get currentPage() {
        return currentPage;
      },
      setCurrentPage: (p: PageModelType) => {
        currentPage = p;
      },
    },
  }),
}));

beforeEach(() => {
  project = ProjectModel.create({ id: 'site_1', metadata: { title: 'Bakery' }, pages: {} });
  home = project.createPage('Hearth & Crumb Bakery');
  home.setSlug('');
  about = project.createPage('About');
  project.createPage('Contact');
  currentPage = home;
});

afterEach(() => cleanup());

function renderPanel(address: SiteAddress = { host: 'abc123.sites.lumitra.co', everPublished: true }) {
  return render(
    <SiteAddressProvider initial={address}>
      <PagesPanel />
    </SiteAddressProvider>,
  );
}

function openSettingsFor(title: string) {
  fireEvent.click(screen.getByRole('button', { name: `Page settings for ${title}` }));
  return screen.getByTestId('page-settings-dialog');
}

describe('opening page settings', () => {
  it('opens from the row settings button with the page values', () => {
    renderPanel();
    const dialog = openSettingsFor('About');
    expect(within(dialog).getByLabelText('Page name')).toHaveProperty('value', 'About');
    expect(within(dialog).getByLabelText('URL slug')).toHaveProperty('value', 'about');
    expect(within(dialog).getByTestId('page-settings-url-preview').textContent).toBe('abc123.sites.lumitra.co/about');
  });

  it('opens on a double-click of the row', () => {
    renderPanel();
    fireEvent.doubleClick(screen.getByTestId(`page-row-${about.id}`));
    expect(screen.getByTestId('page-settings-dialog')).toBeTruthy();
  });

  it('opens from the context menu', () => {
    renderPanel();
    fireEvent.contextMenu(screen.getByTestId(`page-row-${about.id}`), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole('menuitem', { name: /Page settings/ }));
    expect(screen.getByTestId('page-settings-dialog')).toBeTruthy();
  });

  it('shows each page slug in the list, the home page as /', () => {
    renderPanel();
    expect(within(screen.getByTestId(`page-row-${home.id}`)).getByText('/')).toBeTruthy();
    expect(within(screen.getByTestId(`page-row-${about.id}`)).getByText('/about')).toBeTruthy();
  });
});

describe('saving', () => {
  it('saves name, slug and description and closes', () => {
    renderPanel();
    const dialog = openSettingsFor('About');
    fireEvent.change(within(dialog).getByLabelText('Page name'), { target: { value: 'About us' } });
    fireEvent.change(within(dialog).getByLabelText('URL slug'), { target: { value: 'Company/About Us' } });
    fireEvent.change(within(dialog).getByLabelText('Meta description'), { target: { value: 'Who we are' } });
    expect(within(dialog).getByTestId('page-settings-url-preview').textContent).toBe(
      'abc123.sites.lumitra.co/company/about-us',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(screen.queryByTestId('page-settings-dialog')).toBeNull();
    expect(about.metadata.title).toBe('About us');
    expect(about.slug).toBe('company/about-us');
    expect(about.metadata.description).toBe('Who we are');
  });

  it('saves on Enter in a field', () => {
    renderPanel();
    const dialog = openSettingsFor('About');
    const slug = within(dialog).getByLabelText('URL slug');
    fireEvent.change(slug, { target: { value: 'team' } });
    fireEvent.submit(slug.closest('form')!);
    expect(about.slug).toBe('team');
  });

  it('cancel leaves the page untouched', () => {
    renderPanel();
    const dialog = openSettingsFor('About');
    fireEvent.change(within(dialog).getByLabelText('URL slug'), { target: { value: 'team' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('page-settings-dialog')).toBeNull();
    expect(about.slug).toBe('about');
  });

  it('fills the slug from the page name, transliterated', () => {
    renderPanel();
    const dialog = openSettingsFor('About');
    fireEvent.change(within(dialog).getByLabelText('Page name'), { target: { value: 'Über uns' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Use page name/ }));
    expect(within(dialog).getByLabelText('URL slug')).toHaveProperty('value', 'ueber-uns');
  });
});

describe('invalid input', () => {
  function trySlug(value: string) {
    renderPanel();
    const dialog = openSettingsFor('About');
    const input = within(dialog).getByLabelText('URL slug');
    fireEvent.change(input, { target: { value } });
    fireEvent.blur(input);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    return { dialog, input };
  }

  it('explains a slug another page uses and keeps the dialog open', () => {
    const { dialog, input } = trySlug('contact');
    expect(within(dialog).getByText(/Another page already uses/)).toBeTruthy();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toContain('page-settings-slug-error');
    expect(about.slug).toBe('about');
  });

  it('explains a reserved path', () => {
    const { dialog } = trySlug('api');
    expect(within(dialog).getByText(/reserved by the site itself/)).toBeTruthy();
    expect(about.slug).toBe('about');
  });

  it('explains bad characters', () => {
    const { dialog } = trySlug('café');
    expect(within(dialog).getByText(/Use only lowercase letters/)).toBeTruthy();
  });

  it('explains double hyphens and an empty slug', () => {
    expect(within(trySlug('a--b').dialog).getByText(/single hyphens/)).toBeTruthy();
    cleanup();
    expect(within(trySlug('').dialog).getByText(/Enter a URL slug/)).toBeTruthy();
  });

  it('refuses an empty page name', () => {
    renderPanel();
    const dialog = openSettingsFor('About');
    fireEvent.change(within(dialog).getByLabelText('Page name'), { target: { value: '  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(within(dialog).getByText('Enter a page name.')).toBeTruthy();
    expect(about.metadata.title).toBe('About');
  });
});

describe('the home page', () => {
  it('shows its URL as the site root, read-only, and says why', () => {
    renderPanel();
    const dialog = openSettingsFor('Hearth & Crumb Bakery');
    const slug = within(dialog).getByLabelText('URL slug') as HTMLInputElement;
    expect(slug.readOnly).toBe(true);
    expect(slug.value).toBe('/');
    expect(within(dialog).getByText(/This is the home page/)).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: /Use page name/ })).toBeNull();
    expect(within(dialog).getByTestId('page-settings-url-preview').textContent).toBe('abc123.sites.lumitra.co/');
  });

  it('can still be renamed', () => {
    renderPanel();
    const dialog = openSettingsFor('Hearth & Crumb Bakery');
    fireEvent.change(within(dialog).getByLabelText('Page name'), { target: { value: 'Start' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(home.metadata.title).toBe('Start');
    expect(home.slug).toBe('');
  });
});

describe('old links', () => {
  it('says old links will redirect when a published page changes its slug', () => {
    renderPanel();
    const dialog = openSettingsFor('About');
    expect(within(dialog).queryByTestId('page-settings-redirect-note')).toBeNull();
    fireEvent.change(within(dialog).getByLabelText('URL slug'), { target: { value: 'team' } });
    expect(within(dialog).getByTestId('page-settings-redirect-note').textContent).toMatch(
      /Old links will redirect: \/about will lead to \/team/,
    );
  });

  it('says nothing about redirects before the first publish, and explains the address', () => {
    renderPanel({ host: null, everPublished: false });
    const dialog = openSettingsFor('About');
    fireEvent.change(within(dialog).getByLabelText('URL slug'), { target: { value: 'team' } });
    expect(within(dialog).queryByTestId('page-settings-redirect-note')).toBeNull();
    expect(within(dialog).getByText(/when you publish it for the first time/)).toBeTruthy();
    expect(within(dialog).getByTestId('page-settings-url-preview').textContent).toBe('your-site-address/team');
  });
});

describe('deleting', () => {
  it('never offers to delete the home page, which serves the site root', () => {
    renderPanel();
    expect(screen.queryByRole('button', { name: 'Delete page Hearth & Crumb Bakery' })).toBeNull();
    fireEvent.contextMenu(screen.getByTestId(`page-row-${home.id}`), { clientX: 10, clientY: 10 });
    expect(screen.getByRole('menuitem', { name: /Delete/ })).toHaveProperty('disabled', true);
  });

  it('still deletes other pages', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Delete page About' }));
    expect(project.getPage(about.id)).toBeUndefined();
  });
});

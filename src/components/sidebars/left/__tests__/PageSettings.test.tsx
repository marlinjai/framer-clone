// Page settings panel: opened from the PAGES list (settings button, double
// click, context menu), saves name + slug + description through the model,
// explains invalid input inline, keeps the home page's URL fixed, and tells
// the owner when old links will redirect.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen, within, waitFor, act } from '@testing-library/react';
import { expectBodyScrollsFooterFixed } from '@/components/ui/__tests__/viewportFit';
import ProjectModel, { type ProjectModelType } from '@/models/ProjectModel';
import type { PageModelType } from '@/models/PageModel';
import { SiteAddressProvider, type SiteAddress } from '@/contexts/SiteAddressContext';
import PagesPanel, { clampMenuPosition } from '../PagesPanel';

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
  it('opens on a double-click of the HOME row, also when it is the project\'s only page', () => {
    // The live report: a project whose only page is the home page ("/").
    project.removePage(about.id);
    for (const p of project.pagesArray) if (!p.isHome) project.removePage(p.id);
    expect(project.pagesArray).toHaveLength(1);
    currentPage = home;
    renderPanel();
    const row = screen.getByTestId(`page-row-${home.id}`);

    // On the row itself, on the select button, and on the title and slug text.
    const targets = [
      row,
      within(row).getAllByRole('button')[0],
      within(row).getByText('Hearth & Crumb Bakery'),
      within(row).getByText('/'),
    ];
    for (const target of targets) {
      fireEvent.doubleClick(target);
      const dialog = screen.getByTestId('page-settings-dialog');
      expect(within(dialog).getByLabelText('Page name')).toHaveProperty('value', 'Hearth & Crumb Bakery');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByTestId('page-settings-dialog')).toBeNull();
    }
  });

  it('opens on a double-click of every row, the home row included', () => {
    renderPanel();
    for (const page of project.pagesArray) {
      fireEvent.doubleClick(within(screen.getByTestId(`page-row-${page.id}`)).getAllByRole('button')[0]);
      const dialog = screen.getByTestId('page-settings-dialog');
      expect(within(dialog).getByLabelText('Page name')).toHaveProperty('value', page.metadata.title);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    }
  });

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

function slugError(dialog: HTMLElement): string {
  return dialog.querySelector('#page-settings-slug-error')?.textContent ?? '';
}

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
    expect(slugError(dialog)).toMatch(/Another page already uses/);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toContain('page-settings-slug-error');
    expect(about.slug).toBe('about');
  });

  it('explains a reserved path', () => {
    const { dialog } = trySlug('api');
    expect(slugError(dialog)).toMatch(/reserved by the site itself/);
    expect(about.slug).toBe('about');
  });

  it('explains bad characters', () => {
    const { dialog } = trySlug('café');
    expect(slugError(dialog)).toMatch(/Use only lowercase letters/);
  });

  it('explains double hyphens and an empty slug', () => {
    expect(slugError(trySlug('a--b').dialog)).toMatch(/single hyphens/);
    cleanup();
    expect(slugError(trySlug('').dialog)).toMatch(/Enter a URL slug/);
  });

  it('refuses an empty page name', () => {
    renderPanel();
    const dialog = openSettingsFor('About');
    fireEvent.change(within(dialog).getByLabelText('Page name'), { target: { value: '  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(dialog.querySelector('#page-settings-name-error')?.textContent).toBe('Enter a page name.');
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
  it('never deletes the home page, which serves the site root; its delete controls explain why instead', () => {
    renderPanel();
    const x = screen.getByRole('button', { name: 'Delete page Hearth & Crumb Bakery' });
    expect(x.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(x);
    expect(project.getPage(home.id)).toBeDefined();
    expect(screen.getByTestId('page-delete-notice').textContent).toContain('The home page cannot be deleted.');
    fireEvent.contextMenu(screen.getByTestId(`page-row-${home.id}`), { clientX: 10, clientY: 10 });
    const item = screen.getByRole('menuitem', { name: /Delete/ });
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(project.getPage(home.id)).toBeDefined();
  });

  it('still deletes other pages', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Delete page About' }));
    expect(project.getPage(about.id)).toBeUndefined();
  });
});

describe('keyboard and screen readers', () => {
  it('focuses the first menu item, moves with the arrow keys and wraps', () => {
    renderPanel();
    fireEvent.contextMenu(screen.getByTestId(`page-row-${about.id}`), { clientX: 10, clientY: 10 });
    const items = screen.getAllByRole('menuitem');
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(items[2], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0], { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[2]);
  });

  it('anchors the menu to the row when opened from the keyboard (Shift+F10)', () => {
    renderPanel();
    fireEvent.contextMenu(screen.getByTestId(`page-row-${about.id}`), { clientX: 0, clientY: 0 });
    const menu = screen.getByRole('menu');
    expect(menu.style.left).toBe('16px');
  });

  it('keeps editor shortcuts from firing inside the menu, the rows and the dialog', () => {
    const editorShortcut = vi.fn();
    window.addEventListener('keydown', editorShortcut);
    try {
      renderPanel();
      const row = screen.getByTestId(`page-row-${about.id}`);
      fireEvent.keyDown(within(row).getAllByRole('button')[0], { key: 'Delete' });
      fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });
      fireEvent.keyDown(screen.getAllByRole('menuitem')[0], { key: 'Backspace' });
      fireEvent.keyDown(screen.getAllByRole('menuitem')[0], { key: 'z', metaKey: true });
      fireEvent.click(screen.getAllByRole('menuitem')[0]);
      fireEvent.keyDown(screen.getByRole('button', { name: 'Save' }), { key: 'Delete' });
      expect(editorShortcut).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', editorShortcut);
    }
  });

  it('returns focus to the row after Escape closes the menu', () => {
    renderPanel();
    const row = screen.getByTestId(`page-row-${about.id}`);
    fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });
    fireEvent.keyDown(screen.getAllByRole('menuitem')[0], { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(within(row).getAllByRole('button')[0]);
  });

  it('returns focus to the settings button when the dialog closes', async () => {
    renderPanel();
    const button = screen.getByRole('button', { name: 'Page settings for About' });
    button.focus();
    fireEvent.click(button);
    fireEvent.click(within(screen.getByTestId('page-settings-dialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(document.activeElement).toBe(button));
  });

  it('on a failed save, focuses the slug field and announces the problem', () => {
    renderPanel();
    const dialog = openSettingsFor('About');
    const slug = within(dialog).getByLabelText('URL slug');
    fireEvent.change(slug, { target: { value: 'api' } });
    within(dialog).getByRole('button', { name: 'Save' }).focus();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(document.activeElement).toBe(slug);
    expect(screen.getByTestId('page-settings-announcement').textContent).toMatch(/Not saved\..*reserved/);
  });
});

describe('older projects', () => {
  it('keeps an untouched legacy slug exactly when only the name changes', () => {
    about.setSlug('Old_Slug');
    renderPanel();
    const dialog = openSettingsFor('About');
    fireEvent.change(within(dialog).getByLabelText('Page name'), { target: { value: 'About us' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(screen.queryByTestId('page-settings-dialog')).toBeNull();
    expect(about.metadata.title).toBe('About us');
    expect(about.slug).toBe('Old_Slug');
  });

  it('a project without a home page can give any page the root', () => {
    project.removePage(home.id);
    renderPanel();
    fireEvent.contextMenu(screen.getByTestId(`page-row-${about.id}`), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole('menuitem', { name: /Set as home page/ }));
    const dialog = screen.getByTestId('set-home-page-dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set as home page' }));
    expect(about.slug).toBe('');
    expect(screen.getByRole('button', { name: 'Delete page About' }).getAttribute('aria-disabled')).toBe('true');
  });

  it('explains a published site without a configured address', () => {
    renderPanel({ host: null, everPublished: true });
    const dialog = openSettingsFor('About');
    expect(within(dialog).getByText(/no public address is configured/)).toBeTruthy();
  });
});

describe('fits a small window', () => {
  it('keeps the fields in the scrolling body and Save / Cancel outside it', () => {
    renderPanel();
    const dialog = openSettingsFor('About');
    expectBodyScrollsFooterFixed(dialog, within(dialog).getByLabelText('URL slug'));
    const body = screen.getByTestId('page-settings-body');
    expect(body.getAttribute('data-slot')).toBe('dialog-body');
    expect(within(body).getByLabelText('URL slug')).toBeTruthy();
    expect(within(body).queryByRole('button', { name: 'Save' })).toBeNull();
    const footer = within(dialog).getByRole('button', { name: 'Save' }).closest('[data-slot="dialog-footer"]');
    expect(footer).not.toBeNull();
    expect(body.contains(footer)).toBe(false);
  });
});

describe('the failed-save announcement', () => {
  it('clears as soon as a field changes', () => {
    renderPanel();
    const dialog = openSettingsFor('About');
    const slug = within(dialog).getByLabelText('URL slug');
    fireEvent.change(slug, { target: { value: 'api' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    const announcement = screen.getByTestId('page-settings-announcement');
    expect(announcement.textContent).toMatch(/Not saved/);

    fireEvent.change(slug, { target: { value: 'team' } });
    expect(announcement.textContent).toBe('');

    fireEvent.change(slug, { target: { value: 'api' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(announcement.textContent).toMatch(/Not saved/);
    fireEvent.change(within(dialog).getByLabelText('Page name'), { target: { value: 'Team' } });
    expect(announcement.textContent).toBe('');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    fireEvent.change(within(dialog).getByLabelText('Meta description'), { target: { value: 'x' } });
    expect(announcement.textContent).toBe('');
  });
});

describe('context menu near the window edge', () => {
  it('moves back inside the window', () => {
    expect(clampMenuPosition(790, 470, { width: 160, height: 90 }, { width: 800, height: 480 })).toEqual({
      left: 632,
      top: 382,
    });
    expect(clampMenuPosition(20, 30, { width: 160, height: 90 }, { width: 800, height: 480 })).toEqual({
      left: 20,
      top: 30,
    });
    expect(clampMenuPosition(-5, -5, { width: 900, height: 900 }, { width: 800, height: 480 })).toEqual({
      left: 8,
      top: 8,
    });
  });

  it('caps its height and scrolls when the window is tiny', () => {
    renderPanel();
    fireEvent.contextMenu(screen.getByTestId(`page-row-${about.id}`), { clientX: 10, clientY: 10 });
    const classes = (screen.getByRole('menu').getAttribute('class') ?? '').split(/\s+/);
    expect(classes).toEqual(
      expect.arrayContaining([
        'max-h-[calc(100vh-1rem)]',
        'supports-[height:100dvh]:max-h-[calc(100dvh-1rem)]',
        'overflow-y-auto',
      ]),
    );
  });

  it('opened at the bottom-right corner of an 800x480 window, it moves inside, and again on resize', () => {
    const rect = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ width: 160, height: 90, top: 0, left: 0, right: 160, bottom: 90, x: 0, y: 0, toJSON: () => ({}) });
    const width = window.innerWidth;
    const height = window.innerHeight;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 480 });
    try {
      renderPanel();
      fireEvent.contextMenu(screen.getByTestId(`page-row-${about.id}`), { clientX: 790, clientY: 470 });
      const menu = screen.getByRole('menu');
      expect(menu.style.left).toBe('632px');
      expect(menu.style.top).toBe('382px');

      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 300 });
      act(() => {
        window.dispatchEvent(new Event('resize'));
      });
      expect(menu.style.top).toBe('202px');
    } finally {
      rect.mockRestore();
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
    }
  });
});

describe('search and sharing fields', () => {
  it('saves a sharing image, the noindex switch and the 404 choice with the rest', () => {
    renderPanel();
    const dialog = openSettingsFor('About');
    fireEvent.change(within(dialog).getByLabelText('Sharing image'), {
      target: { value: 'https://cdn.example.com/about.jpg' },
    });
    fireEvent.click(within(dialog).getByTestId('page-settings-noindex'));
    fireEvent.click(within(dialog).getByTestId('page-settings-404'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(about.metadata.ogImage).toBe('https://cdn.example.com/about.jpg');
    expect(about.metadata.noIndex).toBe(true);
    expect(project.site.notFoundPageId).toBe(about.id);
  });

  it('refuses a sharing image that is not an https address and focuses it', () => {
    renderPanel();
    const dialog = openSettingsFor('About');
    const input = within(dialog).getByLabelText('Sharing image');
    fireEvent.change(input, { target: { value: 'http://insecure.test/a.jpg' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(screen.getByTestId('page-settings-dialog')).toBeTruthy();
    expect(document.activeElement).toBe(input);
    expect(about.metadata.ogImage).toBe('');
  });

  it('a 404 page is always hidden from search engines, and the home page offers no 404 choice', () => {
    renderPanel();
    let dialog = openSettingsFor('About');
    fireEvent.click(within(dialog).getByTestId('page-settings-404'));
    const noindex = within(dialog).getByTestId('page-settings-noindex') as HTMLInputElement;
    expect(noindex.checked).toBe(true);
    expect(noindex.disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    dialog = openSettingsFor('Hearth & Crumb Bakery');
    expect(within(dialog).queryByTestId('page-settings-404')).toBeNull();
  });

  it('says which page it replaces when another page is the 404 page', () => {
    const contact = project.pagesArray.find((p) => p.metadata.title === 'Contact')!;
    project.updatePageSettings(contact.id, { title: 'Contact', slug: contact.slug, description: '', notFoundPage: true });
    renderPanel();
    const dialog = openSettingsFor('About');
    fireEvent.click(within(dialog).getByTestId('page-settings-404'));
    expect(within(dialog).getByText(/It replaces "Contact"/)).toBeTruthy();
  });
});


// "Set as home page" and the undeletable home page in the PAGES list: the
// action on every non-home page (row menu, right-click menu, page settings),
// the explanation shown when someone tries to delete the home page (with a
// chooser for a new one), and the former home page deleting like any page.
// Covers the four stateful paths: forward, changing your mind, resume from a
// saved project, and re-entry after deleting the former home page.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen, within, act } from '@testing-library/react';
import { getSnapshot } from 'mobx-state-tree';
import ProjectModel, { type ProjectModelType } from '@/models/ProjectModel';
import type { PageModelType } from '@/models/PageModel';
import { SiteAddressProvider, type SiteAddress } from '@/contexts/SiteAddressContext';
import PagesPanel from '../PagesPanel';

let project: ProjectModelType;
let home: PageModelType;
let about: PageModelType;
let contact: PageModelType;
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
  home = project.createPage('Home');
  home.setSlug('');
  about = project.createPage('About');
  contact = project.createPage('Contact');
  currentPage = home;
});

afterEach(() => cleanup());

const PUBLISHED: SiteAddress = { host: 'abc123.sites.lumitra.co', everPublished: true };
const DRAFT: SiteAddress = { host: null, everPublished: false };

function renderPanel(address: SiteAddress = PUBLISHED) {
  return render(
    <SiteAddressProvider initial={address}>
      <PagesPanel />
    </SiteAddressProvider>,
  );
}

const deleteButton = (title: string) => screen.getByRole('button', { name: `Delete page ${title}` });

function setHomeFromRowMenu(page: PageModelType) {
  fireEvent.click(screen.getByRole('button', { name: `More actions for ${page.metadata.title}` }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Set as home page' }));
  const dialog = screen.getByTestId('set-home-page-dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Set as home page' }));
}

describe('the action on non-home pages', () => {
  it('is in the row menu and the right-click menu of every page but the home page', () => {
    renderPanel();
    for (const page of [about, contact]) {
      fireEvent.click(screen.getByRole('button', { name: `More actions for ${page.metadata.title}` }));
      expect(screen.getByRole('menuitem', { name: 'Set as home page' })).toBeTruthy();
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
      fireEvent.contextMenu(screen.getByTestId(`page-row-${page.id}`), { clientX: 10, clientY: 10 });
      expect(screen.getByRole('menuitem', { name: 'Set as home page' })).toBeTruthy();
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    }
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Home' }));
    expect(screen.queryByRole('menuitem', { name: 'Set as home page' })).toBeNull();
  });

  it('asks first, saying what will happen; cancel changes nothing', () => {
    renderPanel();
    fireEvent.contextMenu(screen.getByTestId(`page-row-${about.id}`), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Set as home page' }));
    const dialog = screen.getByTestId('set-home-page-dialog');
    const summary = within(dialog).getByTestId('home-change-summary').textContent;
    expect(summary).toContain('“About” will open at the root of your site (abc123.sites.lumitra.co/)');
    expect(summary).toContain('“Home” stays as a normal page at /home-page');
    expect(summary).toContain('Links to /about will lead to the home page after your next publish.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(about.slug).toBe('about');
    expect(home.slug).toBe('');
  });

  it('says nothing about old links before the first publish', () => {
    renderPanel(DRAFT);
    fireEvent.contextMenu(screen.getByTestId(`page-row-${about.id}`), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Set as home page' }));
    const summary = within(screen.getByTestId('set-home-page-dialog')).getByTestId('home-change-summary').textContent;
    expect(summary).toContain('your site address/');
    expect(summary).not.toContain('Links to');
  });

  it('is in page settings, confirmed in place, and the form then shows the page as the home page', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Page settings for About' }));
    const dialog = screen.getByTestId('page-settings-dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set as home page' }));
    const confirm = within(dialog).getByTestId('page-settings-home-confirm');
    expect(within(confirm).getByTestId('home-change-summary').textContent).toContain('“Home” stays as a normal page at /home-page');
    // Keeping the current home page changes nothing.
    fireEvent.click(within(confirm).getByRole('button', { name: 'Keep current home page' }));
    expect(about.slug).toBe('about');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Set as home page' }));
    fireEvent.click(within(within(dialog).getByTestId('page-settings-home-confirm')).getByRole('button', { name: 'Set as home page' }));
    expect(about.slug).toBe('');
    expect(home.slug).toBe('home-page');
    expect(within(dialog).getByLabelText('URL slug')).toHaveProperty('value', '/');
    expect(within(dialog).queryByRole('button', { name: 'Set as home page' })).toBeNull();
    expect(within(dialog).getByTestId('page-settings-announcement').textContent).toBe('About is now the home page.');
    // Saving the rest of the form afterwards keeps the new home page.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(about.slug).toBe('');
  });

  it('Escape in the in-place confirmation cancels only the question', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Page settings for About' }));
    const dialog = screen.getByTestId('page-settings-dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set as home page' }));
    fireEvent.keyDown(within(dialog).getByTestId('page-settings-home-confirm'), { key: 'Escape' });
    expect(within(dialog).queryByTestId('page-settings-home-confirm')).toBeNull();
    expect(screen.getByTestId('page-settings-dialog')).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Set as home page' }));
  });
});

describe('the home page delete control', () => {
  it('is shown looking disabled but stays focusable, and explains itself with a way out', () => {
    renderPanel();
    const x = deleteButton('Home');
    expect(x.hasAttribute('disabled')).toBe(false);
    expect(x.getAttribute('aria-disabled')).toBe('true');
    expect(x.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.getElementById(x.getAttribute('aria-describedby')!)?.textContent).toBe(
      'Not available: this is the home page.',
    );
    x.focus();
    expect(document.activeElement).toBe(x);

    fireEvent.click(x);
    const notice = screen.getByTestId('page-delete-notice');
    expect(notice.getAttribute('role')).toBe('alert');
    expect(notice.textContent).toContain('The home page cannot be deleted. Make another page the home page first.');
    // The notice takes the focus, on its action.
    expect(document.activeElement).toBe(within(notice).getByRole('button', { name: 'Set another page as home' }));
    expect(project.getPage(home.id)).toBeDefined();
  });

  it('the disabled Delete menu item explains itself too', () => {
    renderPanel();
    fireEvent.contextMenu(screen.getByTestId(`page-row-${home.id}`), { clientX: 10, clientY: 10 });
    const item = screen.getByRole('menuitem', { name: 'Delete' });
    expect(item.hasAttribute('disabled')).toBe(false);
    expect(item.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(item);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByTestId('page-delete-notice').textContent).toContain('The home page cannot be deleted.');
  });

  it('the keyboard reaches the disabled menu item with the arrow keys and Enter explains it', () => {
    renderPanel();
    fireEvent.contextMenu(screen.getByTestId(`page-row-${home.id}`), { clientX: 0, clientY: 0 });
    const items = screen.getAllByRole('menuitem');
    fireEvent.keyDown(items[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Delete' }));
  });

  it('Escape and Dismiss close the notice and hand focus back to the delete control', () => {
    renderPanel();
    fireEvent.click(deleteButton('Home'));
    fireEvent.keyDown(screen.getByTestId('page-delete-notice'), { key: 'Escape' });
    expect(screen.queryByTestId('page-delete-notice')).toBeNull();
    expect(document.activeElement).toBe(deleteButton('Home'));

    fireEvent.click(deleteButton('Home'));
    fireEvent.click(within(screen.getByTestId('page-delete-notice')).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('page-delete-notice')).toBeNull();
  });

  it('says a site needs at least one page when it is the only page, with no chooser', () => {
    project.removePage(about.id);
    project.removePage(contact.id);
    renderPanel();
    fireEvent.click(deleteButton('Home'));
    const notice = screen.getByTestId('page-delete-notice');
    expect(notice.textContent).toContain('A site needs at least one page.');
    expect(notice.textContent).not.toContain('home page cannot be deleted');
    expect(within(notice).queryByRole('button', { name: 'Set another page as home' })).toBeNull();
  });

  it('the chooser lists the other pages, explains the selected one, and makes it the home page', () => {
    renderPanel();
    fireEvent.click(deleteButton('Home'));
    fireEvent.click(screen.getByRole('button', { name: 'Set another page as home' }));
    const dialog = screen.getByTestId('set-home-page-dialog');
    const radios = within(dialog).getAllByRole('radio');
    expect(radios.map((r) => (r as HTMLInputElement).value)).toEqual([about.id, contact.id]);
    expect((radios[0] as HTMLInputElement).checked).toBe(true);
    fireEvent.click(radios[1]);
    expect(within(dialog).getByTestId('home-change-summary').textContent).toContain('“Contact” will open at the root');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set as home page' }));

    expect(contact.slug).toBe('');
    expect(home.slug).toBe('home-page');
    // The notice is gone, and the former home page now deletes like any page.
    expect(screen.queryByTestId('page-delete-notice')).toBeNull();
    const x = deleteButton('Home');
    expect(x.hasAttribute('aria-disabled')).toBe(false);
    fireEvent.click(x);
    expect(project.getPage(home.id)).toBeUndefined();
  });
});

describe('stateful paths', () => {
  it('forward: set as home page, then the former home page deletes', () => {
    renderPanel();
    setHomeFromRowMenu(about);
    expect(about.slug).toBe('');
    expect(deleteButton('About').getAttribute('aria-disabled')).toBe('true');
    expect(within(screen.getByTestId(`page-row-${home.id}`)).getByText('/home-page')).toBeTruthy();
    fireEvent.click(deleteButton('Home'));
    expect(project.getPage(home.id)).toBeUndefined();
  });

  it('changing your mind: setting another page as home moves the previous choice back to its own slug', () => {
    renderPanel();
    setHomeFromRowMenu(about);
    setHomeFromRowMenu(contact);
    expect(contact.slug).toBe('');
    expect(about.slug).toBe('about');
    expect(home.slug).toBe('home-page');
    expect(deleteButton('About').hasAttribute('aria-disabled')).toBe(false);
    expect(deleteButton('Contact').getAttribute('aria-disabled')).toBe('true');
    // And back to the original home page.
    setHomeFromRowMenu(home);
    expect(home.slug).toBe('');
    expect(contact.slug).toBe('contact');
  });

  it('resume: after a save and reload the new home page is still home and the old one still deletable', () => {
    renderPanel();
    setHomeFromRowMenu(about);
    cleanup();
    const saved = JSON.parse(JSON.stringify(getSnapshot(project)));
    project = ProjectModel.create(saved);
    currentPage = project.getPage(about.id);
    renderPanel();
    expect(deleteButton('About').getAttribute('aria-disabled')).toBe('true');
    expect(within(screen.getByTestId(`page-row-${home.id}`)).getByText('/home-page')).toBeTruthy();
    fireEvent.click(deleteButton('Home'));
    expect(project.getPage(home.id)).toBeUndefined();
  });

  it('re-entry after deleting: the notice and the chooser work again for the new home page', () => {
    renderPanel();
    setHomeFromRowMenu(about);
    fireEvent.click(deleteButton('Home'));
    expect(project.getPage(home.id)).toBeUndefined();

    fireEvent.click(deleteButton('About'));
    expect(screen.getByTestId('page-delete-notice').textContent).toContain('The home page cannot be deleted.');
    fireEvent.click(screen.getByRole('button', { name: 'Set another page as home' }));
    const dialog = screen.getByTestId('set-home-page-dialog');
    expect(within(dialog).getAllByRole('radio').map((r) => (r as HTMLInputElement).value)).toEqual([contact.id]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Set as home page' }));
    expect(contact.slug).toBe('');
    expect(about.slug).toBe('about');
  });

  it('the notice goes away by itself once its reason is gone (undo elsewhere, a new home page)', () => {
    renderPanel();
    fireEvent.click(deleteButton('Home'));
    expect(screen.getByTestId('page-delete-notice')).toBeTruthy();
    act(() => {
      project.setHomePage(about.id);
    });
    expect(screen.queryByTestId('page-delete-notice')).toBeNull();
  });
});

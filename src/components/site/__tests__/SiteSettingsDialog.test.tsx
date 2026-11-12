// Site settings dialog: opened from the top bar, edits a draft, saves the
// whole object through ProjectModel.updateSiteSettings (one undo step),
// explains invalid input inline and focuses it, keeps empty states honest,
// and starts again from the stored values after Cancel.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen, within } from '@testing-library/react';
import ProjectModel, { type ProjectModelType } from '@/models/ProjectModel';
import HistoryStore from '@/stores/HistoryStore';
import SiteSettingsButton from '../SiteSettingsDialog';
import { addFxLayer, fxFromPreset, setFxParam } from '@/lib/fxScene/edit';
import { FX_PROP } from '@/lib/fxScene/marker';

let project: ProjectModelType | undefined;
const setCurrentPage = vi.fn();

vi.mock('@/hooks/useStore', () => ({
  useStore: () => ({
    editorUI: {
      get currentProject() {
        return project;
      },
      setCurrentPage: (page: unknown) => setCurrentPage(page),
    },
  }),
}));

function makeProject(): ProjectModelType {
  const p = ProjectModel.create({ id: 'site_1', metadata: { title: 'Bakery redesign' }, pages: {} });
  p.createPage('Home').setSlug('');
  return p;
}

beforeEach(() => {
  project = makeProject();
});
afterEach(() => cleanup());

function open() {
  render(<SiteSettingsButton />);
  fireEvent.click(screen.getByRole('button', { name: 'Site settings' }));
  return screen.getByTestId('site-settings-dialog');
}

function field(dialog: HTMLElement, label: string | RegExp) {
  return within(dialog).getByLabelText(label) as HTMLInputElement;
}

/** The error text a field points at through aria-describedby ('' when none). */
function errorOf(dialog: HTMLElement, label: string) {
  const input = field(dialog, label);
  if (input.getAttribute('aria-invalid') !== 'true') return '';
  const id = input.getAttribute('aria-describedby') ?? '';
  return document.getElementById(id)?.textContent ?? '';
}

describe('opening', () => {
  it('renders nothing without a project', () => {
    project = undefined;
    render(<SiteSettingsButton />);
    expect(screen.queryByRole('button', { name: 'Site settings' })).toBeNull();
  });

  it('shows the stored values, with the project name as the site name placeholder', () => {
    project!.updateSiteSettings({ ...project!.site, language: 'de' });
    const dialog = open();
    expect(field(dialog, 'Site name').placeholder).toBe('Bakery redesign');
    expect((within(dialog).getByLabelText('Language') as HTMLSelectElement).value).toBe('de');
    expect(within(dialog).getByText(/About us \| Bakery redesign/)).toBeTruthy();
  });

  it('shows the empty states for opening hours and the 404 page', () => {
    const dialog = open();
    expect(within(dialog).getByTestId('opening-hours-empty')).toBeTruthy();
    expect((within(dialog).getByLabelText('404 page') as HTMLSelectElement).disabled).toBe(true);
    expect(within(dialog).getByText(/Add a page and design it as your 404 page/)).toBeTruthy();
  });
});

describe('saving', () => {
  it('saves a valid form as one undo step and closes', () => {
    const history = HistoryStore.create({});
    history.setTargetStore(project!);
    const dialog = open();
    fireEvent.change(field(dialog, 'Site name'), { target: { value: 'Bäckerei Müller' } });
    fireEvent.change(field(dialog, 'Street and number'), { target: { value: 'Hauptstr. 1' } });
    fireEvent.change(field(dialog, 'Postcode'), { target: { value: '80331' } });
    fireEvent.change(field(dialog, 'City'), { target: { value: 'München' } });
    fireEvent.change(field(dialog, 'Country'), { target: { value: 'de' } });
    fireEvent.change(field(dialog, 'Managing directors'), { target: { value: 'Anna Müller\n\nBen Müller' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Add opening hours/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Monday' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(screen.queryByTestId('site-settings-dialog')).toBeNull();
    expect(project!.site.siteName).toBe('Bäckerei Müller');
    expect(project!.site.business.country).toBe('DE');
    expect(project!.site.business.managingDirectors).toEqual(['Anna Müller', 'Ben Müller']);
    expect(project!.site.business.openingHours).toEqual([{ days: ['Monday'], opens: '09:00', closes: '18:00' }]);
    expect(history.history.length).toBe(1);
  });

  it('refuses invalid input, explains it, focuses the first problem and changes nothing', () => {
    const dialog = open();
    fireEvent.change(field(dialog, 'Favicon'), { target: { value: 'http://insecure.test/icon.png' } });
    fireEvent.change(field(dialog, 'Email'), { target: { value: 'nope' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(screen.getByTestId('site-settings-dialog')).toBeTruthy();
    expect(errorOf(dialog, 'Favicon')).toMatch(/full https:\/\/ address/);
    expect(errorOf(dialog, 'Email')).toMatch(/email address like/);
    expect(document.activeElement).toBe(field(dialog, 'Favicon'));
    expect(screen.getByTestId('site-settings-announcement').textContent).toMatch(/Not saved/);
    expect(project!.site.faviconUrl).toBe('');
  });

  it('shows a field problem once the field is left, not while typing', () => {
    const dialog = open();
    const template = field(dialog, 'Browser title');
    fireEvent.change(template, { target: { value: 'Bakery' } });
    expect(within(dialog).queryByText(/Include %s exactly once/)).toBeNull();
    fireEvent.blur(template);
    expect(within(dialog).getByText(/Include %s exactly once/)).toBeTruthy();
  });

  it('asks for the rest of a half-entered address', () => {
    const dialog = open();
    fireEvent.change(field(dialog, 'Street and number'), { target: { value: 'Hauptstr. 1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(errorOf(dialog, 'Postcode')).toMatch(/Add the postcode/);
    expect(errorOf(dialog, 'City')).toMatch(/Add the city/);
    expect(errorOf(dialog, 'Street and number')).toBe('');
  });

  it('flags an opening-hours row without days, and removes a row', () => {
    const dialog = open();
    fireEvent.click(within(dialog).getByRole('button', { name: /Add opening hours/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(within(dialog).getByText('Pick at least one day.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove row 1' }));
    expect(within(dialog).getByTestId('opening-hours-empty')).toBeTruthy();
  });

  it('accepts another language code under Other and validates it', () => {
    const dialog = open();
    fireEvent.change(within(dialog).getByLabelText('Language'), { target: { value: 'other' } });
    const input = field(dialog, 'Language');
    fireEvent.change(input, { target: { value: 'Portuguese' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(errorOf(dialog, 'Language')).toMatch(/language code like/);
    fireEvent.change(field(dialog, 'Language'), { target: { value: 'pt-BR' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(project!.site.language).toBe('pt-BR');
  });

  it('picks a 404 page from the list', () => {
    const lost = project!.createPage('Lost');
    const dialog = open();
    fireEvent.change(within(dialog).getByLabelText('404 page'), { target: { value: lost.id } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(project!.site.notFoundPageId).toBe(lost.id);
  });
});

describe('page base', () => {
  it('starts on the clean slate and saves browser defaults', () => {
    const dialog = open();
    expect(field(dialog, 'Page base').value).toBe('reset');
    fireEvent.change(field(dialog, 'Page base'), { target: { value: 'browser' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(project!.site.pageBase).toBe('browser');
  });
});

describe('cancel and reopen', () => {
  it('discards the draft on Cancel and starts from the stored values next time', () => {
    let dialog = open();
    fireEvent.change(field(dialog, 'Site name'), { target: { value: 'Draft name' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(project!.site.siteName).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Site settings' }));
    dialog = screen.getByTestId('site-settings-dialog');
    expect(field(dialog, 'Site name').value).toBe('');
  });
});

describe('legal pages and privacy', () => {
  it('creates the Impressum from the saved business data and opens it', () => {
    const dialog = open();
    fireEvent.change(field(dialog, 'Legal name'), { target: { value: 'Bäckerei Müller GmbH' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create Impressum' }));
    const page = project!.pagesArray.find((p) => p.metadata.legalTemplate === 'impressum')!;
    // Site language is en for an older project: English slug, saved draft used.
    expect(page.slug).toBe('imprint');
    expect(project!.site.business.legalName).toBe('Bäckerei Müller GmbH');
    expect(setCurrentPage).toHaveBeenCalledWith(page);
    expect(screen.queryByTestId('site-settings-dialog')).toBeNull();
  });

  it('offers Open once the page exists, and creates nothing on an invalid draft', () => {
    project!.createLegalPage('privacy');
    const dialog = open();
    expect(within(dialog).getByRole('button', { name: /Open privacy policy/ })).toBeTruthy();
    fireEvent.change(field(dialog, 'Email'), { target: { value: 'not-an-email' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create Impressum' }));
    expect(project!.pagesArray.some((p) => p.metadata.legalTemplate === 'impressum')).toBe(false);
  });

  it('adds legal links to footers and reports pages without one', () => {
    const dialog = open();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add legal links to footers' }));
    expect(within(dialog).getByTestId('legal-links-status').textContent).toContain('1 page has no footer.');
  });

  it('states the consent banner status from the analytics setting', () => {
    let dialog = open();
    expect(within(dialog).getByTestId('consent-status').textContent).toContain('Not shown');
    cleanup();
    project!.setLumitraEnabled(true);
    dialog = open();
    expect(within(dialog).getByTestId('consent-status').textContent).toContain('Shown to visitors, because analytics is on');
  });
});

describe('uploaded images an FX scene shows', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('are in use, saved or not: the list offers no delete for a scene\'s picture', async () => {
    const onPage = 'a'.repeat(64);
    const unused = 'b'.repeat(64);
    const withPicture = (sha: string) => {
      const preset = fxFromPreset();
      if (!preset.ok) throw new Error(preset.message);
      const added = addFxLayer(preset.stored, 'image');
      if (!added.ok || !added.layerId) throw new Error('no image layer');
      const edit = setFxParam(added.stored, added.layerId, 'src', `/site-images/${sha}.png`);
      if (!edit.ok) throw new Error(edit.message);
      return edit.stored;
    };
    const box = project!.findPageBySlug('')!.insertRegistryComponent('fxScene', { kind: 'appTree' })!;
    box.setProps({ [FX_PROP]: withPicture(onPage) });

    const item = (sha256: string) => ({ sha256, path: `/site-images/${sha256}.png`, contentType: 'image/png', byteSize: 2048, width: 512, height: 512, inUse: false });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ items: [item(onPage), item(unused)], totalBytes: 4096, maxImages: 100, maxBytes: 50 * 1024 * 1024 }) }) as Response),
    );
    const dialog = open();
    const section = within(dialog).getByTestId('site-image-library-section') as HTMLDetailsElement;
    section.open = true;
    fireEvent(section, new Event('toggle'));
    expect(await within(section).findByText(/2 of 100 images/)).toBeTruthy();
    // The server says neither is in use (nothing is saved yet); the editor knows the scene names one.
    expect(within(section).getAllByText('In use')).toHaveLength(1);
    expect(within(section).getAllByRole('button', { name: /Delete the unused image/ })).toHaveLength(1);
  });
});

// The Theme panel and the token pickers (docs/plans/2026-11-02-theme-and-head.md, slice
// T4), on a real root store, through the four paths: forward, backtrack and revise, resume
// from a saved snapshot, and re-entry after a delete, a forged reference or a refusal.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { applySnapshot, getSnapshot } from 'mobx-state-tree';
import { createRootStore, getHistoryStore, type RootStoreType } from '@/stores/RootStore';
import type { ProjectModelType } from '@/models/ProjectModel';
import type { ComponentInstance } from '@/models/ComponentModel';
import { THEME_LIMITS, tokenReference, type SiteTheme } from '@/lib/site/theme';
import { checkBeforePublish, hasPublishIssues } from '@/lib/legal/publishCheck';

let store: RootStoreType;
vi.mock('@/hooks/useStore', () => ({ useStore: () => store }));

const { ThemeForm } = await import('../ThemePanel');
const { ColorInput } = await import('@/components/sidebars/right/primitives/ColorInput');
const { FontFamilySelect } = await import('@/components/sidebars/right/primitives/FontFamilySelect');

let project: ProjectModelType;
let node: ComponentInstance;
const history = () => getHistoryStore()!;
const theme = () => project.site.theme;
const colour = (name: string) => theme().tokens.find((t) => t.name === name && !t.deleted)!;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  store = createRootStore();
  store.projectStore.createProject('Theme panel');
  project = store.projectStore.findProjectByTitle('Theme panel')!;
  store.editorUI.setCurrentProject(project);
  const page = project.findPageBySlug('')!;
  store.editorUI.setCurrentPage(page);
  history().setTargetStore(store.projectStore);
  node = (page.appComponentTree as ComponentInstance).children[0] as ComponentInstance;
});
afterEach(() => cleanup());

/** Adds a colour through the panel, as a person does. */
function addColour(name: string, value: string) {
  fireEvent.change(screen.getByLabelText('New colour name'), { target: { value: name } });
  const field = screen.getByLabelText('New colour value');
  fireEvent.change(field, { target: { value } });
  fireEvent.blur(field);
  fireEvent.click(screen.getByRole('button', { name: /Add colour/ }));
}

/** The node's own colour field with the token picker, as the Styles section mounts it. */
function NodeColour() {
  const value = (node.props.style as Record<string, unknown> | undefined)?.color;
  return <ColorInput label="" aria-label="Text" tokens value={typeof value === 'string' ? value : '#000000'} onChange={(v) => node.updateResponsiveStyle('color', v)} />;
}

const nodeColour = () => (node.props.style as Record<string, unknown>).color;

describe('forward', () => {
  it('creates a colour, uses it on a node, renames and edits it, and the node keeps its reference', () => {
    render(<ThemeForm project={project} />);
    addColour('Accent', '#112233');
    const accent = colour('Accent');
    expect(accent.kind === 'color' && accent.light).toBe('#112233');

    const field = render(<NodeColour />);
    fireEvent.change(within(field.container).getByLabelText(/site colour/i), { target: { value: accent.id } });
    expect(nodeColour()).toBe(tokenReference(accent.id));
    field.rerender(<NodeColour />);
    expect(within(field.container).getByRole('group', { name: 'Text: Accent' })).toBeTruthy();
    expect(screen.getAllByText('Used in 1 place').length).toBeGreaterThan(0);

    const name = screen.getByLabelText('Name of Accent');
    fireEvent.change(name, { target: { value: 'Brand' } });
    fireEvent.blur(name);
    expect(colour('Brand').id).toBe(accent.id);
    expect(nodeColour()).toBe(tokenReference(accent.id));
    field.rerender(<NodeColour />);
    expect(within(field.container).getByRole('group', { name: 'Text: Brand' })).toBeTruthy();

    const light = screen.getByLabelText('Brand, light');
    fireEvent.change(light, { target: { value: '#445566' } });
    fireEvent.blur(light);
    const edited = colour('Brand');
    expect(edited.kind === 'color' && edited.light).toBe('#445566');
    expect(nodeColour()).toBe(tokenReference(accent.id));
  });

  it('chooses a mode and page defaults, and offers a site font in Typography', () => {
    render(<ThemeForm project={project} />);
    fireEvent.click(screen.getByRole('button', { name: 'System' }));
    expect(theme().mode).toBe('system');
    expect(screen.getByTestId('theme-warnings').textContent).toMatch(/page background/);
    addColour('Ground', '#ffffff');
    fireEvent.change(screen.getByLabelText('Background'), { target: { value: colour('Ground').id } });
    expect(theme().document.backgroundColor).toBe(tokenReference(colour('Ground').id));
    expect(screen.queryByTestId('theme-warnings')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Not chosen' }));
    expect(theme().mode).toBeUndefined();

    fireEvent.change(screen.getByLabelText('New font name'), { target: { value: 'Display' } });
    fireEvent.change(screen.getByLabelText('New font family'), { target: { value: 'fraunces' } });
    fireEvent.click(screen.getByRole('button', { name: /Add font/ }));
    const display = theme().tokens.find((t) => t.name === 'Display')!;
    let picked = '';
    render(<FontFamilySelect tokens value={undefined} onChange={(v) => (picked = v)} aria-label="Node font" />);
    fireEvent.change(screen.getByLabelText('Node font'), { target: { value: tokenReference(display.id) } });
    expect(picked).toBe(tokenReference(display.id));
  });

  it('a drag on a colour picker is one undo step', () => {
    project.updateTheme({ tokens: [{ id: 'ac000001', name: 'Accent', kind: 'color', light: '#000000' }], document: {} });
    render(<ThemeForm project={project} />);
    const steps = history().history.length;
    const row = document.querySelector('[data-token-id="ac000001"]') as HTMLElement;
    const picker = within(row).getAllByLabelText(/color picker/)[0];
    fireEvent.focus(picker);
    for (const value of ['#111111', '#222222', '#333333']) fireEvent.change(picker, { target: { value } });
    fireEvent.blur(picker);
    expect(history().history.length).toBe(steps + 1);
    act(() => history().undo());
    expect(colour('Accent').kind === 'color' && (colour('Accent') as { light: string }).light).toBe('#000000');
  });
});

describe('a colour gesture and other batches', () => {
  it('ends its step when the field unmounts while focused', () => {
    project.updateTheme({ tokens: [{ id: 'ac000001', name: 'Accent', kind: 'color', light: '#000000' }], document: {} });
    const view = render(<ThemeForm project={project} />);
    const row = document.querySelector('[data-token-id="ac000001"]') as HTMLElement;
    const picker = within(row).getAllByLabelText(/color picker/)[0];
    const steps = history().history.length;
    fireEvent.focus(picker);
    fireEvent.change(picker, { target: { value: '#111111' } });
    view.unmount();
    expect(history().batch).toBeUndefined();
    expect(history().history.length).toBe(steps + 1);
    // A later edit is its own step, not part of the colour's.
    node.updateResponsiveStyle('color', '#222222');
    expect(history().history.length).toBe(steps + 2);
  });

  it('never closes a batch another gesture started', () => {
    project.updateTheme({ tokens: [{ id: 'ac000001', name: 'Accent', kind: 'color', light: '#000000' }], document: {} });
    render(<ThemeForm project={project} />);
    const row = document.querySelector('[data-token-id="ac000001"]') as HTMLElement;
    const picker = within(row).getAllByLabelText(/color picker/)[0];
    history().startBatch('Drag');
    fireEvent.focus(picker);
    fireEvent.blur(picker);
    expect(history().batch?.name).toBe('Drag');
    history().commitBatch();
  });
});

describe('backtrack', () => {
  it('Replace points every use at another token in one step, and undo puts each back', () => {
    project.updateTheme({
      tokens: [
        { id: 'aa000001', name: 'Old', kind: 'color', light: '#111111' },
        { id: 'bb000002', name: 'New', kind: 'color', light: '#222222' },
      ],
      document: { color: tokenReference('aa000001') },
    });
    node.updateResponsiveStyle('color', tokenReference('aa000001'));
    node.setProps({ rules: [{ id: 'r', selector: '&:hover', style: { borderColor: `1px solid ${tokenReference('aa000001')}` } }] });
    render(<ThemeForm project={project} />);
    expect(screen.getAllByText('Used in 3 places').length).toBe(1);
    const steps = history().history.length;
    fireEvent.change(screen.getByLabelText('Replace Old everywhere with'), { target: { value: 'bb000002' } });
    expect(history().history.length).toBe(steps + 1);
    expect(nodeColour()).toBe(tokenReference('bb000002'));
    expect(JSON.stringify(node.props.rules)).toContain('bb000002');
    expect(theme().document.color).toBe(tokenReference('bb000002'));
    act(() => history().undo());
    expect(nodeColour()).toBe(tokenReference('aa000001'));
    expect(JSON.stringify(node.props.rules)).toContain('aa000001');
    expect(theme().document.color).toBe(tokenReference('aa000001'));
  });

  it('undo walks back a rename, a delete and an add, one step each', () => {
    render(<ThemeForm project={project} />);
    addColour('Accent', '#112233');
    const id = colour('Accent').id;
    const name = screen.getByLabelText('Name of Accent');
    fireEvent.change(name, { target: { value: 'Brand' } });
    fireEvent.blur(name);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Brand' }));
    expect(theme().tokens.find((t) => t.id === id)?.deleted).toBe(true);
    act(() => history().undo());
    expect(theme().tokens.find((t) => t.id === id)?.deleted).toBeUndefined();
    act(() => history().undo());
    expect(theme().tokens.find((t) => t.id === id)?.name).toBe('Accent');
    act(() => history().undo());
    expect(theme().tokens.find((t) => t.id === id)).toBeUndefined();
  });
});

describe('resume', () => {
  it('a saved project reopens with its tokens and every reference', () => {
    project.updateTheme({ mode: 'dark', tokens: [{ id: 'ac000001', name: 'Accent', kind: 'color', light: '#111111', dark: '#eeeeee' }], document: { color: tokenReference('ac000001') } });
    node.updateResponsiveStyle('color', tokenReference('ac000001'));
    const saved = JSON.parse(JSON.stringify(getSnapshot(project)));
    store = createRootStore();
    store.projectStore.createProject('Reopened');
    const reopened = store.projectStore.findProjectByTitle('Reopened')!;
    applySnapshot(reopened, { ...saved, id: reopened.id });
    store.editorUI.setCurrentProject(reopened);
    expect(reopened.site.theme).toEqual(project.site.theme);
    render(<ThemeForm project={reopened} />);
    expect(screen.getByLabelText('Name of Accent')).toBeTruthy();
    expect(screen.getByText('Used in 2 places')).toBeTruthy();
  });
});

describe('re-entry', () => {
  it('a deleted colour keeps showing, its uses offer Detach, and re-creating the name makes a new id', () => {
    render(<ThemeForm project={project} />);
    addColour('Accent', '#112233');
    const id = colour('Accent').id;
    node.updateResponsiveStyle('color', tokenReference(id));
    fireEvent.click(screen.getByRole('button', { name: 'Delete Accent' }));
    expect(screen.getByTestId('theme-tombstone').textContent).toMatch(/Accent/);
    const field = render(<NodeColour />);
    expect(within(field.container).getByText('Deleted colour: Accent')).toBeTruthy();

    addColour('Accent', '#998877');
    const again = colour('Accent');
    expect(again.id).not.toBe(id);
    const tombstone = theme().tokens.find((t) => t.id === id)!;
    expect(tombstone.deleted).toBe(true);
    expect(tombstone.kind === 'color' && tombstone.light).toBe('#112233');

    fireEvent.click(within(field.container).getByRole('button', { name: 'Detach' }));
    expect(nodeColour()).toBe('#112233');
  });

  it('Clean up removes only unused tombstones and says what it did not scan', () => {
    project.updateTheme({
      tokens: [
        { id: 'aa000001', name: 'Used', kind: 'color', light: '#111111', deleted: true },
        { id: 'bb000002', name: 'Unused', kind: 'color', light: '#222222', deleted: true },
        { id: 'cc000003', name: 'Page', kind: 'color', light: '#333333', deleted: true },
      ],
      document: {},
    });
    // A tombstone may stay in the document block: it still resolves.
    project.updateTheme({ ...theme(), document: {} });
    node.updateResponsiveStyle('color', tokenReference('aa000001'));
    render(<ThemeForm project={project} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clean up unused' }));
    expect(theme().tokens.map((t) => t.id).sort()).toEqual(['aa000001']);
    expect(screen.getByRole('status').textContent).toMatch(/content collections were not scanned/);
    fireEvent.click(screen.getByRole('button', { name: 'Clean up unused' }));
    expect(screen.getByRole('status').textContent).toMatch(/nothing was removed/);
  });

  it('deleting the last token works, and a delete past the tombstone cap is refused with the way out', () => {
    project.updateTheme({ tokens: [{ id: 'aa000001', name: 'Only', kind: 'color', light: '#111111' }], document: {} });
    render(<ThemeForm project={project} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Only' }));
    expect(theme().tokens).toHaveLength(1);
    cleanup();
    const full: SiteTheme = {
      tokens: [
        ...Array.from({ length: THEME_LIMITS.tombstones }, (_, i) => ({ id: `t${String(i).padStart(7, '0')}`, name: `Old ${i}`, kind: 'color' as const, light: '#000000', deleted: true as const })),
        { id: 'zz000001', name: 'Live', kind: 'color', light: '#ffffff' },
      ],
      document: {},
    };
    store.projectStore.createProject('Full');
    const other = store.projectStore.findProjectByTitle('Full')!;
    expect(other.updateTheme(full).ok).toBe(true);
    project = other;
    render(<ThemeForm project={other} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Live' }));
    expect(screen.getByRole('status').textContent).toMatch(/Detach or Replace/);
    expect(other.site.theme.tokens.find((t) => t.id === 'zz000001')?.deleted).toBeUndefined();
  });

  it('a forged dangling reference shows Missing, and the publish check names its page', () => {
    node.updateResponsiveStyle('color', tokenReference('ghost001'));
    const field = render(<NodeColour />);
    expect(within(field.container).getByText('Missing colour')).toBeTruthy();
    const page = project.findPageBySlug('')!;
    const check = checkBeforePublish(
      project.site.business,
      [{ id: page.id, slug: page.slug, metadata: { title: page.metadata.title }, snapshot: getSnapshot(page) as never }],
      { definitions: project.definitions, refused: [] },
      project.site.theme,
    );
    expect(check.tokens).toHaveLength(1);
    expect(check.tokens![0].message).toMatch(/no longer exists/);
    expect(hasPublishIssues(check)).toBe(true);
  });

  it('a refused name says why and changes nothing', () => {
    render(<ThemeForm project={project} />);
    addColour('Accent', '#112233');
    addColour('accent', '#445566');
    expect(screen.getByRole('status').textContent).toMatch(/already called/);
    expect(theme().tokens).toHaveLength(1);
  });
});

/** Stores a theme as a saved row would hold it, past the write checks (a value no build accepts now). */
function storeTheme(raw: unknown) {
  const saved = getSnapshot(project) as unknown as { siteSettings: Record<string, unknown> };
  applySnapshot(project, { ...(saved as object), siteSettings: { ...saved.siteSettings, theme: raw } } as never);
  node = (project.findPageBySlug('')!.appComponentTree as ComponentInstance).children[0] as ComponentInstance;
}

describe('a reference that shows nothing still leads back to a plain colour', () => {
  it('a missing colour with no live colours offers Detach, which writes #000000', () => {
    node.updateResponsiveStyle('color', tokenReference('ghost001'));
    const field = render(<NodeColour />);
    expect(within(field.container).queryByLabelText(/site colour/i)).toBeNull();
    fireEvent.click(within(field.container).getByRole('button', { name: 'Detach' }));
    expect(nodeColour()).toBe('#000000');
  });

  it('a missing colour beside live colours goes back through Other too', () => {
    project.updateTheme({ tokens: [{ id: 'ac000001', name: 'Accent', kind: 'color', light: '#112233' }], document: {} });
    node.updateResponsiveStyle('color', tokenReference('ghost001'));
    const field = render(<NodeColour />);
    fireEvent.change(within(field.container).getByLabelText(/site colour/i), { target: { value: '' } });
    expect(nodeColour()).toBe('#000000');
  });

  it('Other on a live colour writes the value it shows', () => {
    project.updateTheme({ tokens: [{ id: 'ac000001', name: 'Accent', kind: 'color', light: '#112233' }], document: {} });
    node.updateResponsiveStyle('color', tokenReference('ac000001'));
    const field = render(<NodeColour />);
    fireEvent.change(within(field.container).getByLabelText(/site colour/i), { target: { value: '' } });
    expect(nodeColour()).toBe('#112233');
  });

  it('a colour whose light value does not read detaches to its dark value in the light editor', () => {
    storeTheme({ tokens: [{ id: 'll000001', name: 'Dark only', kind: 'color', light: 'url(x)', dark: '#445566' }], document: {} });
    node.updateResponsiveStyle('color', tokenReference('ll000001'));
    const field = render(<NodeColour />);
    fireEvent.click(within(field.container).getByRole('button', { name: 'Detach' }));
    expect(nodeColour()).toBe('#445566');
  });

  it('a colour with no readable value shows Broken, and Detach writes #000000', () => {
    storeTheme({ tokens: [{ id: 'bb000001', name: 'Bad', kind: 'color', light: 'url(x)' }], document: {} });
    node.updateResponsiveStyle('color', tokenReference('bb000001'));
    const field = render(<NodeColour />);
    expect(within(field.container).getByText('Broken colour: Bad')).toBeTruthy();
    fireEvent.click(within(field.container).getByRole('button', { name: 'Detach' }));
    expect(nodeColour()).toBe('#000000');
  });
});

describe('a colour whose dark value cannot be read', () => {
  it('is not called broken, and the publish check says the light value shows in both', () => {
    storeTheme({ tokens: [{ id: 'pp000001', name: 'Half', kind: 'color', light: '#112233', dark: 'url(x)' }], document: {} });
    node.updateResponsiveStyle('color', tokenReference('pp000001'));
    const field = render(<NodeColour />);
    expect(within(field.container).getByRole('group', { name: 'Text: Half' })).toBeTruthy();
    render(<ThemeForm project={project} />);
    expect(screen.getByText(/dark value cannot be read, so the light value shows in both/)).toBeTruthy();
    const page = project.findPageBySlug('')!;
    const check = checkBeforePublish(
      project.site.business,
      [{ id: page.id, slug: page.slug, metadata: { title: page.metadata.title }, snapshot: getSnapshot(page) as never }],
      { definitions: project.definitions, refused: [] },
      project.site.theme,
    );
    expect(check.tokens![0].message).toMatch(/Half: its dark value cannot be read, so the light value shows in both/);
    expect(check.tokens![0].message).not.toMatch(/shows nothing/);
  });
});

describe('a colour picker opens its undo step on the first change, not on focus', () => {
  it('focus alone holds no batch, so another edit is its own step', () => {
    project.updateTheme({ tokens: [{ id: 'ac000001', name: 'Accent', kind: 'color', light: '#000000' }], document: {} });
    render(<ThemeForm project={project} />);
    const row = document.querySelector('[data-token-id="ac000001"]') as HTMLElement;
    const picker = within(row).getAllByLabelText(/color picker/)[0];
    const steps = history().history.length;
    fireEvent.focus(picker);
    expect(history().batch).toBeUndefined();
    node.updateResponsiveStyle('color', '#222222');
    expect(history().history.length).toBe(steps + 1);
    fireEvent.change(picker, { target: { value: '#111111' } });
    expect(history().batch?.name).toBe('Colour');
    fireEvent.blur(picker);
    expect(history().batch).toBeUndefined();
    expect(history().history.length).toBe(steps + 2);
  });
});

describe('Replace of a reference whose token is gone', () => {
  it('refuses a font for a colour use, and takes a colour', () => {
    project.updateTheme({
      tokens: [
        { id: 'ac000001', name: 'Accent', kind: 'color', light: '#112233' },
        { id: 'fo000001', name: 'Display', kind: 'font', family: 'system' },
      ],
      document: {},
    });
    node.updateResponsiveStyle('color', tokenReference('ghost001'));
    const refused = project.replaceToken('ghost001', 'fo000001');
    expect(refused.ok).toBe(false);
    expect(nodeColour()).toBe(tokenReference('ghost001'));
    expect(project.replaceToken('ghost001', 'ac000001').ok).toBe(true);
    expect(nodeColour()).toBe(tokenReference('ac000001'));
  });

  it('refuses a colour for a font use', () => {
    project.updateTheme({ tokens: [{ id: 'ac000001', name: 'Accent', kind: 'color', light: '#112233' }], document: {} });
    node.updateResponsiveStyle('fontFamily', tokenReference('ghost002'));
    expect(project.replaceToken('ghost002', 'ac000001').ok).toBe(false);
    expect((node.props.style as Record<string, unknown>).fontFamily).toBe(tokenReference('ghost002'));
  });
});

describe('a token name', () => {
  it('takes no more characters than the theme allows', () => {
    project.updateTheme({ tokens: [{ id: 'ac000001', name: 'Accent', kind: 'color', light: '#112233' }], document: {} });
    render(<ThemeForm project={project} />);
    expect((screen.getByLabelText('Name of Accent') as HTMLInputElement).maxLength).toBe(THEME_LIMITS.name);
  });
});

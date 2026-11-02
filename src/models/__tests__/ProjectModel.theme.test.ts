// The site theme on the model (contract docs/plans/2026-11-02-theme-and-head.md, slice
// T1), over the four paths: forward (add, rename, set dark, delete), backtrack (undo,
// a rename that touches no page, modes there and back), resume (a snapshot round trip)
// and re-entry (Clean up, the caps, and the dialog that must not erase a token edit).

import { describe, expect, it } from 'vitest';
import { getSnapshot } from 'mobx-state-tree';
import ProjectModel, { type ProjectModelType } from '../ProjectModel';
import HistoryStore from '@/stores/HistoryStore';
import {
  EMPTY_THEME,
  THEME_LIMITS,
  TOMBSTONE_CAP_MESSAGE,
  addColorToken,
  cleanUpUnused,
  deleteToken,
  renameToken,
  setColorValues,
  setDocumentStyle,
  setThemeMode,
  themeCss,
  tokenReference,
  tokenUsage,
  type SiteTheme,
} from '@/lib/site/theme';

function setup(snapshotExtra: Record<string, unknown> = {}) {
  const project = ProjectModel.create({ id: 'proj', metadata: { title: 'Bakery' }, pages: {}, ...snapshotExtra });
  const home = project.createPage('Home');
  home.setSlug('');
  const history = HistoryStore.create({});
  history.setTargetStore(project);
  history.clear();
  return { project, home, history };
}

function must<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result as Extract<T, { ok: true }>;
}

/** A theme with one colour, named Accent, with a dark value. */
function withAccent(project: ProjectModelType): string {
  const added = must(addColorToken(project.site.theme, { name: 'Accent', light: '#ff0000', dark: '#ff8888' }));
  must(project.updateTheme(added.theme));
  return added.id!;
}

const pagesOf = (project: ProjectModelType) => JSON.stringify(getSnapshot(project).pages);

describe('forward', () => {
  it('an older project with no theme reads as empty, with no mode chosen', () => {
    const { project } = setup();
    expect(project.site.theme).toEqual(EMPTY_THEME);
    expect(themeCss(project.site.theme)).toBe('');
  });

  it('add, rename, set dark and delete each land, and the sheet says so', () => {
    const { project } = setup();
    const id = withAccent(project);
    expect(themeCss(project.site.theme)).toBe(`:root{--fc-t-${id}:#ff0000}`);
    must(project.updateTheme(must(renameToken(project.site.theme, id, 'Brand')).theme));
    expect(project.site.theme.tokens[0].name).toBe('Brand');
    must(project.updateTheme(setThemeMode(must(setColorValues(project.site.theme, id, { dark: '#00ff00' })).theme, 'system')));
    expect(themeCss(project.site.theme)).toContain(`@media (prefers-color-scheme:dark){:root{--fc-t-${id}:#00ff00}}`);
    must(project.updateTheme(must(deleteToken(project.site.theme, id)).theme));
    expect(project.site.theme.tokens[0]).toMatchObject({ id, deleted: true, light: '#ff0000', dark: '#00ff00' });
    expect(themeCss(project.site.theme)).toContain(`--fc-t-${id}:#ff0000`);
  });

  it('refuses a bad write whole and changes nothing', () => {
    const { project, history } = setup();
    withAccent(project);
    history.clear();
    const before = JSON.stringify(project.siteSettings);
    const bad: SiteTheme = { ...project.site.theme, tokens: [...project.site.theme.tokens, { id: 'zz11zz11', name: 'accent', kind: 'color', light: 'red;' }] };
    const result = project.updateTheme(bad);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(project.siteSettings)).toBe(before);
    expect(history.history.length).toBe(0);
  });
});

describe('backtrack', () => {
  it('each edit is one undo step, and undo restores a tombstone with its values', () => {
    const { project, history } = setup();
    const id = withAccent(project);
    const live = JSON.stringify(project.site.theme);
    history.clear();
    must(project.updateTheme(must(deleteToken(project.site.theme, id)).theme));
    expect(history.history.length).toBe(1);
    history.undo();
    expect(JSON.stringify(project.site.theme)).toBe(live);
    history.redo();
    expect(project.site.theme.tokens[0]).toMatchObject({ deleted: true, light: '#ff0000', dark: '#ff8888' });
  });

  it('a rename changes one field and no page byte', () => {
    const { project, home } = setup();
    const id = withAccent(project);
    home.appComponentTree.updateResponsiveStyle('color', tokenReference(id));
    const pages = pagesOf(project);
    must(project.updateTheme(must(renameToken(project.site.theme, id, 'Brand')).theme));
    expect(pagesOf(project)).toBe(pages);
  });

  it('system, light, system keeps every dark value, and clearing mode returns to not chosen', () => {
    const { project } = setup();
    withAccent(project);
    for (const mode of ['system', 'light', 'system'] as const) must(project.updateTheme(setThemeMode(project.site.theme, mode)));
    expect(project.site.theme.tokens[0]).toMatchObject({ dark: '#ff8888' });
    expect(project.site.theme.mode).toBe('system');
    must(project.updateTheme(setThemeMode(project.site.theme, undefined)));
    expect('mode' in project.site.theme).toBe(false);
  });

  it('records no history when nothing changed', () => {
    const { project, history } = setup();
    withAccent(project);
    history.clear();
    must(project.updateTheme(project.site.theme));
    expect(history.history.length).toBe(0);
  });
});

describe('resume', () => {
  it('a theme survives a snapshot round trip unchanged, broken values included', () => {
    const { project } = setup({
      siteSettings: {
        theme: {
          mode: 'dark',
          tokens: [
            { id: 'ab12cd34', name: 'Ink', kind: 'color', light: '#111111', dark: '#eeeeee' },
            { id: 'cd34ef56', name: 'Odd', kind: 'color', light: 'color-mix(in srgb, red, blue)' },
            { id: 'ef56ab12', name: 'Gone', kind: 'font', family: 'retired-family' },
          ],
          document: { color: 'var(--fc-t-ab12cd34)' },
        },
      },
    });
    const again = ProjectModel.create(getSnapshot(project));
    expect(again.site.theme).toEqual(project.site.theme);
    expect(again.site.theme.tokens[1]).toMatchObject({ broken: true, light: 'color-mix(in srgb, red, blue)' });
  });

  it('a broken value survives an unrelated edit and the save after it', () => {
    const { project } = setup({ siteSettings: { theme: { tokens: [{ id: 'cd34ef56', name: 'Odd', kind: 'color', light: 'bad;' }], document: {} } } });
    must(project.updateTheme(must(addColorToken(project.site.theme, { name: 'New', light: '#000' })).theme));
    const again = ProjectModel.create(getSnapshot(project));
    expect(again.site.theme.tokens[0]).toEqual({ id: 'cd34ef56', name: 'Odd', kind: 'color', light: 'bad;', broken: true });
  });
});

describe('re-entry', () => {
  it('Clean up removes only what the scan finds unused, and a token used only as the page background stays', () => {
    const { project, home } = setup();
    const used = withAccent(project);
    let theme = must(addColorToken(project.site.theme, { name: 'Paper', light: '#fff' }));
    const paper = theme.id!;
    theme = must(addColorToken(theme.theme, { name: 'Spare', light: '#ccc' }));
    const spare = theme.id!;
    must(project.updateTheme(must(setDocumentStyle(theme.theme, 'backgroundColor', tokenReference(paper))).theme));
    home.appComponentTree.updateResponsiveStyle('color', tokenReference(used));
    let next = project.site.theme;
    for (const id of [used, paper, spare]) next = must(deleteToken(next, id)).theme;
    must(project.updateTheme(next));
    const { theme: cleaned, removed } = cleanUpUnused(project.site.theme, tokenUsage(getSnapshot(project)));
    expect(removed.map((t) => t.id)).toEqual([spare]);
    must(project.updateTheme(cleaned));
    expect(project.site.theme.tokens.map((t) => t.id)).toEqual([used, paper]);
  });

  it('the 500th tombstone refuses a further delete, pointing at Detach, Replace and Clean up', () => {
    const tokens = Array.from({ length: THEME_LIMITS.tombstones }, (_, i) => ({
      id: `b${String(i).padStart(7, '0')}`, name: `t${i}`, kind: 'color' as const, light: '#fff', deleted: true as const,
    }));
    const { project } = setup({ siteSettings: { theme: { tokens, document: {} } } });
    const id = withAccent(project);
    expect(deleteToken(project.site.theme, id)).toEqual({ ok: false, error: TOMBSTONE_CAP_MESSAGE });
    const forced = { ...project.site.theme, tokens: project.site.theme.tokens.map((t) => (t.id === id ? { ...t, deleted: true as const } : t)) };
    expect(project.updateTheme(forced)).toEqual({ ok: false, errors: [TOMBSTONE_CAP_MESSAGE] });
  });

  it('a stored blob over the cap loads whole', () => {
    const tokens = Array.from({ length: THEME_LIMITS.liveTokens + 5 }, (_, i) => ({ id: `a${String(i).padStart(7, '0')}`, name: `t${i}`, kind: 'color', light: '#000' }));
    const { project } = setup({ siteSettings: { theme: { tokens, document: {} } } });
    expect(project.site.theme.tokens).toHaveLength(THEME_LIMITS.liveTokens + 5);
    expect(addColorToken(project.site.theme, { name: 'One more', light: '#fff' }).ok).toBe(false);
  });

  it('a Site settings dialog opened before a token edit and saved after it keeps the edit', () => {
    const { project } = setup();
    const draft = project.site; // the dialog's draft, taken when it opened
    const id = withAccent(project);
    expect(project.updateSiteSettings({ ...draft, siteName: 'Müller' })).toEqual({ ok: true });
    expect(project.site.siteName).toBe('Müller');
    expect(project.site.theme.tokens.map((t) => t.id)).toEqual([id]);
  });

  it('the dialog cannot write the theme or the head items, even when it sends them', () => {
    const { project } = setup();
    withAccent(project);
    const theme = project.site.theme;
    expect(project.updateSiteSettings({ ...project.site, theme: EMPTY_THEME, head: [{ kind: 'meta', name: 'author', content: 'x' }] })).toEqual({ ok: true });
    expect(project.site.theme).toEqual(theme);
    expect(project.site.head).toEqual([]);
  });

  it('a deleted name can be taken again, by a new id, leaving the tombstone untouched', () => {
    const { project } = setup();
    const id = withAccent(project);
    must(project.updateTheme(must(deleteToken(project.site.theme, id)).theme));
    const again = must(addColorToken(project.site.theme, { name: 'Accent', light: '#000' }));
    must(project.updateTheme(again.theme));
    expect(again.id).not.toBe(id);
    expect(project.site.theme.tokens[0]).toMatchObject({ id, deleted: true, light: '#ff0000' });
  });
});

'use client';

// src/components/site/ThemePanel.tsx
//
// The Theme panel (docs/plans/2026-11-02-theme-and-head.md, slice T4): a site's shared
// colours and fonts, its colour mode and the page defaults, opened from the top bar.
//
// Every control writes at once through ProjectModel.updateTheme, ONE action, so each
// edit is one undo step and the canvas repaints behind the dialog; a drag on a colour
// picker is one step too (ColorInput). A refused write changes nothing and says why in
// the live region. Rename touches one field and no node. Delete keeps the token as a
// tombstone, still in the sheet, so no page changes; its uses show "Deleted colour"
// with Detach, Replace points them at another token in one step, and Clean up unused
// removes the tombstones no page, definition or page default uses. Content collection
// values are not scanned, and the panel says so.

import React from 'react';
import { observer } from 'mobx-react-lite';
import { getSnapshot } from 'mobx-state-tree';
import { Palette, Plus, Trash2 } from 'lucide-react';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useStore } from '@/hooks/useStore';
import { useControllableOpen, type ControllableOpenProps } from '@/hooks/useControllableOpen';
import type { ProjectModelType } from '@/models/ProjectModel';
import { ColorInput } from '@/components/sidebars/right/primitives/ColorInput';
import { FONT_CATEGORIES, FONT_LIBRARY } from '@/lib/fonts/registry';
import {
  THEME_LIMITS,
  THEME_MODES,
  colorPartialProblem,
  addColorToken,
  addFontToken,
  cleanUpUnused,
  deleteToken,
  holdsColorSchemeRule,
  liveTokens,
  parseTokenReference,
  renameToken,
  setColorValues,
  setDocumentStyle,
  setFontFamily,
  setThemeMode,
  themeWarnings,
  tokenReference,
  tokenUsage,
  tombstones,
  type DocumentKey,
  type SiteTheme,
  type ThemeEdit,
  type ThemeMode,
  type ThemeToken,
} from '@/lib/site/theme';

const sectionTitle = 'text-[13px] font-semibold text-foreground';
const hint = 'text-[11px] text-muted-foreground';
const control =
  'h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40';

const MODE_LABEL: Record<ThemeMode | 'none', string> = { none: 'Not chosen', system: 'System', light: 'Light', dark: 'Dark' };
const MODE_HINT: Record<ThemeMode | 'none', string> = {
  none: 'Light colours, and nothing about dark mode is decided. Elements with dark mode styles follow each visitor\'s system.',
  system: 'Each visitor sees light or dark, following their system. The top bar switches which one the editor shows.',
  light: 'Always light, whatever the visitor\'s system. Dark mode styles never apply.',
  dark: 'Always dark, whatever the visitor\'s system. Dark values apply everywhere.',
};

const DOCUMENT_ROWS: { key: DocumentKey; label: string; kind: 'color' | 'font' }[] = [
  { key: 'backgroundColor', label: 'Background', kind: 'color' },
  { key: 'color', label: 'Text', kind: 'color' },
  { key: 'fontFamily', label: 'Font', kind: 'font' },
];

/** Where the panel reads the project: its theme, how often each token is used, and what it warns about. */
function useThemeState(project: ProjectModelType) {
  const theme = project.site.theme;
  // A deep read of the snapshot: references are strings wherever they sit.
  const snapshot = getSnapshot(project);
  // A colour drag rerenders on every change. Snapshots share structure, so the page and
  // component references stay the same through a theme-only edit and the walks are skipped.
  // The document is normalized into a new object on each read, so it is keyed by value.
  const themeDocument = theme.document;
  const documentKey = JSON.stringify(themeDocument);
  const usage = React.useMemo(
    () => tokenUsage({ pages: snapshot.pages, components: snapshot.components, document: themeDocument }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- themeDocument is keyed by value (documentKey)
    [snapshot.pages, snapshot.components, documentKey],
  );
  const holdsDarkRules = React.useMemo(
    () => holdsColorSchemeRule(snapshot.pages) || holdsColorSchemeRule(snapshot.components),
    [snapshot.pages, snapshot.components],
  );
  const pages = project.pagesArray.map((page) => ({
    title: page.metadata.title,
    rootRules: (page.appComponentTree?.props as { rules?: unknown } | undefined)?.rules,
  }));
  const warnings = themeWarnings(theme, { holdsDarkRules, pages });
  return { theme, usage, warnings };
}

function usedText(count: number): string {
  return count === 0 ? 'Not used' : `Used in ${count} ${count === 1 ? 'place' : 'places'}`;
}

interface RowProps {
  token: ThemeToken;
  theme: SiteTheme;
  count: number;
  apply: (edit: ThemeEdit | SiteTheme) => void;
  replace: (fromId: string, toId: string) => void;
}

/** A token's name, committed on Enter or when the field is left. */
function NameField({ token, apply, theme }: Pick<RowProps, 'token' | 'apply' | 'theme'>) {
  const [draft, setDraft] = React.useState(token.name);
  React.useEffect(() => setDraft(token.name), [token.name]);
  const commit = () => {
    if (draft.trim() === token.name) return setDraft(token.name);
    apply(renameToken(theme, token.id, draft));
  };
  return (
    <input
      aria-label={`Name of ${token.name || 'this token'}`}
      value={draft}
      maxLength={THEME_LIMITS.name}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') setDraft(token.name);
      }}
      className={`${control} min-w-0 flex-1 font-medium`}
    />
  );
}

/** Replace every use of this token with another live one of its kind, in one undo step. */
function ReplaceSelect({ token, theme, count, replace }: Pick<RowProps, 'token' | 'theme' | 'count' | 'replace'>) {
  const others = liveTokens(theme).filter((t) => t.kind === token.kind && t.id !== token.id);
  if (count === 0 || others.length === 0) return null;
  return (
    <select
      aria-label={`Replace ${token.name || 'this token'} everywhere with`}
      value=""
      onChange={(e) => e.target.value && replace(token.id, e.target.value)}
      className={`${control} w-auto max-w-[140px] cursor-pointer`}
    >
      <option value="">Replace with</option>
      {others.map((t) => (
        <option key={t.id} value={t.id}>
          {t.name}
        </option>
      ))}
    </select>
  );
}

function FamilySelect({ value, onChange, label }: { value: string; onChange: (family: string) => void; label: string }) {
  const known = value === 'system' || FONT_LIBRARY.some((f) => f.id === value);
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className={`${control} min-w-0 flex-1 cursor-pointer`}>
      {!known && <option value={value}>{`Not in the library: ${value || 'none'}`}</option>}
      <option value="system">System fonts</option>
      {FONT_CATEGORIES.map((cat) => {
        const families = FONT_LIBRARY.filter((f) => f.category === cat.id);
        return families.length === 0 ? null : (
          <optgroup key={cat.id} label={cat.label}>
            {families.map((f) => (
              <option key={f.id} value={f.id}>
                {f.displayName}
              </option>
            ))}
          </optgroup>
        );
      })}
    </select>
  );
}

const TokenRow = observer(({ token, theme, count, apply, replace }: RowProps) => {
  const name = token.name || 'unnamed';
  const partialProblem = colorPartialProblem(token);
  const storedText = token.kind === 'color' ? `${token.light || 'empty'}${token.dark !== undefined ? `, dark ${token.dark || 'empty'}` : ''}` : '';
  return (
    <li className="flex flex-col gap-1.5 rounded-md border border-border p-2" data-token-id={token.id} data-testid="theme-token">
      <div className="flex items-center gap-1.5">
        <NameField token={token} apply={apply} theme={theme} />
        <span className={`${hint} flex-none`}>{usedText(count)}</span>
        <button
          type="button"
          aria-label={`Delete ${name}`}
          title="Delete: pages keep showing it until you replace or detach each use"
          onClick={() => apply(deleteToken(theme, token.id))}
          className="flex h-8 w-8 flex-none items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Trash2 size={14} />
        </button>
      </div>
      {token.kind === 'color' ? (
        <>
          {token.broken && (
            <p className="text-[11px] text-destructive">
              {partialProblem
                ? `This colour holds a value that cannot be read (${storedText}): ${partialProblem}. Set a new value.`
                : `This colour holds no value that can be read (${storedText}), so it shows nothing. Set a new value.`}
            </p>
          )}
          <div className="grid grid-cols-2 gap-1.5">
            <div className="flex min-w-0 flex-col gap-1">
              <span className={hint} aria-hidden>Light</span>
              <ColorInput label="" aria-label={`${name}, light`} value={token.light} onChange={(v) => apply(setColorValues(theme, token.id, { light: v }))} />
            </div>
            {token.dark !== undefined ? (
              <div className="flex min-w-0 flex-col gap-1">
                <span className={hint} aria-hidden>Dark</span>
                <ColorInput label="" aria-label={`${name}, dark`} value={token.dark} onChange={(v) => apply(setColorValues(theme, token.id, { dark: v }))} />
              </div>
            ) : (
              <div className="flex flex-col justify-end">
                <Button type="button" variant="outline" size="sm" onClick={() => apply(setColorValues(theme, token.id, { dark: token.light }))}>
                  Add a dark value
                </Button>
              </div>
            )}
          </div>
          {token.dark !== undefined && (
            <button type="button" className={`${hint} self-start underline-offset-2 hover:underline`} onClick={() => apply(setColorValues(theme, token.id, { dark: null }))}>
              Use the light value in dark mode too
            </button>
          )}
        </>
      ) : (
        <FamilySelect label={`Font of ${name}`} value={token.family} onChange={(family) => apply(setFontFamily(theme, token.id, family))} />
      )}
      <ReplaceSelect token={token} theme={theme} count={count} replace={replace} />
    </li>
  );
});
TokenRow.displayName = 'TokenRow';

/** Add a colour or a font: a name and a value, then Add. */
function AddToken({ theme, apply, kind }: { theme: SiteTheme; apply: RowProps['apply']; kind: 'color' | 'font' }) {
  const [name, setName] = React.useState('');
  const [value, setValue] = React.useState(kind === 'color' ? '#1a2b3c' : 'system');
  const add = () => {
    const edit = kind === 'color' ? addColorToken(theme, { name, light: value }) : addFontToken(theme, { name, family: value });
    apply(edit);
    if (edit.ok) setName('');
  };
  const label = kind === 'color' ? 'colour' : 'font';
  return (
    <form
      className="flex flex-wrap items-end gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        add();
      }}
    >
      <input aria-label={`New ${label} name`} placeholder={`New ${label} name`} value={name} onChange={(e) => setName(e.target.value)} className={`${control} min-w-[120px] flex-1`} />
      {kind === 'color' ? (
        <ColorInput label="" aria-label={`New ${label} value`} value={value} onChange={setValue} className="min-w-[120px] flex-1" />
      ) : (
        <FamilySelect label={`New ${label} family`} value={value} onChange={setValue} />
      )}
      <Button type="submit" variant="outline" size="sm">
        <Plus size={14} /> Add {label}
      </Button>
    </form>
  );
}

export const ThemeForm = observer(({ project }: { project: ProjectModelType }) => {
  const { theme, usage, warnings } = useThemeState(project);
  const [message, setMessage] = React.useState<{ text: string; error: boolean } | null>(null);

  const apply = (edit: ThemeEdit | SiteTheme) => {
    if ('ok' in edit && !edit.ok) return setMessage({ text: edit.error, error: true });
    const next = 'ok' in edit ? edit.theme : edit;
    const result = project.updateTheme(next);
    setMessage(result.ok ? null : { text: result.errors.join(' '), error: true });
  };
  const replace = (fromId: string, toId: string) => {
    const result = project.replaceToken(fromId, toId);
    setMessage(result.ok ? { text: 'Replaced every use. Undo puts them back.', error: false } : { text: result.errors.join(' '), error: true });
  };
  const cleanUp = () => {
    const { theme: next, removed } = cleanUpUnused(theme, usage);
    if (removed.length === 0) return setMessage({ text: 'Every deleted token is still used somewhere, so nothing was removed. Content collection values are not scanned.', error: false });
    const result = project.updateTheme(next);
    setMessage(
      result.ok
        ? { text: `Removed ${removed.map((t) => t.name || 'unnamed').join(', ')}. Values in content collections were not scanned; one that still names a removed token shows nothing.`, error: false }
        : { text: result.errors.join(' '), error: true },
    );
  };

  const live = liveTokens(theme);
  const colours = live.filter((t) => t.kind === 'color');
  const fonts = live.filter((t) => t.kind === 'font');
  const deleted = tombstones(theme);
  const modeKey = theme.mode ?? 'none';

  return (
    <DialogBody className="flex flex-col gap-5">
      <div role="status" aria-live="polite" className={message ? `rounded-md px-2 py-1.5 text-xs ${message.error ? 'bg-destructive/10 text-destructive' : 'bg-muted text-foreground'}` : 'sr-only'}>
        {message?.text}
      </div>

      {warnings.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100" data-testid="theme-warnings">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      <section className="flex flex-col gap-2" aria-labelledby="theme-mode-title">
        <h3 id="theme-mode-title" className={sectionTitle}>
          Colour mode
        </h3>
        <div role="group" aria-labelledby="theme-mode-title" className="flex flex-wrap gap-1">
          {(['none', ...THEME_MODES] as const).map((mode) => (
            <Button
              key={mode}
              type="button"
              size="sm"
              variant={modeKey === mode ? 'default' : 'outline'}
              aria-pressed={modeKey === mode}
              onClick={() => apply(setThemeMode(theme, mode === 'none' ? undefined : mode))}
            >
              {MODE_LABEL[mode]}
            </Button>
          ))}
        </div>
        <p className={hint}>{MODE_HINT[modeKey]}</p>
      </section>

      <section className="flex flex-col gap-2" aria-labelledby="theme-document-title">
        <h3 id="theme-document-title" className={sectionTitle}>
          Page defaults
        </h3>
        <p className={hint}>What every page starts from. A page that sets its own on its document wins there.</p>
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
          {DOCUMENT_ROWS.map(({ key, label, kind }) => {
            const options = live.filter((t) => t.kind === kind);
            const current = parseTokenReference(theme.document[key]) ?? '';
            const currentLive = options.some((t) => t.id === current);
            return (
              <label key={key} className="flex flex-col gap-1 text-[11px] font-medium text-muted-foreground">
                {label}
                <select
                  value={current}
                  onChange={(e) => apply(setDocumentStyle(theme, key, e.target.value ? tokenReference(e.target.value) : undefined))}
                  className={`${control} cursor-pointer`}
                >
                  <option value="">None</option>
                  {current && !currentLive && <option value={current}>A deleted {kind === 'font' ? 'font' : 'colour'}</option>}
                  {options.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
            );
          })}
        </div>
      </section>

      <section className="flex flex-col gap-2" aria-labelledby="theme-colours-title">
        <h3 id="theme-colours-title" className={sectionTitle}>
          Colours
        </h3>
        {colours.length === 0 && <p className={hint}>No colours yet. A colour added here can be picked anywhere a colour is set.</p>}
        <ul className="flex flex-col gap-2">
          {colours.map((t) => (
            <TokenRow key={t.id} token={t} theme={theme} count={usage.get(t.id) ?? 0} apply={apply} replace={replace} />
          ))}
        </ul>
        <AddToken theme={theme} apply={apply} kind="color" />
      </section>

      <section className="flex flex-col gap-2" aria-labelledby="theme-fonts-title">
        <h3 id="theme-fonts-title" className={sectionTitle}>
          Fonts
        </h3>
        {fonts.length === 0 && <p className={hint}>No fonts yet. A font added here can be picked in Typography.</p>}
        <ul className="flex flex-col gap-2">
          {fonts.map((t) => (
            <TokenRow key={t.id} token={t} theme={theme} count={usage.get(t.id) ?? 0} apply={apply} replace={replace} />
          ))}
        </ul>
        <AddToken theme={theme} apply={apply} kind="font" />
      </section>

      {deleted.length > 0 && (
        <section className="flex flex-col gap-2" aria-labelledby="theme-deleted-title">
          <h3 id="theme-deleted-title" className={sectionTitle}>
            Deleted
          </h3>
          <p className={hint}>Pages still show these where they are used. Replace or detach each use, then Clean up removes them.</p>
          <ul className="flex flex-col gap-1.5">
            {deleted.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-1.5 text-xs" data-token-id={t.id} data-testid="theme-tombstone">
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {t.kind === 'color' ? 'Colour' : 'Font'}: {t.name || 'unnamed'}
                </span>
                <span className={hint}>{usedText(usage.get(t.id) ?? 0)}</span>
                <ReplaceSelect token={t} theme={theme} count={usage.get(t.id) ?? 0} replace={replace} />
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={cleanUp}>
              Clean up unused
            </Button>
            <span className={hint}>Values in content collections are not scanned.</span>
          </div>
        </section>
      )}
    </DialogBody>
  );
});
ThemeForm.displayName = 'ThemeForm';

export function ThemeDialog({ project, open, onClose }: { project: ProjectModelType; open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      {open && (
        <DialogContent
          data-testid="theme-dialog"
          data-editor-ui="true"
          className="max-w-[640px]"
          // Keep editor shortcuts from firing while typing; Escape still closes.
          onKeyDown={(e) => {
            if (e.key !== 'Escape') e.stopPropagation();
          }}
        >
          <DialogHeader>
            <DialogTitle>Theme</DialogTitle>
            <DialogDescription>The colours and fonts your whole site shares, its colour mode and what every page starts from.</DialogDescription>
          </DialogHeader>
          <ThemeForm project={project} />
        </DialogContent>
      )}
    </Dialog>
  );
}

export interface ThemeButtonProps extends ControllableOpenProps {
  /** Extra classes for the trigger (the compact top bar hides it and opens the dialog from its More menu). */
  triggerClassName?: string;
}

/** The top-bar entry: a palette button opening the Theme panel for the current project. */
const ThemeButton = observer(({ open: openProp, onOpenChange, triggerClassName = '' }: ThemeButtonProps) => {
  const project = useStore().editorUI.currentProject;
  const [open, setOpen] = useControllableOpen({ open: openProp, onOpenChange });
  if (!project) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Theme"
        aria-label="Theme"
        className={`mr-2 flex h-8 w-8 items-center justify-center rounded text-foreground hover:bg-accent ${triggerClassName}`}
      >
        <Palette size={16} />
      </button>
      <ThemeDialog project={project} open={open} onClose={() => setOpen(false)} />
    </>
  );
});
ThemeButton.displayName = 'ThemeButton';

export default ThemeButton;

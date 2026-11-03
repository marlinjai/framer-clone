'use client';
// The Typography font picker: the self-hosted font library
// (src/lib/fonts/registry.ts) grouped by category, plus Inherit and the system
// stack. A native select, so it keeps the keyboard and screen-reader behaviour
// of every other field. Native options cannot show their own face on every
// platform (and the library is not loaded into the panel), so the chosen
// family is shown as a preview line under the field instead. The preview face
// is loaded by the page's own @font-face rules (PageFontFaces), because the
// selected component already uses it.
import React from 'react';
import { observer } from 'mobx-react-lite';
import { ChevronDown } from 'lucide-react';
import { useStore } from '@/hooks/useStore';
import { EMPTY_THEME, findToken, fontTokenStack, liveTokens, parseTokenReference, referenceState, tokenReference } from '@/lib/site/theme';
import { cn } from '@/lib/utils';
import {
  FONT_CATEGORIES,
  FONT_LIBRARY,
  SYSTEM_FONT_STACK,
  findLibraryFamily,
  fontStack,
  parseFontFamilyList,
} from '@/lib/fonts/registry';
import { FIELD_CONTROL, useFieldIdentity } from './field';

export const INHERIT_FONT = 'inherit';

/** The option value a stored fontFamily selects ('' for none). */
export function fontOptionValue(stored: string | undefined): string {
  const value = (stored ?? '').trim();
  if (!value || value === INHERIT_FONT) return INHERIT_FONT;
  // A site font (a theme token) is its own option.
  if (parseTokenReference(value)) return value;
  if (value === SYSTEM_FONT_STACK) return SYSTEM_FONT_STACK;
  const first = parseFontFamilyList(value)[0];
  // Any stack that leads with the platform UI font is the System UI option
  // (older pages and the demo store a bare `system-ui`).
  if (first && /^(system-ui|-apple-system|ui-sans-serif)$/i.test(first)) return SYSTEM_FONT_STACK;
  const lib = first ? findLibraryFamily(first) : undefined;
  return lib ? fontStack(lib) : value;
}

interface FontFamilySelectProps {
  value: string | undefined;
  onChange: (value: string) => void;
  'aria-label'?: string;
  /**
   * Offer the site's font tokens (docs/plans/2026-11-02-theme-and-head.md, slice T4): the
   * value is then a reference to one, as the whole of `fontFamily`.
   */
  tokens?: boolean;
}

export const FontFamilySelect = observer(function FontFamilySelect({ value, onChange, 'aria-label': ariaLabelProp, tokens = false }: FontFamilySelectProps) {
  const { id, ariaLabel } = useFieldIdentity('', ariaLabelProp);
  const { editorUI } = useStore();
  const theme = editorUI.currentProject?.site?.theme ?? EMPTY_THEME;
  const selected = fontOptionValue(value);
  const tokenId = parseTokenReference(selected);
  const siteFonts = tokens ? liveTokens(theme).filter((t) => t.kind === 'font') : [];
  const token = tokenId ? findToken(theme, tokenId) : undefined;
  const state = tokenId ? referenceState(theme, tokenId) : undefined;
  // A reference whose token is not offered as a live site font still needs its own option.
  const listed = tokenId !== null && siteFonts.some((t) => t.id === tokenId);
  const tokenLabel =
    tokenId && !listed ? (state === 'deleted' ? `Deleted font: ${token?.name || 'unnamed'}` : state === 'missing' ? 'Missing font' : `Site font: ${token?.name || 'unnamed'}`) : null;
  const known =
    tokenId !== null || selected === INHERIT_FONT || selected === SYSTEM_FONT_STACK || FONT_LIBRARY.some((f) => fontStack(f) === selected);
  const customName = known ? undefined : parseFontFamilyList(selected)[0] ?? selected;
  // A site font previews in its registry stack: the panel holds no theme sheet.
  const shown = token?.kind === 'font' ? fontTokenStack(token.family) : selected;
  const library = parseFontFamilyList(shown)[0];
  const previewFamily = selected === INHERIT_FONT || (tokenId && state === 'missing') ? undefined : shown;

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="relative min-w-0">
        <select
          id={id}
          aria-label={ariaLabel}
          value={selected}
          onChange={(e) => onChange(e.target.value)}
          className={cn(FIELD_CONTROL, 'cursor-pointer appearance-none truncate pr-6')}
        >
          <option value={INHERIT_FONT}>Inherit</option>
          <option value={SYSTEM_FONT_STACK}>System UI</option>
          {customName ? <option value={selected}>{`Custom: ${customName}`}</option> : null}
          {tokenLabel ? <option value={selected}>{tokenLabel}</option> : null}
          {siteFonts.length > 0 ? (
            <optgroup label="Site fonts">
              {siteFonts.map((t) => (
                <option key={t.id} value={tokenReference(t.id)}>
                  {t.name}
                </option>
              ))}
            </optgroup>
          ) : null}
          {FONT_CATEGORIES.map((cat) => {
            const families = FONT_LIBRARY.filter((f) => f.category === cat.id);
            if (families.length === 0) return null;
            return (
              <optgroup key={cat.id} label={cat.label}>
                {families.map((f) => (
                  <option key={f.id} value={fontStack(f)} title={f.character}>
                    {f.displayName}
                  </option>
                ))}
              </optgroup>
            );
          })}
        </select>
        <ChevronDown
          size={12}
          aria-hidden
          className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
      </div>
      {tokenId && state !== 'live' ? (
        <div className="flex items-center gap-1 px-0.5 text-[11px] text-destructive" data-token-state={state}>
          <span className="truncate">{tokenLabel}</span>
          {token?.kind === 'font' ? (
            <button
              type="button"
              className="ml-auto flex-none rounded px-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => onChange(fontTokenStack(token.family))}
              title="Write this font here, so it no longer follows the site font"
            >
              Detach
            </button>
          ) : null}
        </div>
      ) : null}
      {previewFamily ? (
        <div
          aria-hidden
          data-font-preview=""
          className="truncate px-0.5 text-[15px] leading-tight text-foreground"
          style={{ fontFamily: previewFamily }}
          title={library ? findLibraryFamily(library)?.character : undefined}
        >
          Aa Gg Öß 0123 The quick brown fox
        </div>
      ) : null}
    </div>
  );
});

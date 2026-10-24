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
import { ChevronDown } from 'lucide-react';
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
  if (value === SYSTEM_FONT_STACK) return SYSTEM_FONT_STACK;
  const first = parseFontFamilyList(value)[0];
  const lib = first ? findLibraryFamily(first) : undefined;
  return lib ? fontStack(lib) : value;
}

interface FontFamilySelectProps {
  value: string | undefined;
  onChange: (value: string) => void;
  'aria-label'?: string;
}

export function FontFamilySelect({ value, onChange, 'aria-label': ariaLabelProp }: FontFamilySelectProps) {
  const { id, ariaLabel } = useFieldIdentity('', ariaLabelProp);
  const selected = fontOptionValue(value);
  const known =
    selected === INHERIT_FONT || selected === SYSTEM_FONT_STACK || FONT_LIBRARY.some((f) => fontStack(f) === selected);
  const customName = known ? undefined : parseFontFamilyList(selected)[0] ?? selected;
  const library = parseFontFamilyList(selected)[0];
  const previewFamily = selected === INHERIT_FONT ? undefined : selected;

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
}

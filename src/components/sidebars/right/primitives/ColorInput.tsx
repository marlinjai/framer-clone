'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { useOpenDraft } from '@/hooks/useOpenDraft';
import { cn } from '@/lib/utils';
import { useStore } from '@/hooks/useStore';
import { getHistoryStore } from '@/stores/RootStore';
import {
  EMPTY_THEME,
  liveTokens,
  parseTokenReference,
  referenceState,
  resolveTokenRefs,
  tokenReference,
  findToken,
  type SiteTheme,
} from '@/lib/site/theme';
import { FIELD_CONTROL, FIELD_INNER_INPUT, FIELD_LABEL, FIELD_SHELL, useFieldIdentity } from './field';

interface ColorInputProps {
  /** Visible label above the field. Leave empty inside a PropertyRow. */
  label: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
  /** Accessible name when the field has no visible label of its own. */
  'aria-label'?: string;
  /**
   * Offer the site's colour tokens (docs/plans/2026-11-02-theme-and-head.md, slice T4):
   * a value may then be a reference, shown as the token's chip, with Detach. Only where
   * the value is a style value a reference can stand in.
   */
  tokens?: boolean;
}

/** What a detached reference writes when it shows no colour at all. */
const DETACH_FALLBACK = '#000000';

/**
 * The native color picker only accepts "#rrggbb". Expand "#rgb", pass a valid
 * hex through, and report anything else (rgba(), named colors) as null so the
 * picker can fall back instead of warning on every keystroke.
 */
export function toPickerHex(value: string): string | null {
  const v = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  const short = v.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  return null;
}

/**
 * A drag on the native picker is one undo step: the first change opens one history batch,
 * every later change joins it, and it is written when focus leaves the picker or the field
 * goes away. Focus alone opens nothing, so a picker merely focused never holds a batch that
 * would block another edit or swallow it into a colour step. Only a batch this field started
 * is written: when another gesture already holds one (a drag, a resize), the field joins
 * nothing and closes nothing.
 */
function useColourGesture(): { start: () => void; end: () => void } {
  const owned = useRef(false);
  const end = useCallback(() => {
    if (!owned.current) return;
    owned.current = false;
    getHistoryStore()?.commitBatch();
  }, []);
  const start = useCallback(() => {
    const history = getHistoryStore();
    if (!history || history.batch || owned.current) return;
    history.startBatch('Colour');
    owned.current = true;
  }, []);
  // Unmounted while focused (the panel closed, the selection moved): the step still ends here.
  useEffect(() => end, [end]);
  return { start, end };
}

/**
 * Color field: one bordered field with the swatch inside on the left (a
 * transparent native color picker laid over it) and the value as mono text.
 * The text commits on Enter and blur; the picker commits as it changes, and a
 * whole drag on it is one undo step. With `tokens`, a reference to a site colour
 * shows as that colour's chip.
 */
export const ColorInput = observer(function ColorInput({ label, value, onChange, className, 'aria-label': ariaLabelProp, tokens = false }: ColorInputProps) {
  const { id, ariaLabel, name, showLabel } = useFieldIdentity(label, ariaLabelProp);
  const { editorUI } = useStore();
  const theme: SiteTheme = editorUI.currentProject?.site?.theme ?? EMPTY_THEME;
  const scheme = editorUI.frameColorScheme;
  const [localValue, setLocalValue] = useState(value || '#ffffff');
  const gesture = useColourGesture();

  useEffect(() => {
    setLocalValue(value || '#ffffff');
  }, [value]);

  const tokenId = tokens ? parseTokenReference(value) : null;
  const colours = tokens ? liveTokens(theme).filter((t) => t.kind === 'color') : [];

  // While a half-typed value is not a valid hex, the picker shows the committed one.
  const pickerHex = toPickerHex(localValue) ?? toPickerHex(value || '') ?? '#000000';

  const commitText = () => {
    draftState.settled();
    const next = localValue.trim();
    if (next && next !== value) onChange(next);
    else if (!next) setLocalValue(value || '#ffffff');
  };
  // Counted as unsaved, and committed by Cmd+S, leaving and unmount (useOpenDraft).
  const draftState = useOpenDraft(() => commitText());

  // The plain colour a reference becomes when it is detached: what it shows now, else
  // what it shows in the other scheme (a light value that does not read), else
  // DETACH_FALLBACK when it shows nothing at all (missing, or no value that reads).
  const detachedValue = () => {
    for (const s of [scheme, scheme === 'dark' ? 'light' : 'dark'] as const) {
      const resolved = resolveTokenRefs(value, theme, s);
      if (resolved !== value) return resolved;
    }
    return DETACH_FALLBACK;
  };

  const tokenPicker =
    colours.length > 0 ? (
      <select
        aria-label={name ? `${name}: site colour` : 'Site colour'}
        value={tokenId ?? ''}
        onChange={(e) => {
          if (e.target.value) onChange(tokenReference(e.target.value));
          // Other: back to a plain colour, the one the reference shows now.
          else if (tokenId) onChange(detachedValue());
        }}
        className={cn(FIELD_CONTROL, 'w-auto max-w-[96px] flex-none cursor-pointer truncate text-xs')}
        title="Use a site colour"
      >
        <option value="">{tokenId ? 'Other' : 'Site colour'}</option>
        {colours.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
    ) : null;

  if (tokenId) {
    const state = referenceState(theme, tokenId);
    const token = findToken(theme, tokenId);
    const resolved = resolveTokenRefs(value, theme, scheme);
    const literal = resolved !== value ? resolved : null;
    const text =
      state === 'live'
        ? token?.name
        : state === 'deleted'
          ? `Deleted colour: ${token?.name || 'unnamed'}`
          : state === 'broken'
            ? `Broken colour: ${token?.name || 'unnamed'}`
            : 'Missing colour';
    return (
      <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
        {showLabel && <span className={FIELD_LABEL}>{label}</span>}
        <div className="flex min-w-0 items-center gap-1">
          <div
            className={cn(FIELD_SHELL, 'flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden px-1')}
            data-token-state={state}
            role="group"
            aria-label={`${ariaLabel || name || 'Colour'}: ${text}`}
          >
            <span
              className="h-[18px] w-[18px] flex-none rounded-[4px] border border-border"
              style={{ background: literal ?? 'transparent' }}
              aria-hidden
            />
            <span className={cn('truncate text-xs', state === 'live' ? 'text-foreground' : 'text-destructive')}>{text}</span>
            {/* Always offered: a missing or broken colour (a component pasted from another
                site) must still lead back to a plain colour, also with no live colours. */}
            <button
              type="button"
              className="ml-auto flex-none rounded px-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => onChange(detachedValue())}
              title={
                literal
                  ? "Write this colour's current value here, so it no longer follows the site colour"
                  : `This colour shows nothing: write ${DETACH_FALLBACK} here instead, so it no longer follows the site colour`
              }
            >
              Detach
            </button>
          </div>
          {tokenPicker}
        </div>
      </div>
    );
  }

  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      {showLabel && (
        <label htmlFor={id} className={FIELD_LABEL}>
          {label}
        </label>
      )}

      <div className="flex min-w-0 items-center gap-1">
        <div className={cn(FIELD_SHELL, 'flex min-w-0 flex-1 items-center overflow-hidden')}>
          {/* Swatch: the user's color via inline style (intentional non-token color). */}
          <span
            className="relative ml-1 h-[18px] w-[18px] flex-none overflow-hidden rounded-[4px] border border-border"
            style={{ background: localValue }}
          >
            <input
              type="color"
              aria-label={name ? `${name} color picker` : 'Color picker'}
              value={pickerHex}
              onBlur={gesture.end}
              onChange={(e) => {
                gesture.start();
                setLocalValue(e.target.value);
                onChange(e.target.value);
              }}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            />
          </span>

          <input
            id={id}
            type="text"
            aria-label={ariaLabel}
            value={localValue}
            onChange={(e) => {
              draftState.edited();
              setLocalValue(e.target.value);
            }}
            onBlur={commitText}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitText();
            }}
            spellCheck={false}
            className={cn(FIELD_INNER_INPUT, 'pl-1.5 font-mono')}
            placeholder="#000000"
          />
        </div>
        {tokenPicker}
      </div>
    </div>
  );
});

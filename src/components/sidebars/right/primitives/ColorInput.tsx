'use client';
import React, { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { FIELD_INNER_INPUT, FIELD_LABEL, FIELD_SHELL, useFieldIdentity } from './field';

interface ColorInputProps {
  /** Visible label above the field. Leave empty inside a PropertyRow. */
  label: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
  /** Accessible name when the field has no visible label of its own. */
  'aria-label'?: string;
}

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
 * Color field: one bordered field with the swatch inside on the left (a
 * transparent native color picker laid over it) and the value as mono text.
 * The text commits on Enter and blur; the picker commits as it changes.
 */
export function ColorInput({ label, value, onChange, className, 'aria-label': ariaLabelProp }: ColorInputProps) {
  const { id, ariaLabel, name, showLabel } = useFieldIdentity(label, ariaLabelProp);
  const [localValue, setLocalValue] = useState(value || '#ffffff');

  useEffect(() => {
    setLocalValue(value || '#ffffff');
  }, [value]);

  // While a half-typed value is not a valid hex, the picker shows the committed one.
  const pickerHex = toPickerHex(localValue) ?? toPickerHex(value || '') ?? '#000000';

  const commitText = () => {
    const next = localValue.trim();
    if (next && next !== value) onChange(next);
    else if (!next) setLocalValue(value || '#ffffff');
  };

  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      {showLabel && (
        <label htmlFor={id} className={FIELD_LABEL}>
          {label}
        </label>
      )}

      <div className={cn(FIELD_SHELL, 'flex items-center overflow-hidden')}>
        {/* Swatch: the user's color via inline style (intentional non-token color). */}
        <span
          className="relative ml-1 h-[18px] w-[18px] flex-none overflow-hidden rounded-[4px] border border-border"
          style={{ background: localValue }}
        >
          <input
            type="color"
            aria-label={name ? `${name} color picker` : 'Color picker'}
            value={pickerHex}
            onChange={(e) => {
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
          onChange={(e) => setLocalValue(e.target.value)}
          onBlur={commitText}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitText();
          }}
          spellCheck={false}
          className={cn(FIELD_INNER_INPUT, 'pl-1.5 font-mono')}
          placeholder="#000000"
        />
      </div>
    </div>
  );
}

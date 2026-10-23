'use client';
import React, { useState, useEffect, useCallback } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { FIELD_INNER_INPUT, FIELD_LABEL, FIELD_SHELL, useFieldIdentity } from './field';

export interface ParsedValue {
  value: number | undefined;
  unit: string;
}

/**
 * Split a CSS length into number and unit. A bare number (string "1.5" or JS
 * number) and an empty value get `bareUnit`: "px" by default, as React treats
 * numbers in inline styles, and "" for properties where a unitless number is
 * meaningful (line-height).
 */
export function parseStyleValue(raw: string | number | undefined, bareUnit = 'px'): ParsedValue {
  if (raw === undefined || raw === null || raw === '') {
    return { value: undefined, unit: bareUnit };
  }
  if (raw === 'auto') return { value: undefined, unit: 'auto' };
  if (typeof raw === 'number') return { value: raw, unit: bareUnit };

  const str = String(raw).trim();
  if (str === 'auto') return { value: undefined, unit: 'auto' };
  if (str === 'none') return { value: undefined, unit: 'none' };

  const match = str.match(/^(-?\d*\.?\d+)\s*(px|%|em|rem|vw|vh|auto)?$/);
  if (match) {
    return { value: parseFloat(match[1]), unit: match[2] || bareUnit };
  }
  return { value: undefined, unit: bareUnit };
}

export function formatStyleValue(value: number | undefined, unit: string): string {
  if (unit === 'auto') return 'auto';
  if (unit === 'none') return 'none';
  if (value === undefined) return '';
  return `${value}${unit}`;
}

/** Keywords that stand for the whole value rather than a unit of a number. */
const KEYWORD_UNITS = new Set(['auto', 'none']);

/** A number typed with an optional unit, e.g. "12", "2rem", "-50%". */
const TYPED_VALUE = /^(-?\d*\.?\d+)\s*([a-z%]+)?$/i;

/** Round away float noise from stepping (0.1 + 0.2). */
function roundStep(n: number): number {
  return Number(n.toFixed(4));
}

/** The incoming value as the string onChange would emit for it, for no-op detection. */
function normalizeIncoming(raw: string | number | undefined, bareUnit: string): string {
  if (raw === undefined || raw === null) return '';
  if (typeof raw === 'number') return `${raw}${bareUnit}`;
  return String(raw).trim();
}

interface DimensionInputProps {
  /** Visible label above the field. Leave empty inside a PropertyRow. */
  label: string;
  value: string | number | undefined;
  onChange: (value: string) => void;
  units?: string[];
  className?: string;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  /** Short leading glyph inside the field, e.g. "W" or "X" in a two-up row. */
  prefix?: React.ReactNode;
  /** Accessible name when the field has no visible label of its own. */
  'aria-label'?: string;
}

/**
 * Number field with a unit, drawn as ONE bordered field: the number takes the
 * width, the unit sits inside the field as a compact trailing suffix. With more
 * than one unit the suffix is a transparent native <select> laid over the unit
 * text, so keyboard and screen reader users get a real listbox.
 *
 * Commits on Enter and blur. ArrowUp / ArrowDown step by `step` (x10 with
 * Shift) and commit immediately. Typing a unit ("2rem") switches to it when the
 * field offers that unit; typing "auto" works when "auto" is offered.
 */
export function DimensionInput({
  label,
  value,
  onChange,
  units = ['px', '%', 'auto'],
  className,
  placeholder = 'auto',
  min,
  max,
  step = 1,
  prefix,
  'aria-label': ariaLabelProp,
}: DimensionInputProps) {
  const { id, ariaLabel, name, showLabel } = useFieldIdentity(label, ariaLabelProp);
  // Listing "" as a unit makes bare numbers unitless instead of px.
  const bareUnit = units.includes('') ? '' : 'px';
  const parsed = parseStyleValue(value, bareUnit);
  const [localValue, setLocalValue] = useState(parsed.value?.toString() ?? '');
  const [unit, setUnit] = useState(parsed.unit);

  useEffect(() => {
    const p = parseStyleValue(value, bareUnit);
    setLocalValue(p.value?.toString() ?? '');
    setUnit(p.unit);
  }, [value, bareUnit]);

  // The unit a typed number gets when the current unit is a keyword.
  const numericUnit = units.find((u) => !KEYWORD_UNITS.has(u)) ?? 'px';
  // A value authored in a unit this field does not list (maxWidth "none", a
  // rem value on a px/% row) still has to show as selected, so it joins the list.
  const unitOptions = units.includes(unit) ? units : [...units, unit];

  const emit = useCallback((next: string) => {
    if (next !== normalizeIncoming(value, bareUnit)) onChange(next);
  }, [bareUnit, onChange, value]);

  const commit = useCallback((rawText: string, currentUnit: string) => {
    if (currentUnit === 'auto') {
      emit('auto');
      return;
    }
    const text = rawText.trim();
    if (text === '') {
      // An empty field keeps a keyword ("none") and clears a number.
      emit(KEYWORD_UNITS.has(currentUnit) ? currentUnit : '');
      return;
    }
    if (text.toLowerCase() === 'auto' && units.includes('auto')) {
      setUnit('auto');
      setLocalValue('');
      emit('auto');
      return;
    }
    const match = text.match(TYPED_VALUE);
    if (!match) {
      // Not a number: put back what the property actually holds.
      const p = parseStyleValue(value, bareUnit);
      setLocalValue(p.value?.toString() ?? '');
      setUnit(p.unit);
      return;
    }
    const num = parseFloat(match[1]);
    const typedUnit = match[2]?.toLowerCase();
    let nextUnit = KEYWORD_UNITS.has(currentUnit) ? numericUnit : currentUnit;
    if (typedUnit && units.includes(typedUnit) && !KEYWORD_UNITS.has(typedUnit)) nextUnit = typedUnit;
    setLocalValue(String(num));
    setUnit(nextUnit);
    emit(formatStyleValue(num, nextUnit));
  }, [bareUnit, emit, numericUnit, units, value]);

  const stepBy = (direction: 1 | -1, large: boolean) => {
    if (unit === 'auto') return;
    const current = parseFloat(localValue) || 0;
    let next = roundStep(current + direction * step * (large ? 10 : 1));
    if (max !== undefined) next = Math.min(max, next);
    if (min !== undefined) next = Math.max(min, next);
    const nextUnit = KEYWORD_UNITS.has(unit) ? numericUnit : unit;
    setLocalValue(String(next));
    setUnit(nextUnit);
    emit(formatStyleValue(next, nextUnit));
  };

  const isAuto = unit === 'auto';
  const suffixText = KEYWORD_UNITS.has(unit) ? '' : unit;

  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      {showLabel && (
        <label htmlFor={id} className={FIELD_LABEL}>
          {label}
        </label>
      )}

      <div className={cn(FIELD_SHELL, 'flex items-center overflow-hidden', isAuto && 'bg-muted/60')}>
        {prefix && (
          <span aria-hidden className="flex-none pl-2 text-[11px] text-muted-foreground select-none">
            {prefix}
          </span>
        )}

        <input
          id={id}
          type="text"
          aria-label={ariaLabel}
          value={isAuto ? '' : localValue}
          disabled={isAuto}
          placeholder={isAuto ? 'auto' : unit === 'none' ? 'none' : placeholder}
          onChange={(e) => setLocalValue(e.target.value)}
          onBlur={() => commit(localValue, unit)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit(localValue, unit);
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault();
              stepBy(e.key === 'ArrowUp' ? 1 : -1, e.shiftKey);
            }
          }}
          className={cn(FIELD_INNER_INPUT, 'tabular-nums', prefix && 'pl-1.5')}
        />

        {unitOptions.length > 1 ? (
          <span className="relative flex h-full flex-none items-center gap-0.5 pl-1 pr-1.5 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground">
            {suffixText}
            <ChevronDown size={10} aria-hidden />
            <select
              aria-label={name ? `${name} unit` : 'Unit'}
              value={unit}
              onChange={(e) => {
                const newUnit = e.target.value;
                setUnit(newUnit);
                if (KEYWORD_UNITS.has(newUnit)) {
                  setLocalValue('');
                  emit(newUnit);
                } else {
                  commit(localValue, newUnit);
                }
              }}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            >
              {unitOptions.map((u) => (
                <option key={u} value={u}>{u === '' ? 'unitless' : u}</option>
              ))}
            </select>
          </span>
        ) : suffixText ? (
          <span className="flex-none pr-2 font-mono text-[11px] text-muted-foreground select-none">
            {suffixText}
          </span>
        ) : null}
      </div>
    </div>
  );
}

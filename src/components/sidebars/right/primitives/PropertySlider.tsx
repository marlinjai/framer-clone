'use client';
import React, { useState, useEffect, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { FIELD_CONTROL, FIELD_LABEL, useFieldIdentity } from './field';

interface PropertySliderProps {
  /** Visible label above the slider. Leave empty inside a PropertyRow. */
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  displayMultiplier?: number;
  suffix?: string;
  className?: string;
}

export function PropertySlider({
  label,
  value,
  onChange,
  min = 0,
  max = 1,
  step = 0.01,
  displayMultiplier = 1,
  suffix = '',
  className
}: PropertySliderProps) {
  const { id, name, showLabel } = useFieldIdentity(label, undefined);
  const displayValue = Math.round(value * displayMultiplier);
  const [localInput, setLocalInput] = useState(String(displayValue));

  useEffect(() => {
    setLocalInput(String(Math.round(value * displayMultiplier)));
  }, [value, displayMultiplier]);

  const commitInput = useCallback((raw: string) => {
    const num = parseFloat(raw);
    if (isNaN(num)) {
      setLocalInput(String(Math.round(value * displayMultiplier)));
      return;
    }
    const next = Math.min(max, Math.max(min, num / displayMultiplier));
    if (next !== value) onChange(next);
    else setLocalInput(String(Math.round(value * displayMultiplier)));
  }, [onChange, displayMultiplier, min, max, value]);

  // Fill percentage for the track
  const fillPct = max === min ? 0 : ((value - min) / (max - min)) * 100;

  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      {showLabel && (
        <label htmlFor={id} className={FIELD_LABEL}>
          {label}
        </label>
      )}

      <div className="flex min-w-0 items-center gap-2">
        {/* Custom slider track: 4px, bg-muted, brand fill, 14px knob */}
        <div className="relative flex h-7 min-w-0 flex-1 items-center">
          {/* Track */}
          <div className="absolute inset-x-0 h-1 rounded-full bg-muted">
            {/* Fill */}
            <div
              className="absolute bottom-0 left-0 top-0 rounded-full bg-brand"
              style={{ width: `${fillPct}%` }}
            />
          </div>

          {/* Native range input, invisible but interactive */}
          <input
            id={id}
            type="range"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={(e) => onChange(parseFloat(e.target.value))}
            className="peer absolute inset-0 h-full w-full cursor-pointer opacity-0"
          />

          {/* Visual knob: 14px circle with hairline border + shadow */}
          <div
            className="pointer-events-none absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full border border-border bg-background shadow-sm peer-focus-visible:ring-2 peer-focus-visible:ring-brand"
            style={{ left: `calc(${fillPct}% - 7px)` }}
          />
        </div>

        {/* Numeric value, 52px */}
        <input
          type="text"
          aria-label={name ? `${name} value` : 'Value'}
          value={localInput + suffix}
          onChange={(e) => {
            const raw = e.target.value.replace(suffix, '').trim();
            setLocalInput(raw);
          }}
          onBlur={() => commitInput(localInput)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitInput(localInput);
          }}
          className={cn(FIELD_CONTROL, 'w-[52px] flex-none px-1.5 text-center font-mono tabular-nums')}
        />
      </div>
    </div>
  );
}

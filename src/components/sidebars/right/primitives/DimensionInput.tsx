'use client';
import React, { useState, useEffect, useCallback } from 'react';
import { cn } from '@/lib/utils';

export interface ParsedValue {
  value: number | undefined;
  unit: string;
}

export function parseStyleValue(raw: string | number | undefined): ParsedValue {
  if (raw === undefined || raw === null || raw === '') {
    return { value: undefined, unit: 'px' };
  }
  if (raw === 'auto') return { value: undefined, unit: 'auto' };
  if (typeof raw === 'number') return { value: raw, unit: 'px' };

  const str = String(raw).trim();
  if (str === 'auto') return { value: undefined, unit: 'auto' };
  if (str === 'none') return { value: undefined, unit: 'none' };

  const match = str.match(/^(-?\d*\.?\d+)\s*(px|%|em|rem|vw|vh|auto)?$/);
  if (match) {
    return { value: parseFloat(match[1]), unit: match[2] || 'px' };
  }
  return { value: undefined, unit: 'px' };
}

export function formatStyleValue(value: number | undefined, unit: string): string {
  if (unit === 'auto') return 'auto';
  if (unit === 'none') return 'none';
  if (value === undefined) return '';
  return `${value}${unit}`;
}

interface DimensionInputProps {
  label: string;
  value: string | number | undefined;
  onChange: (value: string) => void;
  units?: string[];
  className?: string;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
}

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
}: DimensionInputProps) {
  const parsed = parseStyleValue(value);
  const [localValue, setLocalValue] = useState(parsed.value?.toString() ?? '');
  const [unit, setUnit] = useState(parsed.unit);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    const p = parseStyleValue(value);
    setLocalValue(p.value?.toString() ?? '');
    setUnit(p.unit);
  }, [value]);

  const commit = useCallback((newVal: string, newUnit: string) => {
    if (newUnit === 'auto') {
      onChange('auto');
      return;
    }
    const num = parseFloat(newVal);
    if (!isNaN(num)) {
      onChange(formatStyleValue(num, newUnit));
    } else if (newVal === '') {
      onChange('');
    }
  }, [onChange]);

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      {/* Label row */}
      <label
        className="text-muted-foreground"
        style={{ fontSize: '11px' }}
      >
        {label}
      </label>

      {/* Value input + attached unit segment */}
      <div className="flex items-stretch">
        {/* Value input: 30px tall, hairline border, radius 7 (left side only when unit shown) */}
        <input
          type="text"
          value={unit === 'auto' ? 'auto' : localValue}
          disabled={unit === 'auto'}
          placeholder={placeholder}
          onChange={(e) => {
            const v = e.target.value;
            if (v === 'auto') {
              setUnit('auto');
              setLocalValue('');
              commit('', 'auto');
            } else {
              setLocalValue(v);
            }
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            commit(localValue, unit);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit(localValue, unit);
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              const num = parseFloat(localValue) || 0;
              const newVal = String(Math.min(max ?? Infinity, num + step));
              setLocalValue(newVal);
              commit(newVal, unit);
            }
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              const num = parseFloat(localValue) || 0;
              const newVal = String(Math.max(min ?? -Infinity, num - step));
              setLocalValue(newVal);
              commit(newVal, unit);
            }
          }}
          className={cn(
            "h-[30px] min-w-0 flex-1 bg-background border border-border px-2 outline-none",
            "text-foreground disabled:text-muted-foreground disabled:bg-muted",
            "transition-colors",
            units.length > 1
              ? "rounded-l-[7px] rounded-r-none border-r-0"
              : "rounded-[7px]",
            focused && "border-brand ring-3 ring-brand/12",
          )}
          style={{ fontSize: '12.5px' }}
        />

        {/* Attached unit segment: 30px, min-width 48px, bg-muted, radius right side */}
        {units.length > 1 && (
          <select
            value={unit}
            onChange={(e) => {
              const newUnit = e.target.value;
              setUnit(newUnit);
              commit(localValue, newUnit);
            }}
            className="h-[30px] min-w-[48px] bg-muted border border-border rounded-r-[7px] px-2 text-muted-foreground font-mono outline-none cursor-pointer"
            style={{ fontSize: '12px' }}
          >
            {units.map(u => (
              <option key={u} value={u}>{u}</option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}

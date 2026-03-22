'use client';
import React, { useState, useEffect, useCallback } from 'react';
import { Input } from '@/components/ui/input';
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
    <div className={cn("space-y-1", className)}>
      <label className="text-[11px] text-gray-500">{label}</label>
      <div className="flex gap-1">
        <Input
          value={unit === 'auto' ? 'auto' : localValue}
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
          onBlur={() => commit(localValue, unit)}
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
          disabled={unit === 'auto'}
          className="h-7 text-xs flex-1 min-w-0"
          placeholder={placeholder}
        />
        {units.length > 1 && (
          <select
            value={unit}
            onChange={(e) => {
              const newUnit = e.target.value;
              setUnit(newUnit);
              commit(localValue, newUnit);
            }}
            className="h-7 text-[10px] bg-gray-50 border border-gray-200 rounded px-1 text-gray-600 min-w-[40px]"
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

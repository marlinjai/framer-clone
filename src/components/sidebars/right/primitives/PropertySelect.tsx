'use client';
import React from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { FIELD_CONTROL, FIELD_LABEL, useFieldIdentity } from './field';

interface PropertySelectProps {
  /** Visible label above the field. Leave empty inside a PropertyRow. */
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  className?: string;
  placeholder?: string;
  /** Accessible name when the field has no visible label of its own. */
  'aria-label'?: string;
}

export function PropertySelect({
  label,
  value,
  onChange,
  options,
  className,
  placeholder = 'Select...',
  'aria-label': ariaLabelProp,
}: PropertySelectProps) {
  const { id, ariaLabel, showLabel } = useFieldIdentity(label, ariaLabelProp);

  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      {showLabel && (
        <label htmlFor={id} className={FIELD_LABEL}>
          {label}
        </label>
      )}

      {/* Native select in the shared field spec, with a trailing chevron. */}
      <div className="relative min-w-0">
        <select
          id={id}
          aria-label={ariaLabel}
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          className={cn(FIELD_CONTROL, 'cursor-pointer appearance-none truncate pr-6')}
        >
          {placeholder && !value && (
            <option value="" disabled>{placeholder}</option>
          )}
          {options.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>

        <ChevronDown
          size={12}
          aria-hidden
          className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
      </div>
    </div>
  );
}

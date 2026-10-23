'use client';
import React from 'react';
import { cn } from '@/lib/utils';
import { FIELD_LABEL, useFieldIdentity } from './field';

interface ToggleIconGroupProps {
  /** Visible label above the group. Leave empty inside a PropertyRow. */
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; icon: React.ReactNode; tooltip?: string }[];
  className?: string;
}

/** Segmented control: one option active at a time, 28px tall like every field. */
export function ToggleIconGroup({
  label,
  value,
  onChange,
  options,
  className
}: ToggleIconGroupProps) {
  const { id, name, showLabel } = useFieldIdentity(label, undefined);

  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      {showLabel && (
        <span id={`${id}-label`} className={FIELD_LABEL}>
          {label}
        </span>
      )}

      {/* Segmented track: bg-muted, radius 6, 2px inset */}
      <div
        role="group"
        aria-labelledby={showLabel ? `${id}-label` : undefined}
        aria-label={showLabel ? undefined : name || undefined}
        className="flex h-7 min-w-0 gap-0.5 rounded-[6px] bg-muted p-0.5"
      >
        {options.map(opt => {
          const isActive = opt.value === value;
          const optionName = opt.tooltip || opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              title={optionName}
              aria-label={optionName}
              aria-pressed={isActive}
              onClick={() => onChange(opt.value)}
              className={cn(
                'flex min-w-0 flex-1 items-center justify-center overflow-hidden rounded-[4px] text-[11px] font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
                isActive
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {opt.icon}
            </button>
          );
        })}
      </div>
    </div>
  );
}

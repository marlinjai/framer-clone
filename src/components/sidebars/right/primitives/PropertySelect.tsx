'use client';
import React from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

interface PropertySelectProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  className?: string;
  placeholder?: string;
}

export function PropertySelect({
  label,
  value,
  onChange,
  options,
  className,
  placeholder = 'Select...',
}: PropertySelectProps) {
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <label
        className="text-muted-foreground"
        style={{ fontSize: '11px' }}
      >
        {label}
      </label>

      {/* .sel look: 30px, hairline border, radius 7, trailing chevron */}
      <div className="relative">
        <select
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          className={cn(
            "w-full h-[30px] appearance-none bg-background border border-border rounded-[7px]",
            "pl-2 pr-7 text-foreground outline-none cursor-pointer",
            "focus:border-brand focus:ring-3 focus:ring-brand/12 transition-colors",
          )}
          style={{ fontSize: '12.5px' }}
        >
          {placeholder && !value && (
            <option value="" disabled>{placeholder}</option>
          )}
          {options.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>

        {/* Trailing chevron */}
        <ChevronDown
          size={13}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
        />
      </div>
    </div>
  );
}

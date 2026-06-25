'use client';
import React from 'react';
import { cn } from '@/lib/utils';

interface ToggleIconGroupProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; icon: React.ReactNode; tooltip?: string }[];
  className?: string;
}

export function ToggleIconGroup({
  label,
  value,
  onChange,
  options,
  className
}: ToggleIconGroupProps) {
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <label
        className="text-muted-foreground"
        style={{ fontSize: '11px' }}
      >
        {label}
      </label>

      {/* Segmented track: bg-muted, radius 7, padding 2, gap 2 */}
      <div className="flex bg-muted rounded-[7px] p-0.5 gap-0.5">
        {options.map(opt => {
          const isActive = opt.value === value;
          return (
            <button
              key={opt.value}
              type="button"
              title={opt.tooltip || opt.value}
              onClick={() => onChange(opt.value)}
              className={cn(
                "flex-1 flex items-center justify-center rounded-[5px] transition-all",
                "text-muted-foreground",
                isActive
                  ? "bg-background text-foreground shadow-sm"
                  : "hover:text-foreground",
              )}
              style={{ height: '26px', fontSize: '12px', fontWeight: 500 }}
            >
              {opt.icon}
            </button>
          );
        })}
      </div>
    </div>
  );
}

'use client';
import React from 'react';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
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
    <div className={cn("space-y-1", className)}>
      <label className="text-[11px] text-gray-500">{label}</label>
      <ToggleGroup
        type="single"
        value={value}
        onValueChange={(v) => { if (v) onChange(v); }}
        size="sm"
        className="justify-start gap-0.5"
      >
        {options.map(opt => (
          <ToggleGroupItem
            key={opt.value}
            value={opt.value}
            title={opt.tooltip || opt.value}
            className="h-7 w-7 p-0"
          >
            {opt.icon}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

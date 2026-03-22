'use client';
import React, { useState, useEffect } from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

interface ColorInputProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

export function ColorInput({ label, value, onChange, className }: ColorInputProps) {
  const [localValue, setLocalValue] = useState(value || '#ffffff');

  useEffect(() => {
    setLocalValue(value || '#ffffff');
  }, [value]);

  return (
    <div className={cn("space-y-1", className)}>
      <label className="text-[11px] text-gray-500">{label}</label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={localValue}
          onChange={(e) => {
            setLocalValue(e.target.value);
            onChange(e.target.value);
          }}
          className="w-7 h-7 rounded border border-gray-200 cursor-pointer p-0.5 bg-transparent"
        />
        <Input
          value={localValue}
          onChange={(e) => {
            setLocalValue(e.target.value);
          }}
          onBlur={() => onChange(localValue)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onChange(localValue);
          }}
          className="h-7 text-xs flex-1 font-mono"
          placeholder="#000000"
        />
      </div>
    </div>
  );
}

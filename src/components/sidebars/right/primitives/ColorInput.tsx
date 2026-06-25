'use client';
import React, { useState, useEffect } from 'react';
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
    <div className={cn("flex flex-col gap-1", className)}>
      <label
        className="text-muted-foreground"
        style={{ fontSize: '11px' }}
      >
        {label}
      </label>

      {/* Field row: swatch + mono hex input */}
      <div className="flex items-center gap-1.5">
        {/* 28x28 rounded swatch: user color via inline style (intentional non-token color) */}
        <div
          className="w-[28px] h-[28px] rounded-[7px] border border-border flex-none cursor-pointer overflow-hidden"
          style={{ background: localValue }}
        >
          <input
            type="color"
            value={localValue}
            onChange={(e) => {
              setLocalValue(e.target.value);
              onChange(e.target.value);
            }}
            className="w-full h-full opacity-0 cursor-pointer"
            style={{ padding: 0, margin: 0 }}
          />
        </div>

        {/* Mono hex input: 30px, hairline border, radius 7, 12.5px */}
        <input
          type="text"
          value={localValue}
          onChange={(e) => setLocalValue(e.target.value)}
          onBlur={() => onChange(localValue)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onChange(localValue);
          }}
          className={cn(
            "h-[30px] flex-1 min-w-0 bg-background border border-border rounded-[7px] px-2 font-mono",
            "text-foreground outline-none transition-colors",
            "focus:border-brand focus:ring-3 focus:ring-brand/12",
          )}
          style={{ fontSize: '12.5px' }}
          placeholder="#000000"
        />
      </div>
    </div>
  );
}

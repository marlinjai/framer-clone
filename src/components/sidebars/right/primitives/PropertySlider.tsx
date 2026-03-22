'use client';
import React, { useState, useEffect } from 'react';
import { Slider } from '@/components/ui/slider';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

interface PropertySliderProps {
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
  const displayValue = Math.round(value * displayMultiplier);
  const [localInput, setLocalInput] = useState(String(displayValue));

  useEffect(() => {
    setLocalInput(String(Math.round(value * displayMultiplier)));
  }, [value, displayMultiplier]);

  return (
    <div className={cn("space-y-1", className)}>
      <label className="text-[11px] text-gray-500">{label}</label>
      <div className="flex items-center gap-2">
        <Slider
          value={[value]}
          onValueChange={([v]) => onChange(v)}
          min={min}
          max={max}
          step={step}
          className="flex-1"
        />
        <div className="flex items-center">
          <Input
            value={localInput}
            onChange={(e) => setLocalInput(e.target.value)}
            onBlur={() => {
              const num = parseFloat(localInput);
              if (!isNaN(num)) onChange(num / displayMultiplier);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const num = parseFloat(localInput);
                if (!isNaN(num)) onChange(num / displayMultiplier);
              }
            }}
            className="h-7 w-14 text-xs text-center"
          />
          {suffix && <span className="text-[10px] text-gray-400 ml-0.5">{suffix}</span>}
        </div>
      </div>
    </div>
  );
}

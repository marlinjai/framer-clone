'use client';
import React, { useState, useEffect, useCallback } from 'react';
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

  const commitInput = useCallback((raw: string) => {
    const num = parseFloat(raw);
    if (!isNaN(num)) onChange(num / displayMultiplier);
  }, [onChange, displayMultiplier]);

  // Fill percentage for the track
  const fillPct = max === min ? 0 : ((value - min) / (max - min)) * 100;

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <label
        className="text-muted-foreground"
        style={{ fontSize: '11px' }}
      >
        {label}
      </label>

      <div className="flex items-center gap-2">
        {/* Custom slider track: 4px, bg-muted, iris fill, 14px white knob */}
        <div className="flex-1 relative flex items-center" style={{ height: '14px' }}>
          {/* Track */}
          <div className="absolute inset-x-0 rounded-full bg-muted" style={{ height: '4px' }}>
            {/* Fill */}
            <div
              className="absolute left-0 top-0 bottom-0 bg-brand rounded-full"
              style={{ width: `${fillPct}%` }}
            />
          </div>

          {/* Native range input, invisible but interactive */}
          <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={(e) => onChange(parseFloat(e.target.value))}
            className="absolute inset-0 w-full opacity-0 cursor-pointer"
            style={{ height: '100%' }}
          />

          {/* Visual knob: 14px white circle with hairline border + shadow */}
          <div
            className="absolute w-[14px] h-[14px] rounded-full bg-background border border-border shadow-sm pointer-events-none"
            style={{
              left: `calc(${fillPct}% - 7px)`,
              top: '50%',
              transform: 'translateY(-50%)',
            }}
          />
        </div>

        {/* 52px numeric input */}
        <input
          type="text"
          value={localInput + suffix}
          onChange={(e) => {
            const raw = e.target.value.replace(suffix, '').trim();
            setLocalInput(raw);
          }}
          onBlur={() => commitInput(localInput)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitInput(localInput);
          }}
          className={cn(
            "h-[30px] bg-background border border-border rounded-[7px] px-2 font-mono text-center",
            "text-foreground outline-none transition-colors",
            "focus:border-brand focus:ring-3 focus:ring-brand/12",
          )}
          style={{ width: '52px', fontSize: '12.5px', flexShrink: 0 }}
        />
      </div>
    </div>
  );
}

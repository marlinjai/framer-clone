// src/components/ai/ModelSlider.tsx
//
// The three-step model slider (Fast = Haiku 5.5, Balanced = Sonnet 5.5,
// Best = Opus 5.5) shared by the Generate page dialog and the CMS content
// agent. A native range input, so keyboard (arrows, Home, End, Page Up/Down)
// and screen-reader semantics come from the platform; `aria-valuetext` reads
// out the step and model name instead of "0, 1, 2". The hint line below says
// what the choice means for speed and cost.
'use client';

import React from 'react';
import { MODEL_CHOICES, MODEL_CHOICE_INFO, type ModelChoice } from '@/lib/ai/modelChoice';

export interface ModelSliderProps {
  value: ModelChoice;
  onChange: (next: ModelChoice) => void;
  disabled?: boolean;
  /** Unique id for the input; the label and hint hang off it. */
  id: string;
  label?: string;
  /** Smaller type for tight spaces (the agent input bar). */
  compact?: boolean;
}

export function ModelSlider({ value, onChange, disabled, id, label = 'Model', compact }: ModelSliderProps) {
  const index = Math.max(0, MODEL_CHOICES.indexOf(value));
  const info = MODEL_CHOICE_INFO[MODEL_CHOICES[index]];
  const hintId = `${id}-hint`;
  const text = compact ? 'text-[11px]' : 'text-xs';
  return (
    <div className="grid gap-1" data-testid={`${id}-model-slider`}>
      <div className={`flex items-baseline justify-between ${text}`}>
        <label htmlFor={id} className="font-medium text-muted-foreground">
          {label}
        </label>
        <span className="font-medium text-foreground">
          {info.step} <span className="text-muted-foreground">({info.modelName})</span>
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={0}
        max={MODEL_CHOICES.length - 1}
        step={1}
        value={index}
        disabled={disabled}
        aria-valuetext={`${info.step}: ${info.modelName}`}
        aria-describedby={hintId}
        onChange={(e) => {
          const next = MODEL_CHOICES[Number(e.target.value)];
          if (next && next !== value) onChange(next);
        }}
        className="h-1.5 w-full cursor-pointer accent-brand disabled:cursor-not-allowed disabled:opacity-50"
      />
      <div className={`flex justify-between text-muted-foreground ${compact ? 'text-[10px]' : 'text-[11px]'}`} aria-hidden="true">
        {MODEL_CHOICES.map((m) => (
          <span key={m} className={m === value ? 'font-medium text-foreground' : undefined}>
            {MODEL_CHOICE_INFO[m].step}
          </span>
        ))}
      </div>
      <p id={hintId} className={`text-muted-foreground ${compact ? 'text-[11px]' : 'text-xs'}`}>
        {info.hint}
      </p>
    </div>
  );
}

export default ModelSlider;

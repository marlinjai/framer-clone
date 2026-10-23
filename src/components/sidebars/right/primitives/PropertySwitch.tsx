'use client';
import React from 'react';
import { Switch } from '@/components/ui/switch';
import { useFieldIdentity } from './field';

interface PropertySwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Accessible name when not inside a PropertyRow. */
  'aria-label'?: string;
}

/** On / off toggle for a PropertyRow; the row label names it and toggles it. */
export function PropertySwitch({ checked, onCheckedChange, 'aria-label': ariaLabelProp }: PropertySwitchProps) {
  const { id, ariaLabel } = useFieldIdentity(undefined, ariaLabelProp);
  return (
    <div className="flex h-7 items-center">
      <Switch id={id} aria-label={ariaLabel} checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}

'use client';
import React from 'react';
import { cn } from '@/lib/utils';
import { FIELD_CONTROL, useFieldIdentity } from './field';

type TextInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'id'> & {
  /** Use the monospace face, for code-like values (shadows, URLs). */
  mono?: boolean;
  /** Reaches the input itself (a React 19 prop), for moving focus to it. */
  ref?: React.Ref<HTMLInputElement>;
};

/** Plain single-line text field with the shared inspector field spec. */
export function TextInput({ className, mono, 'aria-label': ariaLabelProp, ...props }: TextInputProps) {
  const { id, ariaLabel } = useFieldIdentity(undefined, ariaLabelProp);
  return (
    <input
      type="text"
      id={id}
      aria-label={ariaLabel}
      className={cn(FIELD_CONTROL, mono && 'font-mono text-[11px]', className)}
      {...props}
    />
  );
}
// ci-replay touch

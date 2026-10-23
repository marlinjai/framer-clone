'use client';
import React, { useId } from 'react';
import { cn } from '@/lib/utils';
import { FIELD_LABEL, FieldContext } from './field';

interface PropertyRowProps {
  label: string;
  children: React.ReactNode;
  /** Hover hint on the label, for properties whose name needs explaining. */
  hint?: string;
  /**
   * The row holds several fields (W / H, X / Y) rather than one control. The
   * label then names the group and each field carries its own aria-label.
   */
  group?: boolean;
  className?: string;
}

/**
 * One inspector row: a fixed 64px label column and a field column.
 *
 * The field track is `minmax(0, 1fr)`, not `1fr`: a plain `1fr` track cannot
 * shrink below its content's intrinsic width, which is what pushed inputs past
 * the edge of the panel. Every section lays its rows out with this component
 * so the label column lines up across the whole panel.
 */
export function PropertyRow({ label, children, hint, group = false, className }: PropertyRowProps) {
  const id = useId();
  const labelId = `${id}-label`;

  // A group (W / H, X / Y, four sides) gets the full panel width under a
  // caption: squeezed into the field column, two fields with a prefix and a
  // unit each left the number itself only a few pixels.
  if (group) {
    return (
      <div className={cn('flex flex-col gap-1.5', className)}>
        <span id={labelId} className={cn(FIELD_LABEL, 'truncate')} title={hint ?? label}>
          {label}
        </span>
        <div className="min-w-0" role="group" aria-labelledby={labelId}>
          <FieldContext.Provider value={null}>{children}</FieldContext.Provider>
        </div>
      </div>
    );
  }

  return (
    <div className={cn('grid min-h-7 grid-cols-[64px_minmax(0,1fr)] items-center gap-2', className)}>
      <label htmlFor={id} className={cn(FIELD_LABEL, 'truncate')} title={hint ?? label}>
        {label}
      </label>
      <div className="min-w-0">
        <FieldContext.Provider value={{ id, label }}>{children}</FieldContext.Provider>
      </div>
    </div>
  );
}

/** Two fields side by side inside a PropertyRow's field column. */
export function FieldPair({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-2">{children}</div>;
}

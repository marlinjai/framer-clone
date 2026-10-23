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

  return (
    <div className={cn('grid min-h-7 grid-cols-[64px_minmax(0,1fr)] items-center gap-2', className)}>
      {group ? (
        <span id={labelId} className={cn(FIELD_LABEL, 'truncate')} title={hint ?? label}>
          {label}
        </span>
      ) : (
        <label htmlFor={id} className={cn(FIELD_LABEL, 'truncate')} title={hint ?? label}>
          {label}
        </label>
      )}
      <div
        className="min-w-0"
        role={group ? 'group' : undefined}
        aria-labelledby={group ? labelId : undefined}
      >
        <FieldContext.Provider value={group ? null : { id, label }}>
          {children}
        </FieldContext.Provider>
      </div>
    </div>
  );
}

/** Two fields side by side inside a PropertyRow's field column. */
export function FieldPair({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-2">{children}</div>;
}

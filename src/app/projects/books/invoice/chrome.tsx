'use client';

// src/app/projects/books/invoice/chrome.tsx
//
// The invoice editor's chrome (plan 2026-10-25-books-invoice-editor-shell):
// the site editor's structure (a top bar, a floating bottom toolbar, icon
// buttons with the editor's dark tooltip, here also on keyboard focus, and the
// sidebar's segmented switch), in the glass language the owner chose: frosted
// panels (`glass`, globals.css) and near-black for what is pressed.

import React, { useId } from 'react';

import { cn } from '@/lib/utils';

/**
 * An icon button with a tooltip naming it and its shortcut. A disabled one stays focusable (aria-disabled), so its
 * tooltip can say why it is disabled.
 */
export const ToolButton = React.forwardRef<
  HTMLButtonElement,
  {
    label: string;
    /** Shown in the tooltip ("⌘Z"); the accessible shortcut is `keys`. */
    shortcut?: string;
    keys?: string;
    /** Why the button does nothing now (shown in the tooltip instead of the label's shortcut). */
    disabledReason?: string | null;
    disabled?: boolean;
    pressed?: boolean;
    /** The pill's 36px buttons or the bar's 32px ones; the tooltip opens away from the screen edge. */
    size?: 'pill' | 'bar';
    tooltipSide?: 'top' | 'bottom';
    onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
    children: React.ReactNode;
    className?: string;
  } & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'disabled' | 'children'>
>(function ToolButton(
  { label, shortcut, keys, disabledReason, disabled, pressed, size = 'pill', tooltipSide = 'top', onClick, children, className, ...rest },
  ref,
) {
  const tipId = useId();
  const tip = disabled && disabledReason ? disabledReason : shortcut ? `${label} (${shortcut})` : label;
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      aria-describedby={tip !== label ? tipId : undefined}
      aria-keyshortcuts={keys}
      aria-pressed={pressed}
      aria-disabled={disabled || undefined}
      onClick={(e) => {
        if (disabled) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
      className={cn(
        'group/tool relative flex shrink-0 items-center justify-center rounded-lg transition-colors duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
        size === 'pill' ? 'size-9' : 'size-8 rounded-md',
        pressed
          ? 'bg-foreground text-background shadow-sm'
          : disabled
            ? 'cursor-not-allowed text-muted-foreground/50'
            : 'text-foreground/70 hover:bg-foreground/[0.06] hover:text-foreground',
        className,
      )}
      {...rest}
    >
      {children}
      <span
        id={tipId}
        role="tooltip"
        className={cn(
          'pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded-md bg-foreground px-2.5 py-1.5 text-xs font-medium text-background opacity-0 shadow-lg transition-opacity duration-150',
          'group-hover/tool:opacity-100 group-focus-visible/tool:opacity-100',
          tooltipSide === 'top' ? 'bottom-full mb-2.5' : 'top-full mt-2.5',
        )}
      >
        {tip}
      </span>
    </button>
  );
});

/** A ToolButton that is a link (opening or downloading a file), with the same look and tooltip. */
export function ToolLink({
  label,
  href,
  size = 'bar',
  tooltipSide = 'bottom',
  children,
}: {
  label: string;
  href: string;
  size?: 'pill' | 'bar';
  tooltipSide?: 'top' | 'bottom';
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      aria-label={label}
      className={cn(
        'group/tool relative flex shrink-0 items-center justify-center text-foreground/70 transition-colors duration-150 hover:bg-foreground/[0.06] hover:text-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
        size === 'pill' ? 'size-9 rounded-lg' : 'size-8 rounded-md',
      )}
    >
      {children}
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded-md bg-foreground px-2.5 py-1.5 text-xs font-medium text-background opacity-0 shadow-lg transition-opacity duration-150',
          'group-hover/tool:opacity-100 group-focus-visible/tool:opacity-100',
          tooltipSide === 'top' ? 'bottom-full mb-2.5' : 'top-full mt-2.5',
        )}
      >
        {label}
      </span>
    </a>
  );
}

/**
 * The glass for the shared menus and dialogs of the Books editors (their own background is the solid popover):
 * the same tokens as `glass`, merged over the component's classes.
 */
export const GLASS_SURFACE =
  'border-[var(--glass-edge)] bg-[var(--glass-fill)] backdrop-blur-[22px] backdrop-saturate-150 shadow-[inset_0_1px_0_0_var(--glass-highlight),0_1px_2px_0_oklch(0_0_0/0.04),0_16px_40px_-12px_var(--glass-shade)]';

/** The floating bottom toolbar: the site editor's pill, centred over the canvas. */
export function FloatingToolbar({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center px-4">
      <div
        role="toolbar"
        aria-label={label}
        aria-orientation="horizontal"
        className="glass pointer-events-auto flex items-center gap-1 rounded-2xl p-1.5"
      >
        {children}
      </div>
    </div>
  );
}

export function ToolbarDivider() {
  return <span aria-hidden className="mx-1 h-6 w-px bg-foreground/10" />;
}

/** The sidebar's segmented switch: a muted track, the chosen segment raised. */
export function SegmentedSwitch<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="glass-inset flex h-8 gap-0.5 rounded-xl p-0.5">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => !on && onChange(o.value)}
            className={cn(
              'rounded-[10px] px-3 text-[12.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
              on ? 'bg-background/90 text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

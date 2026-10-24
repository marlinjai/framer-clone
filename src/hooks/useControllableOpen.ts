// src/hooks/useControllableOpen.ts
//
// Open state for a button that owns a dialog: uncontrolled by default (the
// button opens its own dialog), or controlled by a parent that passes `open`
// and `onOpenChange`. The editor top bar controls its buttons' dialogs so the
// compact bar's More menu opens the very same dialog instance (plan
// docs/plans/2026-10-24-editor-on-phones.md).
import * as React from 'react';

export interface ControllableOpenProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function useControllableOpen({ open, onOpenChange }: ControllableOpenProps): [boolean, (open: boolean) => void] {
  const [inner, setInner] = React.useState(false);
  const isControlled = open !== undefined;
  const setOpen = React.useCallback(
    (next: boolean) => {
      if (!isControlled) setInner(next);
      onOpenChange?.(next);
    },
    [isControlled, onOpenChange],
  );
  return [isControlled ? open : inner, setOpen];
}

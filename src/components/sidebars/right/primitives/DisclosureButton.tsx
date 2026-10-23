'use client';
import React from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

interface DisclosureButtonProps {
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  className?: string;
}

/** Small "more options" toggle inside a section (Min / Max, Individual sides). */
export function DisclosureButton({ open, onToggle, children, className }: DisclosureButtonProps) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className={cn(
        'flex h-6 items-center gap-1 self-start rounded-[5px] pr-1.5 text-[11px] text-muted-foreground',
        'transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
        className,
      )}
    >
      <ChevronRight size={12} className={cn('transition-transform duration-150', open && 'rotate-90')} />
      {children}
    </button>
  );
}

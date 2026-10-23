'use client';
import React, { useId, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

interface CollapsibleSectionProps {
  title: string;
  icon?: React.ReactNode;
  defaultOpen?: boolean;
  badge?: string;
  children: React.ReactNode;
}

export function CollapsibleSection({
  title,
  icon,
  defaultOpen = true,
  badge,
  children
}: CollapsibleSectionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const bodyId = useId();

  return (
    <div className="border-b border-border last:border-b-0">
      {/* Section header: 36px tall, chevron + icon + uppercase title */}
      <button
        type="button"
        aria-expanded={isOpen}
        aria-controls={bodyId}
        onClick={() => setIsOpen(!isOpen)}
        className="flex h-9 w-full items-center gap-2 px-3 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
      >
        <ChevronRight
          size={12}
          aria-hidden
          className={cn('flex-none transition-transform duration-150', isOpen && 'rotate-90')}
        />
        {icon && (
          <span aria-hidden className="flex-none">{icon}</span>
        )}
        <span className="min-w-0 flex-1 truncate text-left text-[11px] font-semibold uppercase tracking-[0.05em]">
          {title}
        </span>
        {badge && (
          <span className="max-w-[45%] flex-none truncate rounded bg-brand/10 px-1.5 py-0.5 text-[10px] text-brand normal-case">
            {badge}
          </span>
        )}
      </button>

      {/* Section body: one horizontal inset, 8px between rows */}
      {isOpen && (
        <div id={bodyId} className="flex min-w-0 flex-col gap-2 px-3 pb-3">
          {children}
        </div>
      )}
    </div>
  );
}

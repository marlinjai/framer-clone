'use client';
import React, { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

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

  return (
    <div className="border-b border-border last:border-b-0">
      {/* Section header: 38px tall, chevron + icon + uppercase title */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 w-full h-[38px] px-3 hover:bg-accent transition-colors"
      >
        {isOpen ? (
          <ChevronDown size={13} className="text-muted-foreground flex-none" />
        ) : (
          <ChevronRight size={13} className="text-muted-foreground flex-none" />
        )}
        {icon && (
          <span className="text-muted-foreground flex-none">{icon}</span>
        )}
        <span
          className="text-muted-foreground flex-1 text-left"
          style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}
        >
          {title}
        </span>
        {badge && (
          <span className="text-[10px] text-brand bg-brand/10 px-1.5 py-0.5 rounded flex-none">
            {badge}
          </span>
        )}
      </button>

      {/* Section body: consistent padding + gap */}
      {isOpen && (
        <div className="px-3 pb-3.5 flex flex-col gap-2.5">
          {children}
        </div>
      )}
    </div>
  );
}

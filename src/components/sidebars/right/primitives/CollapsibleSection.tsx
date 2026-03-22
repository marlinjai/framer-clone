'use client';
import React, { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
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

  return (
    <div className="border-b border-gray-100 last:border-b-0">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center justify-between w-full py-2 px-1 hover:bg-gray-50 rounded-sm transition-colors"
      >
        <div className="flex items-center gap-1.5">
          {isOpen ? (
            <ChevronDown size={12} className="text-gray-400" />
          ) : (
            <ChevronRight size={12} className="text-gray-400" />
          )}
          {icon && <span className="text-gray-500">{icon}</span>}
          <span className="text-xs font-medium text-gray-700 uppercase tracking-wider">{title}</span>
        </div>
        {badge && (
          <span className="text-[10px] text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded">
            {badge}
          </span>
        )}
      </button>
      {isOpen && (
        <div className="pb-3 px-1 space-y-2">
          {children}
        </div>
      )}
    </div>
  );
}

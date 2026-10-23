'use client';
// Segmented tab strip for the left sidebar's bottom pane (Components / Layers /
// Content). Text-only segments so the three labels always fit the 256px panel.
// Follows the WAI-ARIA tabs pattern: roving tabindex, Arrow Left / Right and
// Home / End move focus and select (automatic activation).
import React, { useRef } from 'react';
import { cn } from '@/lib/utils';

export interface PaneTab<T extends string> {
  id: T;
  label: string;
}

interface PaneTabsProps<T extends string> {
  tabs: readonly PaneTab<T>[];
  active: T;
  onChange: (id: T) => void;
  /** Accessible name of the tab list. */
  label: string;
  /** Prefix for tab and panel ids: tab `${idPrefix}-tab-${id}`, panel `${idPrefix}-panel-${id}`. */
  idPrefix: string;
}

export const paneTabId = (idPrefix: string, id: string) => `${idPrefix}-tab-${id}`;
export const panePanelId = (idPrefix: string, id: string) => `${idPrefix}-panel-${id}`;

export function PaneTabs<T extends string>({ tabs, active, onChange, label, idPrefix }: PaneTabsProps<T>) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const select = (index: number) => {
    const count = tabs.length;
    const next = ((index % count) + count) % count;
    onChange(tabs[next].id);
    tabRefs.current[next]?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        select(index + 1);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        select(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        select(0);
        break;
      case 'End':
        event.preventDefault();
        select(tabs.length - 1);
        break;
    }
  };

  return (
    <div
      role="tablist"
      aria-label={label}
      aria-orientation="horizontal"
      className="flex h-7 gap-0.5 rounded-[7px] bg-muted p-0.5"
    >
      {tabs.map((tab, index) => {
        const isActive = tab.id === active;
        return (
          <button
            key={tab.id}
            ref={(el) => { tabRefs.current[index] = el; }}
            type="button"
            role="tab"
            id={paneTabId(idPrefix, tab.id)}
            aria-selected={isActive}
            aria-controls={panePanelId(idPrefix, tab.id)}
            tabIndex={isActive ? 0 : -1}
            title={tab.label}
            onClick={() => onChange(tab.id)}
            onKeyDown={(e) => onKeyDown(e, index)}
            className={cn(
              // Sized to its own label, then stretched: equal thirds clipped "Components".
              'flex-auto whitespace-nowrap rounded-[5px] px-2 text-[11.5px] font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
              isActive
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

'use client';
// src/components/appearance/AppearanceMenu.tsx: a small menu button with the interface mode
// for the pages that have no editor menu (the projects home and the signed-out welcome page).
// The icon shows the mode in effect; its name says what it opens.

import React from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import AppearanceItems from './AppearanceItems';

export default function AppearanceMenu() {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        aria-label="Appearance"
        title="Appearance"
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-input bg-card text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:shadow-selection data-[state=open]:bg-accent"
      >
        {/* The icon is chosen by CSS from the attribute the server wrote, so the first paint already shows the
            mode in effect (a hook would show System until hydration). */}
        <Monitor size={15} aria-hidden="true" className="[[data-ui-theme]_&]:hidden" />
        <Sun size={15} aria-hidden="true" className="hidden [[data-ui-theme=light]_&]:block" />
        <Moon size={15} aria-hidden="true" className="hidden [[data-ui-theme=dark]_&]:block" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[13rem]">
        <AppearanceItems />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
// ci-replay touch

'use client';
// src/components/appearance/AppearanceMenu.tsx: a small menu button with the interface mode
// for the pages that have no editor menu (the projects home and the signed-out welcome page).
// The icon shows the mode in effect; its name says what it opens.

import React from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useUiTheme } from '@/lib/uiTheme/client';
import AppearanceItems from './AppearanceItems';

export default function AppearanceMenu() {
  const preference = useUiTheme();
  const Icon = preference === 'light' ? Sun : preference === 'dark' ? Moon : Monitor;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        aria-label="Appearance"
        title="Appearance"
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-input bg-card text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:shadow-selection data-[state=open]:bg-accent"
      >
        <Icon size={15} aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[13rem]">
        <AppearanceItems />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

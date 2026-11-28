'use client';
// src/components/appearance/AppearanceItems.tsx: the interface mode as a group of a menu
// (docs/plans/2026-11-23-sites-home-and-light-mode.md, slice S2). System, Light and Dark as
// radio items, the menu's own pattern for one of several; choosing one keeps the menu open,
// since the page changes behind it and the dot shows the choice in place. Named "this
// browser", because the choice is kept per browser and is not the site's own Theme.

import React from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem } from '@/components/ui/dropdown-menu';
import { setUiTheme, useUiTheme } from '@/lib/uiTheme/client';
import { UI_THEME_PREFERENCES, type UiThemePreference } from '@/lib/uiTheme';

const LABEL: Record<UiThemePreference, string> = { system: 'System', light: 'Light', dark: 'Dark' };
const ICON: Record<UiThemePreference, typeof Sun> = { system: Monitor, light: Sun, dark: Moon };

export default function AppearanceItems() {
  const preference = useUiTheme();
  return (
    <>
      <DropdownMenuLabel>Appearance (this browser)</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={preference} onValueChange={(value) => setUiTheme(value as UiThemePreference)}>
        {UI_THEME_PREFERENCES.map((option) => {
          const Icon = ICON[option];
          return (
            <DropdownMenuRadioItem key={option} value={option} onSelect={(event) => event.preventDefault()}>
              <Icon size={15} aria-hidden="true" /> {LABEL[option]}
            </DropdownMenuRadioItem>
          );
        })}
      </DropdownMenuRadioGroup>
    </>
  );
}
// ci-replay touch

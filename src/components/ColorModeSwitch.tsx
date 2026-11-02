// src/components/ColorModeSwitch.tsx
//
// Light and Dark for a site whose theme mode is `system` (docs/plans/2026-11-02-theme-and-head.md,
// "The mode on the canvas", slice T3). Its visitors see either, so the canvas and the
// preview show one at a time, from EditorUIStore.previewColorMode. A switch writes nothing
// to the project: no undo step, nothing to save. A forced site shows its own mode and a
// site with no choice shows light, so neither gets the switch.
//
// Two toggle buttons in a group, each with aria-pressed, so a keyboard reaches both with
// Tab and presses one with Enter or Space. `tone` matches the bar it sits in.
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import { Moon, Sun } from 'lucide-react';
import { useStore } from '@/hooks/useStore';
import type { ColorScheme } from '@/lib/site/theme';

/** True when the open site's frames have two modes to show. */
export function useHasColorModeSwitch(): boolean {
  const { editorUI } = useStore();
  return editorUI.currentProject?.site?.theme?.mode === 'system';
}

const MODES: { mode: ColorScheme; label: string; Icon: typeof Sun }[] = [
  { mode: 'light', label: 'Light', Icon: Sun },
  { mode: 'dark', label: 'Dark', Icon: Moon },
];

export interface ColorModeSwitchProps {
  tone?: 'light' | 'dark';
  className?: string;
}

const ColorModeSwitch = observer(({ tone = 'light', className = '' }: ColorModeSwitchProps) => {
  const { editorUI } = useStore();
  if (editorUI.currentProject?.site?.theme?.mode !== 'system') return null;
  const current = editorUI.previewColorMode;
  const frame = tone === 'dark' ? 'bg-gray-800 border-gray-700' : 'bg-muted border-border';
  const idle = tone === 'dark' ? 'text-gray-300 hover:bg-gray-700' : 'text-muted-foreground hover:bg-accent hover:text-foreground';
  const pressed = tone === 'dark' ? 'bg-gray-600 text-white' : 'bg-background text-foreground shadow-sm';
  return (
    <div
      role="group"
      aria-label="Colour mode shown"
      title="This site follows each visitor's system. Choose which mode to show here; nothing is saved."
      className={`flex shrink-0 items-center gap-0.5 rounded-md border p-0.5 ${frame} ${className}`}
      data-testid="color-mode-switch"
    >
      {MODES.map(({ mode, label, Icon }) => (
        <button
          key={mode}
          type="button"
          aria-pressed={current === mode}
          onClick={() => editorUI.setPreviewColorMode(mode)}
          className={`flex h-7 items-center gap-1 rounded px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${current === mode ? pressed : idle}`}
        >
          <Icon size={14} aria-hidden="true" />
          <span className="max-md:sr-only">{label}</span>
        </button>
      ))}
    </div>
  );
});

ColorModeSwitch.displayName = 'ColorModeSwitch';
export default ColorModeSwitch;

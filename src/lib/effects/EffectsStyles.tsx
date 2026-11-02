// src/lib/effects/EffectsStyles.tsx
//
// The inline stylesheets the effects need, rendered next to the content they
// style (server and client safe, no hooks). The start-state rules are only
// included when a `scope` attribute selector gates them (the preview frame);
// the published page injects its start-state rules from an inline script
// instead (see publishedEffectsScript), so without JavaScript nothing is
// hidden. Hover presets are not here: they are part of the rule sheet, on the
// preview as on the published page (hoverPresetRules).
import React from 'react';
import { startStateCss } from './effects';
import { LENIS_CSS } from './smoothScroll';

export interface EffectsStylesProps {
  /** Selector prefix that gates the start-state rules, e.g. `[data-fx-on] `; omit to leave them out. */
  startScope?: string;
  /** Include the Lenis rules. */
  smoothScroll?: boolean;
}

export function EffectsStyles({ startScope, smoothScroll = false }: EffectsStylesProps) {
  const css = [
    startScope !== undefined ? startStateCss(startScope) : '',
    smoothScroll ? LENIS_CSS : '',
  ].filter(Boolean).join('\n');
  if (!css) return null;
  // The text is built from constants only: nothing user-authored reaches it.
  return <style data-fc-effects="" dangerouslySetInnerHTML={{ __html: css }} />;
}

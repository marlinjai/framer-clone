// src/lib/effects/EffectsStyles.tsx
//
// The inline stylesheets the effects need, rendered next to the content they
// style (server and client safe, no hooks). The start-state rules are only
// included when a `scope` attribute selector gates them (the preview frame);
// the published page injects its start-state rules from an inline script
// instead (see publishedEffectsScript), so without JavaScript nothing is
// hidden.
import React from 'react';
import { EFFECTS_BASE_CSS, startStateCss } from './effects';
import { LENIS_CSS } from './smoothScroll';

export interface EffectsStylesProps {
  /** Selector prefix that gates the start-state rules, e.g. `[data-fx-on] `; omit to leave them out. */
  startScope?: string;
  /** Include the Lenis rules. */
  smoothScroll?: boolean;
}

export function EffectsStyles({ startScope, smoothScroll = false }: EffectsStylesProps) {
  const css = [
    EFFECTS_BASE_CSS,
    startScope !== undefined ? startStateCss(startScope) : '',
    smoothScroll ? LENIS_CSS : '',
  ].filter(Boolean).join('\n');
  // The text is built from constants only: nothing user-authored reaches it.
  return <style data-fc-effects="" dangerouslySetInnerHTML={{ __html: css }} />;
}

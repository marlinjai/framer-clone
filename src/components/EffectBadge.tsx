// A small badge on the canvas selection when the selected element has an
// effect on the breakpoint being edited. The canvas always shows the final
// state (effects never run there), so this is how the designer sees an effect
// is set; the Effects section's Play button previews it.
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import { Sparkles } from 'lucide-react';
import { useStore } from '@/hooks/useStore';
import type { AppearEffect, HoverKind, ScrollEffect } from '@/lib/effects/effects';
import { APPEAR_LABELS } from '@/components/sidebars/right/sections/EffectsSection';

/** The badge text for one breakpoint's effects, or null when there is none. */
export function effectBadgeText(appear: AppearEffect, hover: HoverKind, scroll: ScrollEffect): string | null {
  const parts: string[] = [];
  if (appear.kind !== 'none') parts.push(APPEAR_LABELS[appear.kind]);
  if (scroll.kind === 'parallax') parts.push('Parallax');
  if (hover !== 'none') parts.push(`Hover ${hover}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

const EffectBadge = observer(() => {
  const { editorUI } = useStore();
  const component = editorUI.selectedComponent;
  if (!component || component.isViewportNode || !component.hasEffects) return null;
  const breakpointId = editorUI.selectedViewportNode?.breakpointId;
  const text = effectBadgeText(
    component.getEffect('appear', breakpointId) as AppearEffect,
    component.getEffect('hover', breakpointId) as HoverKind,
    component.getEffect('scroll', breakpointId) as ScrollEffect,
  );
  if (!text) return null;
  return (
    <div
      data-testid="effect-badge"
      title={`Effects: ${text}. The canvas shows the final state; use Play in the Effects section to preview.`}
      className="absolute -top-6 left-0 flex max-w-[220px] items-center gap-1 truncate rounded bg-brand px-1.5 py-0.5 text-[10px] font-medium text-white shadow-sm"
    >
      <Sparkles size={10} aria-hidden className="flex-none" />
      <span className="truncate">{text}</span>
    </div>
  );
});

EffectBadge.displayName = 'EffectBadge';
export default EffectBadge;

'use client';
// The Effects section: appear on scroll, a restrained hover, and a small
// parallax for images. The model and every limit live in
// src/lib/effects/effects.ts; this section only edits them. Appear and scroll
// are per breakpoint (the source dot and reset work like a style row), hover is
// one value everywhere. The canvas never runs effects: it shows the final
// state, and the Play button previews the appear on the selected element.
import React, { useEffect, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { Play, Sparkles } from 'lucide-react';
import { ComponentInstance } from '@/models/ComponentModel';
import {
  EFFECT_LIMITS,
  normalizeAppear,
  normalizeScroll,
  type AppearEffect,
  type AppearKind,
  type HoverKind,
  type ScrollEffect,
} from '@/lib/effects/effects';
import { canvasElementsOf, playAppear } from '@/lib/effects/play';
import { prefersReducedMotion } from '@/lib/effects/runtime';
import { cn } from '@/lib/utils';
import { DimensionInput, PropertyRow, PropertySelect, PropertySwitch } from '../primitives';
import { CollapsibleSection } from '../primitives/CollapsibleSection';
import { effectSource } from '../breakpointSource';
import { getComponentCategory } from '../sectionConfig';

const APPEAR_OPTIONS: { value: AppearKind; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'fade', label: 'Fade in' },
  { value: 'slide-up', label: 'Slide up' },
  { value: 'slide-left', label: 'Slide from left' },
  { value: 'slide-right', label: 'Slide from right' },
  { value: 'scale', label: 'Scale in' },
];

const SLIDES: ReadonlySet<AppearKind> = new Set(['slide-up', 'slide-left', 'slide-right']);

/** Every kind label, for the canvas badge and the section badge. */
export const APPEAR_LABELS: Record<AppearKind, string> = Object.fromEntries(
  APPEAR_OPTIONS.map(o => [o.value, o.label]),
) as Record<AppearKind, string>;

interface EffectsSectionProps {
  component: ComponentInstance;
  breakpointId?: string;
}

/** A whole number from a field's text, or undefined when it holds none. */
function parseMs(text: string): number | undefined {
  const n = parseFloat(text);
  return Number.isFinite(n) ? n : undefined;
}

/** The hover kinds an element offers: underline only for links, lift not with a parallax (both move it). */
export function hoverOptionsFor(type: string, hasParallax: boolean): { value: HoverKind; label: string }[] {
  const options: { value: HoverKind; label: string }[] = [{ value: 'none', label: 'None' }];
  if (!hasParallax) options.push({ value: 'lift', label: 'Lift' });
  options.push({ value: 'dim', label: 'Dim' });
  if (type === 'a') options.push({ value: 'underline', label: 'Underline' });
  return options;
}

export const EffectsSection = observer(({ component, breakpointId }: EffectsSectionProps) => {
  const appear = component.getEffect('appear', breakpointId) as AppearEffect;
  const hover = component.getEffect('hover', breakpointId) as HoverKind;
  const scroll = component.getEffect('scroll', breakpointId) as ScrollEffect;
  const isImage = getComponentCategory(component) === 'image';
  const hasChildren = component.children.length > 0;

  // Read after mount: the media query is a browser fact, not server state.
  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => {
    setReducedMotion(prefersReducedMotion());
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReducedMotion(query.matches);
    query.addEventListener?.('change', onChange);
    return () => query.removeEventListener?.('change', onChange);
  }, []);

  const setAppear = (patch: Partial<AppearEffect>) =>
    component.setEffect('appear', normalizeAppear({ ...appear, ...patch }), breakpointId);
  const setScroll = (patch: Partial<ScrollEffect>) =>
    component.setEffect('scroll', normalizeScroll({ ...scroll, ...patch }), breakpointId);

  const hoverOptions = hoverOptionsFor(component.type, scroll.kind === 'parallax');
  const { distance, duration, delay, stagger, parallax } = EFFECT_LIMITS;
  const active = appear.kind !== 'none' || hover !== 'none' || scroll.kind !== 'none';

  const play = () => {
    playAppear(canvasElementsOf(component.id, breakpointId), appear);
  };

  return (
    <CollapsibleSection
      title="Effects"
      icon={<Sparkles size={14} />}
      defaultOpen={component.hasEffects}
      badge={active ? (appear.kind !== 'none' ? APPEAR_LABELS[appear.kind] : 'On') : undefined}
    >
      <PropertyRow label="Appear" source={effectSource(component, breakpointId, 'appear')} hint="Plays once when the element scrolls into view">
        <PropertySelect
          label=""
          value={appear.kind}
          onChange={(v) => setAppear({ kind: v as AppearKind })}
          options={APPEAR_OPTIONS}
        />
      </PropertyRow>

      {appear.kind !== 'none' && (
        <>
          {SLIDES.has(appear.kind) && (
            <PropertyRow label="Distance" hint={`How far it travels, ${distance.min} to ${distance.max}px`}>
              <DimensionInput
                label=""
                value={appear.distance}
                units={['px']}
                min={distance.min}
                max={distance.max}
                placeholder={String(distance.default)}
                onChange={(v) => setAppear({ distance: parseMs(v) ?? distance.default })}
              />
            </PropertyRow>
          )}
          <PropertyRow label="Duration" hint={`In milliseconds, ${duration.min} to ${duration.max}. Keep reveals short.`}>
            <DimensionInput
              label=""
              value={appear.duration}
              units={['']}
              min={duration.min}
              max={duration.max}
              step={10}
              prefix="ms"
              placeholder={String(duration.default)}
              onChange={(v) => setAppear({ duration: parseMs(v) ?? duration.default })}
            />
          </PropertyRow>
          <PropertyRow label="Delay" hint={`Wait after it comes into view, in milliseconds, up to ${delay.max}`}>
            <DimensionInput
              label=""
              value={appear.delay}
              units={['']}
              min={delay.min}
              max={delay.max}
              step={10}
              prefix="ms"
              placeholder="0"
              onChange={(v) => setAppear({ delay: parseMs(v) ?? 0 })}
            />
          </PropertyRow>
          {hasChildren && (
            <PropertyRow label="Stagger" hint="Reveal the children one after another instead of the whole element">
              <PropertySwitch
                checked={appear.stagger > 0}
                onCheckedChange={(on) => setAppear({ stagger: on ? stagger.default : 0 })}
              />
            </PropertyRow>
          )}
          {hasChildren && appear.stagger > 0 && (
            <PropertyRow label="Step" hint={`Time between two children, ${stagger.min} to ${stagger.max}ms`}>
              <DimensionInput
                label=""
                value={appear.stagger}
                units={['']}
                min={stagger.min}
                max={stagger.max}
                step={5}
                prefix="ms"
                placeholder={String(stagger.default)}
                onChange={(v) => setAppear({ stagger: parseMs(v) ?? stagger.default })}
              />
            </PropertyRow>
          )}
          <div className="grid grid-cols-[64px_minmax(0,1fr)] items-center gap-2">
            <span />
            <button
              type="button"
              onClick={play}
              disabled={reducedMotion}
              title={reducedMotion
                ? 'Your system asks for reduced motion, so effects do not play here or on the site.'
                : 'Play the appear effect on the canvas'}
              className={cn(
                'flex h-7 items-center justify-center gap-1.5 rounded-md border border-border text-[11px] text-foreground',
                'hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
            >
              <Play size={12} aria-hidden />
              Play
            </button>
          </div>
        </>
      )}

      <PropertyRow label="Hover" hint="A small response to the pointer; touch screens have no hover">
        <PropertySelect
          label=""
          value={hoverOptions.some(o => o.value === hover) ? hover : 'none'}
          onChange={(v) => component.setEffect('hover', v as HoverKind, breakpointId)}
          options={hoverOptions}
        />
      </PropertyRow>

      {isImage && (
        <>
          <PropertyRow label="Scroll" source={effectSource(component, breakpointId, 'scroll')} hint="The image moves slightly slower than the page">
            <PropertySelect
              label=""
              value={scroll.kind}
              onChange={(v) => {
                setScroll({ kind: v as ScrollEffect['kind'] });
                // A parallax and a lift both move the element: the parallax wins.
                if (v === 'parallax' && hover === 'lift') component.setEffect('hover', 'none', breakpointId);
              }}
              options={[
                { value: 'none', label: 'None' },
                { value: 'parallax', label: 'Parallax' },
              ]}
            />
          </PropertyRow>
          {scroll.kind === 'parallax' && (
            <PropertyRow label="Strength" hint={`The largest shift, ${parallax.min} to ${parallax.max}px`}>
              <DimensionInput
                label=""
                value={scroll.strength}
                units={['px']}
                min={parallax.min}
                max={parallax.max}
                placeholder={String(parallax.default)}
                onChange={(v) => setScroll({ strength: parseMs(v) ?? parallax.default })}
              />
            </PropertyRow>
          )}
        </>
      )}
    </CollapsibleSection>
  );
});

EffectsSection.displayName = 'EffectsSection';

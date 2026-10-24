'use client';
// src/components/sidebars/right/sections/ImageSection.tsx
//
// The properties panel's Image section: fix a photo's crop by hand.
//
//   - An img: Fit (object-fit) and the focal point (object-position), set by
//     clicking or dragging on a thumbnail of the image, with the arrow keys on
//     it, or as numeric x / y percentages.
//   - A container: its photo background, stored as the url() layer of
//     backgroundImage under an optional overlay (the scrim that keeps text on
//     the photo readable): the image URL, Size (background-size), the focal
//     point (background-position) and the overlay strength.
//
// An img also gets its alt text here, with a Decorative switch (alt "" on
// purpose) and a warning when the alt is missing or generic ("Image", a file
// name): the same rule the page generator's essentials screen applies
// (src/lib/ai/pageGen/essentials.ts), so an owner sees what a screen reader
// would announce.
//
// The AI page generator writes the same keys (src/lib/ai/pageGen/stockImages.ts),
// so a generated crop can be corrected here. Every value is responsive-aware
// like the other sections (getResponsiveStyleValue / updateResponsiveStyle).
// Pointing a container at a different picture drops a stock photo's credit,
// exactly like the img's Image URL field (src/lib/ai/pageGen/stockCredit.ts).

import React, { useEffect, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { Crop } from 'lucide-react';
import { ComponentInstance } from '@/models/ComponentModel';
import { CONTAINER_TYPES } from '../sectionConfig';
import { CollapsibleSection, DimensionInput, FieldPair, PropertyRow, PropertySelect, PropertySlider, PropertySwitch, TextInput } from '../primitives';
import { altProblem, isDecorativeImage, type AltProblem } from '@/lib/ai/pageGen/essentials';
import { DECORATIVE_ATTR } from '@/lib/ai/pageGen/schema';
import {
  formatFocalPosition,
  parseFocalPosition,
  photoUrlOf,
  scrimStrengthOf,
  withPhotoUrl,
  withScrimStrength,
  type FocalPoint,
} from '@/lib/images/imageStyle';
import { hasStockCredit, isSameUnsplashPhoto } from '@/lib/ai/pageGen/stockCredit';
import { breakpointLabel, styleSource, type BreakpointSourceInfo } from '../breakpointSource';
import { BreakpointSourceDot } from '../primitives/BreakpointSourceDot';

const FIT_OPTIONS = [
  { value: 'cover', label: 'Cover (crop to fill)' },
  { value: 'contain', label: 'Contain (whole image)' },
  { value: 'fill', label: 'Fill (stretch)' },
];

const SIZE_OPTIONS = [
  { value: 'cover', label: 'Cover (crop to fill)' },
  { value: 'contain', label: 'Contain (whole image)' },
  { value: 'auto', label: 'Original size' },
];

/** Overlay strengths above this make a photo unreadable as a photo. */
const MAX_SCRIM = 0.9;

// The panel's row layout and field look (the shared PropertyRow and field.ts
// primitives): a 64px label column, a minmax(0, 1fr) field, 28px fields with
// radius 6 and 12px values.
const ROW = 'grid grid-cols-[64px_minmax(0,1fr)] items-center gap-2';
const ROW_TOP = 'grid grid-cols-[64px_minmax(0,1fr)] items-start gap-2';
const LABEL = 'text-muted-foreground truncate';
const LABEL_STYLE = { fontSize: '11.5px' } as const;
const FIELD =
  'h-[28px] w-full min-w-0 bg-background border border-border rounded-[6px] px-2 text-foreground outline-none focus:border-brand focus:ring-3 focus:ring-brand/12';
const FIELD_STYLE = { fontSize: '12px' } as const;

function Row({ label, htmlFor, top, source, children }: {
  label: string;
  htmlFor?: string;
  top?: boolean;
  /** Where the value comes from on this breakpoint (the dot before the label). */
  source?: BreakpointSourceInfo;
  children: React.ReactNode;
}) {
  return (
    <div className={top ? ROW_TOP : ROW}>
      <div className={`relative min-w-0${top ? ' pt-[7px]' : ''}`}>
        {/* A top-aligned row centres the dot on the label line, not the whole cell. */}
        <div className={top ? 'absolute inset-x-0 top-[7px] h-[14px]' : 'contents'}>
          <BreakpointSourceDot source={source} />
        </div>
        <label className={`${LABEL} block`} style={LABEL_STYLE} htmlFor={htmlFor}>
          {label}
        </label>
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

interface ImageSectionProps {
  component: ComponentInstance;
  breakpointId?: string;
}

/** The focal point under a pointer, in percent of the image's box. */
export function focalPointAt(rect: { left: number; top: number; width: number; height: number }, clientX: number, clientY: number): FocalPoint {
  const pct = (offset: number, size: number) => (size > 0 ? Math.min(100, Math.max(0, (offset / size) * 100)) : 50);
  return { x: Math.round(pct(clientX - rect.left, rect.width)), y: Math.round(pct(clientY - rect.top, rect.height)) };
}

interface FocalPointPickerProps {
  src: string | undefined;
  point: FocalPoint;
  onChange: (point: FocalPoint) => void;
}

/**
 * A thumbnail of the whole image with a crosshair at the focal point. Click or
 * drag to move it (committed on release, so one move is one undo step); the
 * arrow keys move it by 1% (Shift: 10%).
 */
function FocalPointPicker({ src, point, onChange }: FocalPointPickerProps) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [drag, setDrag] = useState<FocalPoint | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  const shown = drag ?? point;

  const at = (e: React.PointerEvent): FocalPoint | null => {
    const rect = imgRef.current?.getBoundingClientRect();
    return rect ? focalPointAt(rect, e.clientX, e.clientY) : null;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 1;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const move = moves[e.key];
    if (!move) return;
    e.preventDefault();
    const clamp = (n: number) => Math.min(100, Math.max(0, n));
    onChange({ x: clamp(Math.round(point.x) + move[0]), y: clamp(Math.round(point.y) + move[1]) });
  };

  if (!src || failed) {
    return (
      <p className="text-muted-foreground" style={{ fontSize: '11px' }}>
        {src ? 'The image could not be loaded for a preview. Set the focal point with X and Y.' : 'No image to preview. Set the focal point with X and Y.'}
      </p>
    );
  }

  return (
    <div
      role="group"
      tabIndex={0}
      aria-label={`Focal point, ${Math.round(shown.x)}% from the left, ${Math.round(shown.y)}% from the top. Click the image or use the arrow keys to move it.`}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => {
        const p = at(e);
        if (!p) return;
        e.currentTarget.setPointerCapture?.(e.pointerId);
        setDrag(p);
      }}
      onPointerMove={(e) => {
        if (!drag) return;
        const p = at(e);
        if (p) setDrag(p);
      }}
      onPointerUp={(e) => {
        const p = at(e) ?? drag;
        setDrag(null);
        if (p) onChange(p);
      }}
      onPointerCancel={() => setDrag(null)}
      className="relative w-full cursor-crosshair select-none overflow-hidden rounded-[6px] border border-border bg-muted outline-none focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-brand/12"
      data-testid="focal-point-picker"
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- a plain preview of an arbitrary URL */}
      <img
        ref={imgRef}
        src={src}
        alt=""
        draggable={false}
        onError={() => setFailed(true)}
        className="block h-auto w-full"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.6),0_1px_4px_rgba(0,0,0,0.5)]"
        style={{ left: `${shown.x}%`, top: `${shown.y}%` }}
      >
        <span className="absolute left-1/2 top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white" />
      </span>
    </div>
  );
}

interface FocalControlsProps {
  src: string | undefined;
  value: unknown;
  onChange: (position: string) => void;
  /** Where the position comes from on this breakpoint. */
  source?: BreakpointSourceInfo;
}

/** The picker plus numeric X / Y, reading and writing one position value. */
function FocalControls({ src, value, onChange, source }: FocalControlsProps) {
  const point = parseFocalPosition(value);
  const set = (next: FocalPoint) => onChange(formatFocalPosition(next));
  const axis = (key: 'x' | 'y') => (raw: string) => {
    const n = parseFloat(raw);
    if (Number.isFinite(n)) set({ ...point, [key]: n });
  };
  return (
    <>
      <Row label="Focus" top source={source}>
        <FocalPointPicker src={src} point={point} onChange={set} />
      </Row>
      <PropertyRow label="Focus position" group source={source}>
        <FieldPair>
          <DimensionInput label="" prefix="X" aria-label="Focus X" value={`${Math.round(point.x)}%`} onChange={axis('x')} units={['%']} min={0} max={100} placeholder="50" />
          <DimensionInput label="" prefix="Y" aria-label="Focus Y" value={`${Math.round(point.y)}%`} onChange={axis('y')} units={['%']} min={0} max={100} placeholder="50" />
        </FieldPair>
      </PropertyRow>
    </>
  );
}

const ALT_WARNINGS: Record<AltProblem, string> = {
  missing: 'No alt text: screen readers cannot describe this image. Say what it shows, or mark it decorative.',
  generic: 'A generic alt text tells screen readers nothing. Say what the image shows.',
  'file name': 'The alt text is a file name. Say what the image shows.',
  'layer name': 'The alt text repeats the layer name. Say what the image shows.',
};

/** The img's alt text, the Decorative switch, and the warning when the alt says nothing. */
export const AltTextControls = observer(({ component }: { component: ComponentInstance }) => {
  const props = component.props as Record<string, unknown>;
  const decorative = isDecorativeImage({ props });
  const alt = typeof props.alt === 'string' ? props.alt : '';
  const problem = altProblem({ type: component.type, label: component.label ?? '', props });
  return (
    <>
      <PropertyRow label="Decorative" hint="Purely decorative images are skipped by screen readers (empty alt text)">
        <PropertySwitch
          checked={decorative}
          onCheckedChange={(on) =>
            component.setProps(on ? { alt: '', [DECORATIVE_ATTR]: 'true' } : { [DECORATIVE_ATTR]: undefined })
          }
        />
      </PropertyRow>
      {!decorative && (
        <PropertyRow label="Alt text" hint="What the image shows, for screen readers and search engines">
          <TextInput
            value={alt}
            maxLength={300}
            placeholder="Two baristas pouring latte art"
            aria-invalid={problem ? true : undefined}
            onChange={(e) => component.setProps({ alt: e.target.value })}
          />
        </PropertyRow>
      )}
      {problem && (
        <p role="status" data-testid="alt-warning" className="text-[11px] leading-snug text-amber-600 dark:text-amber-400">
          {ALT_WARNINGS[problem]}
        </p>
      )}
    </>
  );
});
AltTextControls.displayName = 'AltTextControls';

export const ImageSection = observer(({ component, breakpointId }: ImageSectionProps) => {
  const getStyleValue = (prop: string) => component.getResponsiveStyleValue(prop, breakpointId);
  const setStyleValue = (prop: string, value: string | number) => component.updateResponsiveStyle(prop, value, breakpointId);
  // Where each row's value comes from on this breakpoint (the dot before the label).
  const src = (...props: string[]) => styleSource(component, breakpointId, props);
  const badge = breakpointLabel(component, breakpointId);

  if (component.type === 'img') {
    const imageSrc = typeof component.props?.src === 'string' ? (component.props.src as string) : undefined;
    return (
      <CollapsibleSection title="Image" icon={<Crop size={14} />} badge={badge}>
        <Row label="Fit" source={src('objectFit')}>
          <PropertySelect
            label=""
            value={getStyleValue('objectFit') || 'fill'}
            onChange={(v) => setStyleValue('objectFit', v)}
            options={FIT_OPTIONS}
          />
        </Row>
        <FocalControls
          src={imageSrc}
          value={getStyleValue('objectPosition')}
          onChange={(v) => setStyleValue('objectPosition', v)}
          source={src('objectPosition')}
        />
        <AltTextControls component={component} />
      </CollapsibleSection>
    );
  }

  if (!CONTAINER_TYPES.has(component.type)) return null;

  const background = getStyleValue('backgroundImage');
  const photoUrl = photoUrlOf(background);
  const scrim = scrimStrengthOf(background);

  const setPhotoUrl = (next: string) => {
    const previous = photoUrlOf(background);
    setStyleValue('backgroundImage', withPhotoUrl(background, next));
    if (next.trim() && !previous) {
      // A first photo: fill the box with it instead of tiling it.
      if (!getStyleValue('backgroundSize')) setStyleValue('backgroundSize', 'cover');
      if (!getStyleValue('backgroundRepeat')) setStyleValue('backgroundRepeat', 'no-repeat');
    }
    // A different picture no longer matches a stock photo's credit (an empty
    // field mid-edit or the same photo's size parameters keep it).
    if (next.trim() && hasStockCredit(component.props) && !isSameUnsplashPhoto(previous, next)) {
      component.clearStockCredit();
    }
  };

  return (
    <CollapsibleSection title="Background image" icon={<Crop size={14} />} badge={badge}>
      <Row label="Image" htmlFor={`bg-url-${component.id}`} source={src('backgroundImage')}>
        <input
          id={`bg-url-${component.id}`}
          type="text"
          value={photoUrl ?? ''}
          onChange={(e) => setPhotoUrl(e.target.value)}
          className={FIELD}
          style={FIELD_STYLE}
          placeholder="https://example.com/photo.jpg"
        />
      </Row>
      {photoUrl && (
        <>
          <Row label="Size" source={src('backgroundSize')}>
            <PropertySelect
              label=""
              value={getStyleValue('backgroundSize') || 'auto'}
              onChange={(v) => setStyleValue('backgroundSize', v)}
              options={SIZE_OPTIONS}
            />
          </Row>
          <FocalControls
            src={photoUrl}
            value={getStyleValue('backgroundPosition')}
            onChange={(v) => setStyleValue('backgroundPosition', v)}
            source={src('backgroundPosition')}
          />
          <Row label="Overlay" source={src('backgroundImage')}>
            <PropertySlider
              label=""
              value={scrim ?? 0}
              onChange={(v) => setStyleValue('backgroundImage', withScrimStrength(background, Math.min(MAX_SCRIM, v)))}
              min={0}
              max={MAX_SCRIM}
              step={0.05}
              displayMultiplier={100}
              suffix="%"
            />
          </Row>
          {scrim === undefined && (
            <p className="text-muted-foreground" style={{ fontSize: '11px' }}>
              The overlay is a custom gradient; moving the slider replaces it with an even one.
            </p>
          )}
        </>
      )}
    </CollapsibleSection>
  );
});

ImageSection.displayName = 'ImageSection';

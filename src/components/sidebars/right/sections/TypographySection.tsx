'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import { Type, AlignLeft, AlignCenter, AlignRight, AlignJustify } from 'lucide-react';
import { ComponentInstance } from '@/models/ComponentModel';
import {
  CollapsibleSection,
  DimensionInput,
  PropertyRow,
  PropertySelect,
  ToggleIconGroup,
} from '../primitives';
import { styleSource } from '../breakpointSource';
import { FontFamilySelect } from '../primitives/FontFamilySelect';

const FONT_WEIGHT_OPTIONS = [
  { value: '100', label: 'Thin (100)' },
  { value: '200', label: 'Extra Light (200)' },
  { value: '300', label: 'Light (300)' },
  { value: '400', label: 'Regular (400)' },
  { value: '500', label: 'Medium (500)' },
  { value: '600', label: 'Semibold (600)' },
  { value: '700', label: 'Bold (700)' },
  { value: '800', label: 'Extra Bold (800)' },
  { value: '900', label: 'Black (900)' },
];

interface TypographySectionProps {
  component: ComponentInstance;
  breakpointId?: string;
}

export const TypographySection = observer(({ component, breakpointId }: TypographySectionProps) => {
  const getStyleValue = (prop: string) => component.getResponsiveStyleValue(prop, breakpointId);
  const setStyleValue = (prop: string, value: string) => component.updateResponsiveStyle(prop, value, breakpointId);
  // Where each row's value comes from on this breakpoint (the dot before the label).
  const src = (...props: string[]) => styleSource(component, breakpointId, props);

  return (
    <CollapsibleSection
      title="Typography"
      icon={<Type size={14} />}
    >
      <PropertyRow label="Font" source={src('fontFamily')}>
        {/* The self-hosted font library (src/lib/fonts/registry.ts), grouped by category. */}
        <FontFamilySelect
          value={getStyleValue('fontFamily')}
          onChange={(v) => setStyleValue('fontFamily', v)}
        />
      </PropertyRow>

      <PropertyRow label="Size" source={src('fontSize')} hint="Font size">
        <DimensionInput
          label=""
          value={getStyleValue('fontSize')}
          onChange={(v) => setStyleValue('fontSize', v)}
          units={['px', 'rem', 'em']}
          placeholder="16"
          min={1}
          step={1}
        />
      </PropertyRow>

      <PropertyRow label="Weight" source={src('fontWeight')} hint="Font weight">
        <PropertySelect
          label=""
          value={getStyleValue('fontWeight') || '400'}
          onChange={(v) => setStyleValue('fontWeight', v)}
          options={FONT_WEIGHT_OPTIONS}
        />
      </PropertyRow>

      <PropertyRow label="Line height" source={src('lineHeight')}>
        <DimensionInput
          label=""
          value={getStyleValue('lineHeight')}
          onChange={(v) => setStyleValue('lineHeight', v)}
          units={['', 'px', 'em', '%']}
          min={0}
          step={0.1}
          placeholder="1.5"
        />
      </PropertyRow>

      <PropertyRow label="Spacing" source={src('letterSpacing')} hint="Letter spacing">
        <DimensionInput
          label=""
          value={getStyleValue('letterSpacing')}
          onChange={(v) => setStyleValue('letterSpacing', v)}
          units={['px', 'em']}
          step={0.1}
          placeholder="0"
        />
      </PropertyRow>

      <PropertyRow label="Align" source={src('textAlign')}>
        <ToggleIconGroup
          label=""
          value={getStyleValue('textAlign') || 'left'}
          onChange={(v) => setStyleValue('textAlign', v)}
          options={[
            { value: 'left', icon: <AlignLeft size={13} />, tooltip: 'Left' },
            { value: 'center', icon: <AlignCenter size={13} />, tooltip: 'Center' },
            { value: 'right', icon: <AlignRight size={13} />, tooltip: 'Right' },
            { value: 'justify', icon: <AlignJustify size={13} />, tooltip: 'Justify' },
          ]}
        />
      </PropertyRow>

      <PropertyRow label="Decoration" source={src('textDecoration')}>
        <ToggleIconGroup
          label=""
          value={getStyleValue('textDecoration') || 'none'}
          onChange={(v) => setStyleValue('textDecoration', v)}
          options={[
            { value: 'none', icon: <span>None</span>, tooltip: 'None' },
            { value: 'underline', icon: <span className="underline">U</span>, tooltip: 'Underline' },
            { value: 'line-through', icon: <span className="line-through">S</span>, tooltip: 'Strikethrough' },
          ]}
        />
      </PropertyRow>
    </CollapsibleSection>
  );
});

TypographySection.displayName = 'TypographySection';

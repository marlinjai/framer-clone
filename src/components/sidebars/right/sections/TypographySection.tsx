'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import { Type, AlignLeft, AlignCenter, AlignRight, AlignJustify } from 'lucide-react';
import { ComponentInstance } from '@/models/ComponentModel';
import {
  CollapsibleSection,
  PropertySelect,
  DimensionInput,
  ToggleIconGroup
} from '../primitives';

const FONT_FAMILY_OPTIONS = [
  { value: 'inherit', label: 'Inherit' },
  { value: 'Inter, sans-serif', label: 'Inter' },
  { value: 'Arial, sans-serif', label: 'Arial' },
  { value: 'Georgia, serif', label: 'Georgia' },
  { value: "'Courier New', monospace", label: 'Courier New' },
  { value: 'system-ui, sans-serif', label: 'System UI' },
];

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

  return (
    <CollapsibleSection
      title="Typography"
      icon={<Type size={14} />}
    >
      {/* Font Family on field grid */}
      <div className="grid grid-cols-[64px_1fr] items-center gap-2">
        <label className="text-muted-foreground" style={{ fontSize: '11.5px' }}>Font</label>
        <PropertySelect
          label=""
          value={getStyleValue('fontFamily') || 'inherit'}
          onChange={(v) => setStyleValue('fontFamily', v)}
          options={FONT_FAMILY_OPTIONS}
        />
      </div>

      {/* Font Size + Weight: two-up */}
      <div className="grid grid-cols-2 gap-2">
        <DimensionInput
          label="Size"
          value={getStyleValue('fontSize')}
          onChange={(v) => setStyleValue('fontSize', v)}
          units={['px', 'rem', 'em']}
          placeholder="16"
          min={1}
          step={1}
        />
        <PropertySelect
          label="Weight"
          value={getStyleValue('fontWeight') || '400'}
          onChange={(v) => setStyleValue('fontWeight', v)}
          options={FONT_WEIGHT_OPTIONS}
        />
      </div>

      {/* Line Height + Letter Spacing: two-up */}
      <div className="grid grid-cols-2 gap-2">
        <DimensionInput
          label="Line H"
          value={getStyleValue('lineHeight')}
          onChange={(v) => setStyleValue('lineHeight', v)}
          units={['px', 'em', '%']}
          placeholder="1.5"
        />
        <DimensionInput
          label="Spacing"
          value={getStyleValue('letterSpacing')}
          onChange={(v) => setStyleValue('letterSpacing', v)}
          units={['px', 'em']}
          placeholder="0"
        />
      </div>

      {/* Text Align */}
      <ToggleIconGroup
        label="Align"
        value={getStyleValue('textAlign') || 'left'}
        onChange={(v) => setStyleValue('textAlign', v)}
        options={[
          { value: 'left', icon: <AlignLeft size={12} />, tooltip: 'Left' },
          { value: 'center', icon: <AlignCenter size={12} />, tooltip: 'Center' },
          { value: 'right', icon: <AlignRight size={12} />, tooltip: 'Right' },
          { value: 'justify', icon: <AlignJustify size={12} />, tooltip: 'Justify' },
        ]}
      />

      {/* Text Decoration */}
      <ToggleIconGroup
        label="Decoration"
        value={getStyleValue('textDecoration') || 'none'}
        onChange={(v) => setStyleValue('textDecoration', v)}
        options={[
          { value: 'none', icon: <span style={{ fontSize: '10px' }}>None</span>, tooltip: 'None' },
          { value: 'underline', icon: <span style={{ fontSize: '10px', textDecoration: 'underline' }}>U</span>, tooltip: 'Underline' },
          { value: 'line-through', icon: <span style={{ fontSize: '10px', textDecoration: 'line-through' }}>S</span>, tooltip: 'Strikethrough' },
        ]}
      />
    </CollapsibleSection>
  );
});

TypographySection.displayName = 'TypographySection';

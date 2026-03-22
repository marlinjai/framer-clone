'use client';
import React, { useState } from 'react';
import { observer } from 'mobx-react-lite';
import { Paintbrush, ChevronDown, ChevronRight } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { ComponentInstance } from '@/models/ComponentModel';
import {
  CollapsibleSection,
  ColorInput,
  PropertySlider,
  PropertySelect,
  DimensionInput
} from '../primitives';

const OVERFLOW_OPTIONS = [
  { value: 'visible', label: 'Visible' },
  { value: 'hidden', label: 'Hidden' },
  { value: 'scroll', label: 'Scroll' },
  { value: 'auto', label: 'Auto' },
];

interface StylesSectionProps {
  component: ComponentInstance;
  breakpointId?: string;
}

export const StylesSection = observer(({ component, breakpointId }: StylesSectionProps) => {
  const [showCorners, setShowCorners] = useState(false);
  const [showBorder, setShowBorder] = useState(false);
  const [hiddenPrevDisplay, setHiddenPrevDisplay] = useState<string | null>(null);

  const getStyleValue = (prop: string) => component.getResponsiveStyleValue(prop, breakpointId);
  const setStyleValue = (prop: string, value: string | number) => component.updateResponsiveStyle(prop, value, breakpointId);

  const currentDisplay = getStyleValue('display');
  const opacity = parseFloat(getStyleValue('opacity') ?? '1') || 1;
  const isVisible = currentDisplay !== 'none';

  return (
    <CollapsibleSection
      title="Styles"
      icon={<Paintbrush size={12} />}
      badge={breakpointId ? 'Responsive' : undefined}
    >
      {/* Opacity */}
      <PropertySlider
        label="Opacity"
        value={opacity}
        onChange={(v) => setStyleValue('opacity', v)}
        min={0}
        max={1}
        step={0.01}
        displayMultiplier={100}
        suffix="%"
      />

      {/* Visibility toggle */}
      <div className="flex items-center justify-between">
        <label className="text-[11px] text-gray-500">Visible</label>
        <Switch
          checked={isVisible}
          onCheckedChange={(checked) => {
            if (!checked) {
              // Store the current display value before hiding
              setHiddenPrevDisplay(currentDisplay && currentDisplay !== 'none' ? currentDisplay : null);
              setStyleValue('display', 'none');
            } else {
              // Restore previous display value (flex, grid, etc.) or clear to default
              setStyleValue('display', hiddenPrevDisplay || '');
              setHiddenPrevDisplay(null);
            }
          }}
        />
      </div>

      {/* Background Color */}
      <ColorInput
        label="Fill (Background)"
        value={getStyleValue('backgroundColor') || '#ffffff'}
        onChange={(v) => setStyleValue('backgroundColor', v)}
      />

      {/* Text Color (hidden for img) */}
      {component.type !== 'img' && (
        <ColorInput
          label="Text Color"
          value={getStyleValue('color') || '#000000'}
          onChange={(v) => setStyleValue('color', v)}
        />
      )}

      {/* Overflow */}
      <PropertySelect
        label="Overflow"
        value={getStyleValue('overflow') || 'visible'}
        onChange={(v) => setStyleValue('overflow', v)}
        options={OVERFLOW_OPTIONS}
      />

      {/* Border Radius */}
      <DimensionInput
        label="Border Radius"
        value={getStyleValue('borderRadius')}
        onChange={(v) => setStyleValue('borderRadius', v)}
        units={['px', '%']}
        placeholder="0"
      />

      {/* Individual corners toggle */}
      <button
        onClick={() => setShowCorners(!showCorners)}
        className="flex items-center gap-1 text-[10px] text-gray-400 hover:text-gray-600"
      >
        {showCorners ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        Individual corners
      </button>
      {showCorners && (
        <div className="grid grid-cols-2 gap-2">
          <DimensionInput label="TL" value={getStyleValue('borderTopLeftRadius')} onChange={(v) => setStyleValue('borderTopLeftRadius', v)} units={['px', '%']} placeholder="0" />
          <DimensionInput label="TR" value={getStyleValue('borderTopRightRadius')} onChange={(v) => setStyleValue('borderTopRightRadius', v)} units={['px', '%']} placeholder="0" />
          <DimensionInput label="BL" value={getStyleValue('borderBottomLeftRadius')} onChange={(v) => setStyleValue('borderBottomLeftRadius', v)} units={['px', '%']} placeholder="0" />
          <DimensionInput label="BR" value={getStyleValue('borderBottomRightRadius')} onChange={(v) => setStyleValue('borderBottomRightRadius', v)} units={['px', '%']} placeholder="0" />
        </div>
      )}

      {/* Border */}
      <button
        onClick={() => setShowBorder(!showBorder)}
        className="flex items-center gap-1 text-[10px] text-gray-400 hover:text-gray-600"
      >
        {showBorder ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        Border
      </button>
      {showBorder && (
        <div className="space-y-2">
          <DimensionInput
            label="Border Width"
            value={getStyleValue('borderWidth')}
            onChange={(v) => setStyleValue('borderWidth', v)}
            units={['px']}
            placeholder="0"
          />
          <PropertySelect
            label="Border Style"
            value={getStyleValue('borderStyle') || 'none'}
            onChange={(v) => setStyleValue('borderStyle', v)}
            options={[
              { value: 'none', label: 'None' },
              { value: 'solid', label: 'Solid' },
              { value: 'dashed', label: 'Dashed' },
              { value: 'dotted', label: 'Dotted' },
            ]}
          />
          <ColorInput
            label="Border Color"
            value={getStyleValue('borderColor') || '#000000'}
            onChange={(v) => setStyleValue('borderColor', v)}
          />
        </div>
      )}

      {/* Box Shadow placeholder */}
      <div className="space-y-1">
        <label className="text-[11px] text-gray-500">Box Shadow</label>
        <Input
          value={getStyleValue('boxShadow') || ''}
          onChange={(e) => setStyleValue('boxShadow', e.target.value)}
          className="h-7 text-xs"
          placeholder="0 2px 4px rgba(0,0,0,0.1)"
        />
      </div>
    </CollapsibleSection>
  );
});

StylesSection.displayName = 'StylesSection';

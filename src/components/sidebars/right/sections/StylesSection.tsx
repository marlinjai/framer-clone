'use client';
import React, { useState } from 'react';
import { observer } from 'mobx-react-lite';
import { Paintbrush, ChevronDown, ChevronRight } from 'lucide-react';
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
      icon={<Paintbrush size={14} />}
      badge={breakpointId ? 'Responsive' : undefined}
    >
      {/* Opacity: field grid with slider + 52px input */}
      <div className="grid grid-cols-[64px_1fr] items-center gap-2">
        <label className="text-muted-foreground" style={{ fontSize: '11.5px' }}>Opacity</label>
        <PropertySlider
          label=""
          value={opacity}
          onChange={(v) => setStyleValue('opacity', v)}
          min={0}
          max={1}
          step={0.01}
          displayMultiplier={100}
          suffix="%"
        />
      </div>

      {/* Visibility: field grid with iris Switch */}
      <div className="grid grid-cols-[64px_1fr] items-center gap-2">
        <label className="text-muted-foreground" style={{ fontSize: '11.5px' }}>Visible</label>
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

      {/* Fill: field grid with color swatch + hex input */}
      <div className="grid grid-cols-[64px_1fr] items-start gap-2">
        <label className="text-muted-foreground pt-[9px]" style={{ fontSize: '11.5px' }}>Fill</label>
        <ColorInput
          label=""
          value={getStyleValue('backgroundColor') || '#ffffff'}
          onChange={(v) => setStyleValue('backgroundColor', v)}
        />
      </div>

      {/* Text color (hidden for img): field grid */}
      {component.type !== 'img' && (
        <div className="grid grid-cols-[64px_1fr] items-start gap-2">
          <label className="text-muted-foreground pt-[9px]" style={{ fontSize: '11.5px' }}>Text</label>
          <ColorInput
            label=""
            value={getStyleValue('color') || '#000000'}
            onChange={(v) => setStyleValue('color', v)}
          />
        </div>
      )}

      {/* Overflow: field grid with select */}
      <div className="grid grid-cols-[64px_1fr] items-center gap-2">
        <label className="text-muted-foreground" style={{ fontSize: '11.5px' }}>Overflow</label>
        <PropertySelect
          label=""
          value={getStyleValue('overflow') || 'visible'}
          onChange={(v) => setStyleValue('overflow', v)}
          options={OVERFLOW_OPTIONS}
        />
      </div>

      {/* Border Radius: field grid */}
      <div className="grid grid-cols-[64px_1fr] items-start gap-2">
        <label className="text-muted-foreground pt-[9px]" style={{ fontSize: '11.5px' }}>Radius</label>
        <DimensionInput
          label=""
          value={getStyleValue('borderRadius')}
          onChange={(v) => setStyleValue('borderRadius', v)}
          units={['px', '%']}
          placeholder="0"
        />
      </div>

      {/* Individual corners disclosure */}
      <button
        onClick={() => setShowCorners(!showCorners)}
        className="flex items-center gap-1 text-muted-foreground hover:text-muted-foreground"
        style={{ fontSize: '11.5px' }}
      >
        {showCorners ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
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

      {/* Border disclosure */}
      <button
        onClick={() => setShowBorder(!showBorder)}
        className="flex items-center gap-1 text-muted-foreground hover:text-muted-foreground"
        style={{ fontSize: '11.5px' }}
      >
        {showBorder ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        Border
      </button>
      {showBorder && (
        <div className="flex flex-col gap-2.5">
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

      {/* Box Shadow: field grid */}
      <div className="grid grid-cols-[64px_1fr] items-center gap-2">
        <label className="text-muted-foreground" style={{ fontSize: '11.5px' }}>Shadow</label>
        <input
          type="text"
          value={getStyleValue('boxShadow') || ''}
          onChange={(e) => setStyleValue('boxShadow', e.target.value)}
          className="h-[30px] w-full bg-background border border-border rounded-[7px] px-2 font-mono text-foreground outline-none focus:border-brand"
          style={{ fontSize: '11px' }}
          placeholder="0 2px 4px rgba(0,0,0,0.1)"
        />
      </div>
    </CollapsibleSection>
  );
});

StylesSection.displayName = 'StylesSection';

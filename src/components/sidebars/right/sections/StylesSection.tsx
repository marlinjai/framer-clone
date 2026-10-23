'use client';
import React, { useState } from 'react';
import { observer } from 'mobx-react-lite';
import { Paintbrush } from 'lucide-react';
import { ComponentInstance } from '@/models/ComponentModel';
import {
  CollapsibleSection,
  ColorInput,
  DimensionInput,
  DisclosureButton,
  FieldPair,
  PropertyRow,
  PropertySelect,
  PropertySlider,
  PropertySwitch,
  TextInput,
} from '../primitives';
import { breakpointLabel, styleSource } from '../breakpointSource';

const RADIUS_UNITS = ['px', '%'];

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
  // Where each row's value comes from on this breakpoint (the dot before the label).
  const src = (...props: string[]) => styleSource(component, breakpointId, props);

  const currentDisplay = getStyleValue('display');
  // `|| 1` would read a real opacity of 0 as 1, so only an unparseable value falls back.
  const parsedOpacity = parseFloat(getStyleValue('opacity') ?? '1');
  const opacity = Number.isNaN(parsedOpacity) ? 1 : parsedOpacity;
  const isVisible = currentDisplay !== 'none';

  return (
    <CollapsibleSection
      title="Styles"
      icon={<Paintbrush size={14} />}
      badge={breakpointLabel(component, breakpointId)}
    >
      <PropertyRow label="Opacity" source={src('opacity')}>
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
      </PropertyRow>

      <PropertyRow label="Visible" source={src('display')}>
        <PropertySwitch
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
      </PropertyRow>

      <PropertyRow label="Fill" source={src('backgroundColor')}>
        <ColorInput
          label=""
          value={getStyleValue('backgroundColor') || '#ffffff'}
          onChange={(v) => setStyleValue('backgroundColor', v)}
        />
      </PropertyRow>

      {/* Text color (hidden for img) */}
      {component.type !== 'img' && (
        <PropertyRow label="Text" source={src('color')}>
          <ColorInput
            label=""
            value={getStyleValue('color') || '#000000'}
            onChange={(v) => setStyleValue('color', v)}
          />
        </PropertyRow>
      )}

      <PropertyRow label="Overflow" source={src('overflow')}>
        <PropertySelect
          label=""
          value={getStyleValue('overflow') || 'visible'}
          onChange={(v) => setStyleValue('overflow', v)}
          options={OVERFLOW_OPTIONS}
        />
      </PropertyRow>

      <PropertyRow label="Radius" source={src('borderRadius', 'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius')}>
        <DimensionInput
          label=""
          value={getStyleValue('borderRadius')}
          onChange={(v) => setStyleValue('borderRadius', v)}
          units={RADIUS_UNITS}
          min={0}
          placeholder="0"
        />
      </PropertyRow>

      {/* Individual corners */}
      <DisclosureButton open={showCorners} onToggle={() => setShowCorners(!showCorners)}>
        Individual corners
      </DisclosureButton>
      {showCorners && (
        <>
          <PropertyRow label="Top" source={src('borderTopLeftRadius', 'borderTopRightRadius')} hint="Top-left and top-right corners" group>
            <FieldPair>
              <DimensionInput label="" aria-label="Top-left radius" prefix="L" value={getStyleValue('borderTopLeftRadius')} onChange={(v) => setStyleValue('borderTopLeftRadius', v)} units={RADIUS_UNITS} min={0} placeholder="0" />
              <DimensionInput label="" aria-label="Top-right radius" prefix="R" value={getStyleValue('borderTopRightRadius')} onChange={(v) => setStyleValue('borderTopRightRadius', v)} units={RADIUS_UNITS} min={0} placeholder="0" />
            </FieldPair>
          </PropertyRow>
          <PropertyRow label="Bottom" source={src('borderBottomLeftRadius', 'borderBottomRightRadius')} hint="Bottom-left and bottom-right corners" group>
            <FieldPair>
              <DimensionInput label="" aria-label="Bottom-left radius" prefix="L" value={getStyleValue('borderBottomLeftRadius')} onChange={(v) => setStyleValue('borderBottomLeftRadius', v)} units={RADIUS_UNITS} min={0} placeholder="0" />
              <DimensionInput label="" aria-label="Bottom-right radius" prefix="R" value={getStyleValue('borderBottomRightRadius')} onChange={(v) => setStyleValue('borderBottomRightRadius', v)} units={RADIUS_UNITS} min={0} placeholder="0" />
            </FieldPair>
          </PropertyRow>
        </>
      )}

      {/* Border */}
      <DisclosureButton open={showBorder} onToggle={() => setShowBorder(!showBorder)}>
        Border
      </DisclosureButton>
      {showBorder && (
        <>
          <PropertyRow label="Width" source={src('borderWidth')} hint="Border width">
            <DimensionInput
              label=""
              value={getStyleValue('borderWidth')}
              onChange={(v) => setStyleValue('borderWidth', v)}
              units={['px']}
              min={0}
              placeholder="0"
            />
          </PropertyRow>
          <PropertyRow label="Style" source={src('borderStyle')} hint="Border style">
            <PropertySelect
              label=""
              value={getStyleValue('borderStyle') || 'none'}
              onChange={(v) => setStyleValue('borderStyle', v)}
              options={[
                { value: 'none', label: 'None' },
                { value: 'solid', label: 'Solid' },
                { value: 'dashed', label: 'Dashed' },
                { value: 'dotted', label: 'Dotted' },
              ]}
            />
          </PropertyRow>
          <PropertyRow label="Color" source={src('borderColor')} hint="Border color">
            <ColorInput
              label=""
              value={getStyleValue('borderColor') || '#000000'}
              onChange={(v) => setStyleValue('borderColor', v)}
            />
          </PropertyRow>
        </>
      )}

      <PropertyRow label="Shadow" source={src('boxShadow')}>
        <TextInput
          mono
          value={getStyleValue('boxShadow') || ''}
          onChange={(e) => setStyleValue('boxShadow', e.target.value)}
          placeholder="0 2px 4px rgba(0,0,0,0.1)"
        />
      </PropertyRow>
    </CollapsibleSection>
  );
});

StylesSection.displayName = 'StylesSection';

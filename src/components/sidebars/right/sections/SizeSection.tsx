'use client';
import React, { useState } from 'react';
import { observer } from 'mobx-react-lite';
import { MoveDiagonal } from 'lucide-react';
import { ComponentInstance } from '@/models/ComponentModel';
import {
  CollapsibleSection,
  DimensionInput,
  DisclosureButton,
  FieldPair,
  PropertyRow,
  TextInput,
} from '../primitives';

interface SizeSectionProps {
  component: ComponentInstance;
  breakpointId?: string;
}

/** Whole-pixel number from a DimensionInput value ("320px"), or the fallback when cleared. */
function toPixels(value: string, fallback: number): number {
  const n = parseInt(value, 10);
  return isNaN(n) ? fallback : n;
}

export const SizeSection = observer(({ component, breakpointId }: SizeSectionProps) => {
  const [showMinMax, setShowMinMax] = useState(false);

  const getStyleValue = (prop: string) => component.getResponsiveStyleValue(prop, breakpointId);
  const setStyleValue = (prop: string, value: string) => component.updateResponsiveStyle(prop, value, breakpointId);

  // Canvas coordinates: shared by viewport frames and floating elements.
  const canvasRow = (
    <PropertyRow label="Canvas" group>
      <FieldPair>
        <DimensionInput
          label=""
          aria-label="Canvas X"
          prefix="X"
          value={component.canvasX || 0}
          onChange={(v) => component.updateCanvasTransform({ x: toPixels(v, 0) })}
          units={['px']}
          placeholder="0"
        />
        <DimensionInput
          label=""
          aria-label="Canvas Y"
          prefix="Y"
          value={component.canvasY || 0}
          onChange={(v) => component.updateCanvasTransform({ y: toPixels(v, 0) })}
          units={['px']}
          placeholder="0"
        />
      </FieldPair>
    </PropertyRow>
  );

  return (
    <CollapsibleSection
      title="Size"
      icon={<MoveDiagonal size={14} />}
      badge={breakpointId ? component.label || undefined : undefined}
    >
      {/* Viewport-specific controls */}
      {component.isViewportNode && (
        <>
          <PropertyRow label="Breakpoint" hint="Minimum viewport width at which this breakpoint applies.">
            <DimensionInput
              label=""
              value={component.breakpointMinWidth || 320}
              onChange={(v) => component.setViewportProperties({ breakpointMinWidth: toPixels(v, 320) })}
              units={['px']}
              min={0}
              placeholder="320"
            />
          </PropertyRow>
          <PropertyRow label="Min height" hint="Minimum frame height on the canvas. The frame grows to fit the page content.">
            <DimensionInput
              label=""
              value={component.viewportHeight || 600}
              onChange={(v) => component.setViewportProperties({ viewportHeight: toPixels(v, 600) })}
              units={['px']}
              min={0}
              placeholder="600"
            />
          </PropertyRow>
          {canvasRow}
        </>
      )}

      {/* Floating element position */}
      {component.isFloatingElement && canvasRow}

      {/* Width + Height */}
      <PropertyRow label="Size" group>
        <FieldPair>
          <DimensionInput
            label=""
            aria-label="Width"
            prefix="W"
            value={getStyleValue('width')}
            onChange={(v) => setStyleValue('width', v)}
            min={0}
          />
          <DimensionInput
            label=""
            aria-label="Height"
            prefix="H"
            value={getStyleValue('height')}
            onChange={(v) => setStyleValue('height', v)}
            min={0}
          />
        </FieldPair>
      </PropertyRow>

      {/* Min / Max disclosure */}
      <DisclosureButton open={showMinMax} onToggle={() => setShowMinMax(!showMinMax)}>
        Min / Max
      </DisclosureButton>
      {showMinMax && (
        <>
          <PropertyRow label="Min" group>
            <FieldPair>
              <DimensionInput
                label=""
                aria-label="Min width"
                prefix="W"
                value={getStyleValue('minWidth')}
                onChange={(v) => setStyleValue('minWidth', v)}
                min={0}
                placeholder="0"
              />
              <DimensionInput
                label=""
                aria-label="Min height"
                prefix="H"
                value={getStyleValue('minHeight')}
                onChange={(v) => setStyleValue('minHeight', v)}
                min={0}
                placeholder="0"
              />
            </FieldPair>
          </PropertyRow>
          <PropertyRow label="Max" group>
            <FieldPair>
              <DimensionInput
                label=""
                aria-label="Max width"
                prefix="W"
                value={getStyleValue('maxWidth')}
                onChange={(v) => setStyleValue('maxWidth', v)}
                units={['px', '%', 'none']}
                min={0}
                placeholder="none"
              />
              <DimensionInput
                label=""
                aria-label="Max height"
                prefix="H"
                value={getStyleValue('maxHeight')}
                onChange={(v) => setStyleValue('maxHeight', v)}
                units={['px', '%', 'none']}
                min={0}
                placeholder="none"
              />
            </FieldPair>
          </PropertyRow>
        </>
      )}

      {/* Image URL for img elements */}
      {component.type === 'img' && (
        <PropertyRow label="Image URL">
          <TextInput
            value={component.props?.src as string || ''}
            onChange={(e) => component.setImageSrc(e.target.value)}
            placeholder="https://example.com/image.jpg"
          />
        </PropertyRow>
      )}
    </CollapsibleSection>
  );
});

SizeSection.displayName = 'SizeSection';

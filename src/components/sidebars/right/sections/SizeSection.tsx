'use client';
import React, { useState } from 'react';
import { observer } from 'mobx-react-lite';
import { Maximize2, ChevronDown, ChevronRight } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { ComponentInstance } from '@/models/ComponentModel';
import { CollapsibleSection, DimensionInput } from '../primitives';

interface SizeSectionProps {
  component: ComponentInstance;
  breakpointId?: string;
}

export const SizeSection = observer(({ component, breakpointId }: SizeSectionProps) => {
  const [showMinMax, setShowMinMax] = useState(false);

  const getStyleValue = (prop: string) => component.getResponsiveStyleValue(prop, breakpointId);
  const setStyleValue = (prop: string, value: string) => component.updateResponsiveStyle(prop, value, breakpointId);

  return (
    <CollapsibleSection
      title="Size"
      icon={<Maximize2 size={12} />}
      badge={breakpointId ? component.label || undefined : undefined}
    >
      {/* Viewport-specific controls */}
      {component.isViewportNode && (
        <div className="space-y-2 mb-2">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-[11px] text-gray-500">Min Width (BP)</label>
              <Input
                value={component.breakpointMinWidth || 320}
                onChange={(e) => {
                  component.setViewportProperties({ breakpointMinWidth: parseInt(e.target.value) || 320 });
                }}
                className="h-7 text-xs"
                placeholder="320"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[11px] text-gray-500">Viewport Height</label>
              <Input
                value={component.viewportHeight || 600}
                onChange={(e) => {
                  component.setViewportProperties({ viewportHeight: parseInt(e.target.value) || 600 });
                }}
                className="h-7 text-xs"
                placeholder="600"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-[11px] text-gray-500">Canvas X</label>
              <Input
                value={component.canvasX || 0}
                onChange={(e) => component.updateCanvasTransform({ x: parseInt(e.target.value) || 0 })}
                className="h-7 text-xs"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[11px] text-gray-500">Canvas Y</label>
              <Input
                value={component.canvasY || 0}
                onChange={(e) => component.updateCanvasTransform({ y: parseInt(e.target.value) || 0 })}
                className="h-7 text-xs"
              />
            </div>
          </div>
        </div>
      )}

      {/* Floating element position */}
      {component.isFloatingElement && (
        <div className="grid grid-cols-2 gap-2 mb-2">
          <div className="space-y-1">
            <label className="text-[11px] text-gray-500">Canvas X</label>
            <Input
              value={component.canvasX || 0}
              onChange={(e) => component.updateCanvasTransform({ x: parseInt(e.target.value) || 0 })}
              className="h-7 text-xs"
            />
          </div>
          <div className="space-y-1">
            <label className="text-[11px] text-gray-500">Canvas Y</label>
            <Input
              value={component.canvasY || 0}
              onChange={(e) => component.updateCanvasTransform({ y: parseInt(e.target.value) || 0 })}
              className="h-7 text-xs"
            />
          </div>
        </div>
      )}

      {/* Width / Height */}
      <div className="grid grid-cols-2 gap-2">
        <DimensionInput
          label="Width"
          value={getStyleValue('width')}
          onChange={(v) => setStyleValue('width', v)}
        />
        <DimensionInput
          label="Height"
          value={getStyleValue('height')}
          onChange={(v) => setStyleValue('height', v)}
        />
      </div>

      {/* Min/Max toggle */}
      <button
        onClick={() => setShowMinMax(!showMinMax)}
        className="flex items-center gap-1 text-[10px] text-gray-400 hover:text-gray-600 mt-1"
      >
        {showMinMax ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        Min / Max
      </button>
      {showMinMax && (
        <div className="grid grid-cols-2 gap-2">
          <DimensionInput
            label="Min W"
            value={getStyleValue('minWidth')}
            onChange={(v) => setStyleValue('minWidth', v)}
          />
          <DimensionInput
            label="Max W"
            value={getStyleValue('maxWidth')}
            onChange={(v) => setStyleValue('maxWidth', v)}
          />
          <DimensionInput
            label="Min H"
            value={getStyleValue('minHeight')}
            onChange={(v) => setStyleValue('minHeight', v)}
          />
          <DimensionInput
            label="Max H"
            value={getStyleValue('maxHeight')}
            onChange={(v) => setStyleValue('maxHeight', v)}
          />
        </div>
      )}

      {/* Image URL for img elements */}
      {component.type === 'img' && (
        <div className="space-y-1 mt-2">
          <label className="text-[11px] text-gray-500">Image URL</label>
          <Input
            value={component.props?.src || ''}
            onChange={(e) => {
              const currentProps = component.props || {};
              component.props = { ...currentProps, src: e.target.value } as Record<string, unknown>;
            }}
            className="h-7 text-xs"
            placeholder="https://example.com/image.jpg"
          />
        </div>
      )}
    </CollapsibleSection>
  );
});

SizeSection.displayName = 'SizeSection';

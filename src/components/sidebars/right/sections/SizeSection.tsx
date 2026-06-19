'use client';
import React, { useState } from 'react';
import { observer } from 'mobx-react-lite';
import { MoveDiagonal, ChevronDown, ChevronRight } from 'lucide-react';
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
      icon={<MoveDiagonal size={14} />}
      badge={breakpointId ? component.label || undefined : undefined}
    >
      {/* Viewport-specific controls */}
      {component.isViewportNode && (
        <div className="flex flex-col gap-2.5 pb-1">
          {/* Two-up: Min Width (BP) + Viewport Height */}
          <div className="flex gap-2">
            <div className="flex-1">
              <div className="flex flex-col gap-1">
                <label className="text-muted-foreground" style={{ fontSize: '11px' }}>Min Width (BP)</label>
                <input
                  type="number"
                  value={component.breakpointMinWidth || 320}
                  onChange={(e) => {
                    component.setViewportProperties({ breakpointMinWidth: parseInt(e.target.value) || 320 });
                  }}
                  className="h-[30px] w-full bg-background border border-border rounded-[7px] px-2 text-foreground outline-none focus:border-brand"
                  style={{ fontSize: '12.5px' }}
                  placeholder="320"
                />
              </div>
            </div>
            <div className="flex-1">
              <div className="flex flex-col gap-1">
                <label className="text-muted-foreground" style={{ fontSize: '11px' }}>Viewport Height</label>
                <input
                  type="number"
                  value={component.viewportHeight || 600}
                  onChange={(e) => {
                    component.setViewportProperties({ viewportHeight: parseInt(e.target.value) || 600 });
                  }}
                  className="h-[30px] w-full bg-background border border-border rounded-[7px] px-2 text-foreground outline-none focus:border-brand"
                  style={{ fontSize: '12.5px' }}
                  placeholder="600"
                />
              </div>
            </div>
          </div>
          {/* Two-up: Canvas X + Canvas Y */}
          <div className="flex gap-2">
            <div className="flex-1">
              <div className="flex flex-col gap-1">
                <label className="text-muted-foreground" style={{ fontSize: '11px' }}>Canvas X</label>
                <input
                  type="number"
                  value={component.canvasX || 0}
                  onChange={(e) => component.updateCanvasTransform({ x: parseInt(e.target.value) || 0 })}
                  className="h-[30px] w-full bg-background border border-border rounded-[7px] px-2 text-foreground outline-none focus:border-brand"
                  style={{ fontSize: '12.5px' }}
                />
              </div>
            </div>
            <div className="flex-1">
              <div className="flex flex-col gap-1">
                <label className="text-muted-foreground" style={{ fontSize: '11px' }}>Canvas Y</label>
                <input
                  type="number"
                  value={component.canvasY || 0}
                  onChange={(e) => component.updateCanvasTransform({ y: parseInt(e.target.value) || 0 })}
                  className="h-[30px] w-full bg-background border border-border rounded-[7px] px-2 text-foreground outline-none focus:border-brand"
                  style={{ fontSize: '12.5px' }}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Floating element position */}
      {component.isFloatingElement && (
        <div className="flex gap-2 pb-1">
          <div className="flex-1">
            <div className="flex flex-col gap-1">
              <label className="text-muted-foreground" style={{ fontSize: '11px' }}>Canvas X</label>
              <input
                type="number"
                value={component.canvasX || 0}
                onChange={(e) => component.updateCanvasTransform({ x: parseInt(e.target.value) || 0 })}
                className="h-[30px] w-full bg-background border border-border rounded-[7px] px-2 text-foreground outline-none focus:border-brand"
                style={{ fontSize: '12.5px' }}
              />
            </div>
          </div>
          <div className="flex-1">
            <div className="flex flex-col gap-1">
              <label className="text-muted-foreground" style={{ fontSize: '11px' }}>Canvas Y</label>
              <input
                type="number"
                value={component.canvasY || 0}
                onChange={(e) => component.updateCanvasTransform({ y: parseInt(e.target.value) || 0 })}
                className="h-[30px] w-full bg-background border border-border rounded-[7px] px-2 text-foreground outline-none focus:border-brand"
                style={{ fontSize: '12.5px' }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Two-up: Width + Height on field grid */}
      <div className="flex gap-2">
        <div className="flex-1">
          <div className="grid grid-cols-[auto_1fr] items-start gap-1">
            <label className="text-muted-foreground pt-[9px]" style={{ fontSize: '11.5px' }}>W</label>
            <DimensionInput
              label=""
              value={getStyleValue('width')}
              onChange={(v) => setStyleValue('width', v)}
            />
          </div>
        </div>
        <div className="flex-1">
          <div className="grid grid-cols-[auto_1fr] items-start gap-1">
            <label className="text-muted-foreground pt-[9px]" style={{ fontSize: '11.5px' }}>H</label>
            <DimensionInput
              label=""
              value={getStyleValue('height')}
              onChange={(v) => setStyleValue('height', v)}
            />
          </div>
        </div>
      </div>

      {/* Min / Max disclosure */}
      <button
        onClick={() => setShowMinMax(!showMinMax)}
        className="flex items-center gap-1 text-muted-foreground hover:text-muted-foreground"
        style={{ fontSize: '11.5px' }}
      >
        {showMinMax ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
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
        <div className="flex flex-col gap-1 pt-1">
          <label className="text-muted-foreground" style={{ fontSize: '11px' }}>Image URL</label>
          <input
            type="text"
            value={component.props?.src as string || ''}
            onChange={(e) => {
              const currentProps = component.props || {};
              component.props = { ...currentProps, src: e.target.value } as Record<string, unknown>;
            }}
            className="h-[30px] w-full bg-background border border-border rounded-[7px] px-2 text-foreground outline-none focus:border-brand"
            style={{ fontSize: '12.5px' }}
            placeholder="https://example.com/image.jpg"
          />
        </div>
      )}
    </CollapsibleSection>
  );
});

SizeSection.displayName = 'SizeSection';

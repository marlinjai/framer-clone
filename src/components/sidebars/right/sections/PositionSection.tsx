'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import { Move } from 'lucide-react';
import { ComponentInstance } from '@/models/ComponentModel';
import { CollapsibleSection, PropertySelect, DimensionInput } from '../primitives';

const POSITION_OPTIONS = [
  { value: 'static', label: 'Static' },
  { value: 'relative', label: 'Relative' },
  { value: 'absolute', label: 'Absolute' },
  { value: 'fixed', label: 'Fixed' },
  { value: 'sticky', label: 'Sticky' },
];

interface PositionSectionProps {
  component: ComponentInstance;
  breakpointId?: string;
}

export const PositionSection = observer(({ component, breakpointId }: PositionSectionProps) => {
  const getStyleValue = (prop: string) => component.getResponsiveStyleValue(prop, breakpointId);
  const setStyleValue = (prop: string, value: string) => component.updateResponsiveStyle(prop, value, breakpointId);

  const position = getStyleValue('position') || 'static';

  return (
    <CollapsibleSection
      title="Position"
      icon={<Move size={14} />}
      defaultOpen={position !== 'static'}
    >
      {/* Position type on field grid */}
      <div className="grid grid-cols-[64px_1fr] items-center gap-2">
        <label className="text-muted-foreground" style={{ fontSize: '11.5px' }}>Position</label>
        <PropertySelect
          label=""
          value={position}
          onChange={(v) => setStyleValue('position', v)}
          options={POSITION_OPTIONS}
        />
      </div>

      {position !== 'static' && (
        <div className="grid grid-cols-2 gap-2">
          <DimensionInput
            label="Top"
            value={getStyleValue('top')}
            onChange={(v) => setStyleValue('top', v)}
            placeholder="auto"
          />
          <DimensionInput
            label="Right"
            value={getStyleValue('right')}
            onChange={(v) => setStyleValue('right', v)}
            placeholder="auto"
          />
          <DimensionInput
            label="Bottom"
            value={getStyleValue('bottom')}
            onChange={(v) => setStyleValue('bottom', v)}
            placeholder="auto"
          />
          <DimensionInput
            label="Left"
            value={getStyleValue('left')}
            onChange={(v) => setStyleValue('left', v)}
            placeholder="auto"
          />
        </div>
      )}

      {/* Z-Index on field grid */}
      <div className="grid grid-cols-[64px_1fr] items-center gap-2">
        <label className="text-muted-foreground" style={{ fontSize: '11.5px' }}>Z-Index</label>
        <input
          type="text"
          value={getStyleValue('zIndex') || ''}
          onChange={(e) => setStyleValue('zIndex', e.target.value)}
          className="h-[30px] w-full bg-background border border-border rounded-[7px] px-2 text-foreground outline-none focus:border-brand"
          style={{ fontSize: '12.5px' }}
          placeholder="auto"
        />
      </div>
    </CollapsibleSection>
  );
});

PositionSection.displayName = 'PositionSection';

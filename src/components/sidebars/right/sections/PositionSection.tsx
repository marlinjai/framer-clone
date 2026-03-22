'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import { Move } from 'lucide-react';
import { Input } from '@/components/ui/input';
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
      icon={<Move size={12} />}
      defaultOpen={position !== 'static'}
    >
      <PropertySelect
        label="Position"
        value={position}
        onChange={(v) => setStyleValue('position', v)}
        options={POSITION_OPTIONS}
      />

      {position !== 'static' && (
        <div className="grid grid-cols-2 gap-2 mt-2">
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

      <div className="mt-2">
        <div className="space-y-1">
          <label className="text-[11px] text-gray-500">Z-Index</label>
          <Input
            value={getStyleValue('zIndex') || ''}
            onChange={(e) => setStyleValue('zIndex', e.target.value)}
            className="h-7 text-xs"
            placeholder="auto"
          />
        </div>
      </div>
    </CollapsibleSection>
  );
});

PositionSection.displayName = 'PositionSection';

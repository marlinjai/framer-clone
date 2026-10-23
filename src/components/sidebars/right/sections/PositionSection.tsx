'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import { Move } from 'lucide-react';
import { ComponentInstance } from '@/models/ComponentModel';
import {
  CollapsibleSection,
  DimensionInput,
  FieldPair,
  PropertyRow,
  PropertySelect,
  TextInput,
} from '../primitives';

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
      <PropertyRow label="Position">
        <PropertySelect
          label=""
          value={position}
          onChange={(v) => setStyleValue('position', v)}
          options={POSITION_OPTIONS}
        />
      </PropertyRow>

      {/* Insets: two-up rows, prefixed T / B and L / R */}
      {position !== 'static' && (
        <>
          <PropertyRow label="Vertical" hint="Top and bottom offsets" group>
            <FieldPair>
              <DimensionInput
                label=""
                aria-label="Top"
                prefix="T"
                value={getStyleValue('top')}
                onChange={(v) => setStyleValue('top', v)}
                placeholder="auto"
              />
              <DimensionInput
                label=""
                aria-label="Bottom"
                prefix="B"
                value={getStyleValue('bottom')}
                onChange={(v) => setStyleValue('bottom', v)}
                placeholder="auto"
              />
            </FieldPair>
          </PropertyRow>
          <PropertyRow label="Horizontal" hint="Left and right offsets" group>
            <FieldPair>
              <DimensionInput
                label=""
                aria-label="Left"
                prefix="L"
                value={getStyleValue('left')}
                onChange={(v) => setStyleValue('left', v)}
                placeholder="auto"
              />
              <DimensionInput
                label=""
                aria-label="Right"
                prefix="R"
                value={getStyleValue('right')}
                onChange={(v) => setStyleValue('right', v)}
                placeholder="auto"
              />
            </FieldPair>
          </PropertyRow>
        </>
      )}

      <PropertyRow label="Z-Index">
        <TextInput
          value={getStyleValue('zIndex') || ''}
          onChange={(e) => setStyleValue('zIndex', e.target.value)}
          placeholder="auto"
        />
      </PropertyRow>
    </CollapsibleSection>
  );
});

PositionSection.displayName = 'PositionSection';

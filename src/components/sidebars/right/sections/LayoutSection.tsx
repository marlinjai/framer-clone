'use client';
import React, { useState } from 'react';
import { observer } from 'mobx-react-lite';
import { LayoutGrid, ArrowRight, ArrowDown } from 'lucide-react';
import { ComponentInstance } from '@/models/ComponentModel';
import {
  CollapsibleSection,
  DimensionInput,
  DisclosureButton,
  FieldPair,
  PropertyRow,
  PropertySwitch,
  ToggleIconGroup,
} from '../primitives';
import { uniformBoxValue } from '@/lib/canvas/spacingDrag';
import { getHistoryStore } from '@/stores/RootStore';

const PADDING_UNITS = ['px', 'rem', '%'];

/** Short text option for a segmented control. */
const text = (label: string) => <span className="truncate px-0.5">{label}</span>;

interface LayoutSectionProps {
  component: ComponentInstance;
  breakpointId?: string;
}

export const LayoutSection = observer(({ component, breakpointId }: LayoutSectionProps) => {
  const [showPaddingSides, setShowPaddingSides] = useState(false);

  const getStyleValue = (prop: string) => component.getResponsiveStyleValue(prop, breakpointId);
  const setStyleValue = (prop: string, value: string) => component.updateResponsiveStyle(prop, value, breakpointId);

  // The single Padding field reflects the four effective sides (the canvas
  // handles write sides one by one), and setting it writes all four, so a
  // side longhand can never silently override what the field shows.
  const paddingAll = uniformBoxValue(getStyleValue('padding'), {
    top: getStyleValue('paddingTop'),
    right: getStyleValue('paddingRight'),
    bottom: getStyleValue('paddingBottom'),
    left: getStyleValue('paddingLeft'),
  });
  const setPaddingAll = (v: string) => {
    // Five writes, one undo step.
    const history = getHistoryStore();
    history?.startBatch('Padding');
    for (const side of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']) setStyleValue(side, v);
    setStyleValue('padding', '');
    history?.commitBatch();
  };

  const rawDisplay = getStyleValue('display');
  const display = rawDisplay || 'block';
  const isFlexOrGrid = display === 'flex' || display === 'grid';

  return (
    <CollapsibleSection
      title="Layout"
      icon={<LayoutGrid size={14} />}
    >
      <PropertyRow label="Display">
        <ToggleIconGroup
          label=""
          value={display}
          onChange={(v) => setStyleValue('display', v)}
          options={[
            { value: 'block', icon: text('Block'), tooltip: 'Block' },
            { value: 'flex', icon: text('Flex'), tooltip: 'Flex' },
            { value: 'grid', icon: text('Grid'), tooltip: 'Grid' },
          ]}
        />
      </PropertyRow>

      {display === 'flex' && (
        <>
          <PropertyRow label="Direction">
            <ToggleIconGroup
              label=""
              value={getStyleValue('flexDirection') || 'column'}
              onChange={(v) => setStyleValue('flexDirection', v)}
              options={[
                { value: 'row', icon: <ArrowRight size={13} />, tooltip: 'Row' },
                { value: 'column', icon: <ArrowDown size={13} />, tooltip: 'Column' },
              ]}
            />
          </PropertyRow>

          <PropertyRow label="Justify">
            <ToggleIconGroup
              label=""
              value={getStyleValue('justifyContent') || 'flex-start'}
              onChange={(v) => setStyleValue('justifyContent', v)}
              options={[
                { value: 'flex-start', icon: text('Start'), tooltip: 'Start' },
                { value: 'center', icon: text('Center'), tooltip: 'Center' },
                { value: 'flex-end', icon: text('End'), tooltip: 'End' },
                { value: 'space-between', icon: text('Space'), tooltip: 'Space between' },
              ]}
            />
          </PropertyRow>

          <PropertyRow label="Align">
            <ToggleIconGroup
              label=""
              value={getStyleValue('alignItems') || 'stretch'}
              onChange={(v) => setStyleValue('alignItems', v)}
              options={[
                { value: 'flex-start', icon: text('Start'), tooltip: 'Start' },
                { value: 'center', icon: text('Center'), tooltip: 'Center' },
                { value: 'flex-end', icon: text('End'), tooltip: 'End' },
                { value: 'stretch', icon: text('Fill'), tooltip: 'Stretch' },
              ]}
            />
          </PropertyRow>

          <PropertyRow label="Wrap">
            <PropertySwitch
              checked={getStyleValue('flexWrap') === 'wrap'}
              onCheckedChange={(checked) => setStyleValue('flexWrap', checked ? 'wrap' : 'nowrap')}
            />
          </PropertyRow>
        </>
      )}

      {/* Gap (flex/grid only) */}
      {isFlexOrGrid && (
        <PropertyRow label="Gap">
          <DimensionInput
            label=""
            value={getStyleValue('gap')}
            onChange={(v) => setStyleValue('gap', v)}
            units={['px', 'rem']}
            min={0}
            placeholder="0"
          />
        </PropertyRow>
      )}

      <PropertyRow label="Padding">
        <DimensionInput
          label=""
          value={paddingAll === 'mixed' ? '' : paddingAll}
          onChange={setPaddingAll}
          units={PADDING_UNITS}
          min={0}
          placeholder={paddingAll === 'mixed' ? 'Mixed' : '0'}
        />
      </PropertyRow>

      {/* Individual padding sides */}
      <DisclosureButton open={showPaddingSides} onToggle={() => setShowPaddingSides(!showPaddingSides)}>
        Individual sides
      </DisclosureButton>
      {showPaddingSides && (
        <>
          <PropertyRow label="Vertical" hint="Top and bottom padding" group>
            <FieldPair>
              <DimensionInput label="" aria-label="Padding top" prefix="T" value={getStyleValue('paddingTop')} onChange={(v) => setStyleValue('paddingTop', v)} units={PADDING_UNITS} min={0} placeholder="0" />
              <DimensionInput label="" aria-label="Padding bottom" prefix="B" value={getStyleValue('paddingBottom')} onChange={(v) => setStyleValue('paddingBottom', v)} units={PADDING_UNITS} min={0} placeholder="0" />
            </FieldPair>
          </PropertyRow>
          <PropertyRow label="Horizontal" hint="Left and right padding" group>
            <FieldPair>
              <DimensionInput label="" aria-label="Padding left" prefix="L" value={getStyleValue('paddingLeft')} onChange={(v) => setStyleValue('paddingLeft', v)} units={PADDING_UNITS} min={0} placeholder="0" />
              <DimensionInput label="" aria-label="Padding right" prefix="R" value={getStyleValue('paddingRight')} onChange={(v) => setStyleValue('paddingRight', v)} units={PADDING_UNITS} min={0} placeholder="0" />
            </FieldPair>
          </PropertyRow>
        </>
      )}
    </CollapsibleSection>
  );
});

LayoutSection.displayName = 'LayoutSection';

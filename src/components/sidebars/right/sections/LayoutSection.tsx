'use client';
import React, { useState } from 'react';
import { observer } from 'mobx-react-lite';
import { LayoutGrid, ArrowRight, ArrowDown, ChevronDown, ChevronRight } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { ComponentInstance } from '@/models/ComponentModel';
import { CollapsibleSection, ToggleIconGroup, DimensionInput } from '../primitives';

interface LayoutSectionProps {
  component: ComponentInstance;
  breakpointId?: string;
}

export const LayoutSection = observer(({ component, breakpointId }: LayoutSectionProps) => {
  const [showPaddingSides, setShowPaddingSides] = useState(false);

  const getStyleValue = (prop: string) => component.getResponsiveStyleValue(prop, breakpointId);
  const setStyleValue = (prop: string, value: string) => component.updateResponsiveStyle(prop, value, breakpointId);

  const rawDisplay = getStyleValue('display');
  const display = rawDisplay || 'block';
  const isFlexOrGrid = display === 'flex' || display === 'grid';

  return (
    <CollapsibleSection
      title="Layout"
      icon={<LayoutGrid size={12} />}
    >
      {/* Display mode */}
      <ToggleIconGroup
        label="Display"
        value={display}
        onChange={(v) => setStyleValue('display', v)}
        options={[
          { value: 'block', icon: <span className="text-[10px] font-medium">Block</span>, tooltip: 'Block' },
          { value: 'flex', icon: <span className="text-[10px] font-medium">Flex</span>, tooltip: 'Flexbox' },
          { value: 'grid', icon: <span className="text-[10px] font-medium">Grid</span>, tooltip: 'Grid' },
        ]}
      />

      {display === 'flex' && (
        <>
          {/* Flex Direction */}
          <ToggleIconGroup
            label="Direction"
            value={getStyleValue('flexDirection') || 'column'}
            onChange={(v) => setStyleValue('flexDirection', v)}
            options={[
              { value: 'row', icon: <ArrowRight size={12} />, tooltip: 'Row' },
              { value: 'column', icon: <ArrowDown size={12} />, tooltip: 'Column' },
            ]}
          />

          {/* Justify Content */}
          <ToggleIconGroup
            label="Justify"
            value={getStyleValue('justifyContent') || 'flex-start'}
            onChange={(v) => setStyleValue('justifyContent', v)}
            options={[
              { value: 'flex-start', icon: <span className="text-[9px]">Start</span>, tooltip: 'Start' },
              { value: 'center', icon: <span className="text-[9px]">Center</span>, tooltip: 'Center' },
              { value: 'flex-end', icon: <span className="text-[9px]">End</span>, tooltip: 'End' },
              { value: 'space-between', icon: <span className="text-[9px]">Between</span>, tooltip: 'Space Between' },
            ]}
          />

          {/* Align Items */}
          <ToggleIconGroup
            label="Align"
            value={getStyleValue('alignItems') || 'stretch'}
            onChange={(v) => setStyleValue('alignItems', v)}
            options={[
              { value: 'flex-start', icon: <span className="text-[9px]">Start</span>, tooltip: 'Start' },
              { value: 'center', icon: <span className="text-[9px]">Center</span>, tooltip: 'Center' },
              { value: 'flex-end', icon: <span className="text-[9px]">End</span>, tooltip: 'End' },
              { value: 'stretch', icon: <span className="text-[9px]">Stretch</span>, tooltip: 'Stretch' },
            ]}
          />

          {/* Flex Wrap */}
          <div className="flex items-center justify-between">
            <label className="text-[11px] text-gray-500">Wrap</label>
            <Switch
              checked={getStyleValue('flexWrap') === 'wrap'}
              onCheckedChange={(checked) => setStyleValue('flexWrap', checked ? 'wrap' : 'nowrap')}
            />
          </div>
        </>
      )}

      {/* Gap (flex/grid only) */}
      {isFlexOrGrid && (
        <DimensionInput
          label="Gap"
          value={getStyleValue('gap')}
          onChange={(v) => setStyleValue('gap', v)}
          units={['px', 'rem']}
          placeholder="0"
        />
      )}

      {/* Padding */}
      <DimensionInput
        label="Padding"
        value={getStyleValue('padding')}
        onChange={(v) => setStyleValue('padding', v)}
        units={['px', 'rem', '%']}
        placeholder="0"
      />

      {/* Individual padding sides */}
      <button
        onClick={() => setShowPaddingSides(!showPaddingSides)}
        className="flex items-center gap-1 text-[10px] text-gray-400 hover:text-gray-600"
      >
        {showPaddingSides ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        Individual sides
      </button>
      {showPaddingSides && (
        <div className="grid grid-cols-2 gap-2">
          <DimensionInput label="Top" value={getStyleValue('paddingTop')} onChange={(v) => setStyleValue('paddingTop', v)} units={['px', 'rem', '%']} placeholder="0" />
          <DimensionInput label="Right" value={getStyleValue('paddingRight')} onChange={(v) => setStyleValue('paddingRight', v)} units={['px', 'rem', '%']} placeholder="0" />
          <DimensionInput label="Bottom" value={getStyleValue('paddingBottom')} onChange={(v) => setStyleValue('paddingBottom', v)} units={['px', 'rem', '%']} placeholder="0" />
          <DimensionInput label="Left" value={getStyleValue('paddingLeft')} onChange={(v) => setStyleValue('paddingLeft', v)} units={['px', 'rem', '%']} placeholder="0" />
        </div>
      )}
    </CollapsibleSection>
  );
});

LayoutSection.displayName = 'LayoutSection';

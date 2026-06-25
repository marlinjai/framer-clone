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
      icon={<LayoutGrid size={14} />}
    >
      {/* Display mode: text segmented control (Block / Flex / Grid) */}
      <div className="grid grid-cols-[64px_1fr] items-center gap-2">
        <label className="text-muted-foreground" style={{ fontSize: '11.5px' }}>Display</label>
        <div className="flex bg-muted rounded-[7px] p-0.5 gap-0.5">
          {(['block', 'flex', 'grid'] as const).map((mode) => {
            const isActive = display === mode;
            return (
              <button
                key={mode}
                type="button"
                onClick={() => setStyleValue('display', mode)}
                className={`flex-1 flex items-center justify-center rounded-[5px] transition-all text-muted-foreground capitalize ${
                  isActive ? 'bg-background text-foreground shadow-sm' : 'hover:text-foreground'
                }`}
                style={{ height: '26px', fontSize: '12px', fontWeight: 500 }}
              >
                {mode.charAt(0).toUpperCase() + mode.slice(1)}
              </button>
            );
          })}
        </div>
      </div>

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
              { value: 'flex-start', icon: <span style={{ fontSize: '9px' }}>Start</span>, tooltip: 'Start' },
              { value: 'center', icon: <span style={{ fontSize: '9px' }}>Center</span>, tooltip: 'Center' },
              { value: 'flex-end', icon: <span style={{ fontSize: '9px' }}>End</span>, tooltip: 'End' },
              { value: 'space-between', icon: <span style={{ fontSize: '9px' }}>Between</span>, tooltip: 'Space Between' },
            ]}
          />

          {/* Align Items */}
          <ToggleIconGroup
            label="Align"
            value={getStyleValue('alignItems') || 'stretch'}
            onChange={(v) => setStyleValue('alignItems', v)}
            options={[
              { value: 'flex-start', icon: <span style={{ fontSize: '9px' }}>Start</span>, tooltip: 'Start' },
              { value: 'center', icon: <span style={{ fontSize: '9px' }}>Center</span>, tooltip: 'Center' },
              { value: 'flex-end', icon: <span style={{ fontSize: '9px' }}>End</span>, tooltip: 'End' },
              { value: 'stretch', icon: <span style={{ fontSize: '9px' }}>Stretch</span>, tooltip: 'Stretch' },
            ]}
          />

          {/* Flex Wrap */}
          <div className="flex items-center justify-between">
            <label className="text-muted-foreground" style={{ fontSize: '11.5px' }}>Wrap</label>
            <Switch
              checked={getStyleValue('flexWrap') === 'wrap'}
              onCheckedChange={(checked) => setStyleValue('flexWrap', checked ? 'wrap' : 'nowrap')}
            />
          </div>
        </>
      )}

      {/* Gap (flex/grid only) */}
      {isFlexOrGrid && (
        <div className="grid grid-cols-[64px_1fr] items-center gap-2">
          <label className="text-muted-foreground" style={{ fontSize: '11.5px' }}>Gap</label>
          <DimensionInput
            label=""
            value={getStyleValue('gap')}
            onChange={(v) => setStyleValue('gap', v)}
            units={['px', 'rem']}
            placeholder="0"
          />
        </div>
      )}

      {/* Padding */}
      <div className="grid grid-cols-[64px_1fr] items-center gap-2">
        <label className="text-muted-foreground" style={{ fontSize: '11.5px' }}>Padding</label>
        <DimensionInput
          label=""
          value={getStyleValue('padding')}
          onChange={(v) => setStyleValue('padding', v)}
          units={['px', 'rem', '%']}
          placeholder="0"
        />
      </div>

      {/* Individual padding sides disclosure */}
      <button
        onClick={() => setShowPaddingSides(!showPaddingSides)}
        className="flex items-center gap-1 text-muted-foreground hover:text-muted-foreground"
        style={{ fontSize: '11.5px' }}
      >
        {showPaddingSides ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
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

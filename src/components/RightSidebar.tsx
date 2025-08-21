// src/components/RightSidebar.tsx
// Right sidebar with properties/settings panel and collapsible functionality
'use client';

import React from 'react';
import { observer } from 'mobx-react-lite';
import { ChevronLeft, ChevronRight, Settings, Palette, Layout, Type } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { EditorUIType } from '../stores/EditorUIStore';

interface RightSidebarProps {
  editorUI: EditorUIType;
}

const RightSidebar = observer(({ editorUI }: RightSidebarProps) => {
  const isCollapsed = editorUI.rightSidebarCollapsed;

  return (
    <div className={`
      bg-white border-l border-gray-200 flex flex-col transition-all duration-300 ease-in-out
      ${isCollapsed ? 'w-12' : 'w-64'}
    `}>
      {/* Header with collapse toggle */}
      <div className="h-16 flex items-center justify-between px-3 border-b border-gray-200">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => editorUI.toggleRightSidebar()}
          className="p-2 hover:bg-gray-100"
        >
          {isCollapsed ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
        </Button>
        {!isCollapsed && (
          <div className="flex items-center space-x-2">
            <span className="font-medium text-gray-900">Properties</span>
            <Settings size={20} className="text-gray-600" />
          </div>
        )}
      </div>

      {/* Content - only show when not collapsed */}
      {!isCollapsed && (
        <div className="flex-1 overflow-y-auto">
          <div className="p-3 space-y-6">
            {/* Layout Properties */}
            <div>
              <div className="flex items-center space-x-2 mb-3">
                <Layout size={16} className="text-gray-600" />
                <h3 className="text-sm font-medium text-gray-900">Layout</h3>
              </div>
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label className="text-xs text-gray-500">Width</Label>
                    <Input placeholder="auto" className="h-8 text-sm" />
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500">Height</Label>
                    <Input placeholder="auto" className="h-8 text-sm" />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label className="text-xs text-gray-500">X</Label>
                    <Input placeholder="0" className="h-8 text-sm" />
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500">Y</Label>
                    <Input placeholder="0" className="h-8 text-sm" />
                  </div>
                </div>
              </div>
            </div>

            <Separator />

            {/* Styling Properties */}
            <div>
              <div className="flex items-center space-x-2 mb-3">
                <Palette size={16} className="text-gray-600" />
                <h3 className="text-sm font-medium text-gray-900">Styling</h3>
              </div>
              <div className="space-y-3">
                <div>
                  <Label className="text-xs text-gray-500">Background</Label>
                  <div className="flex items-center space-x-2 mt-1">
                    <div className="w-8 h-8 bg-blue-500 rounded border border-gray-200"></div>
                    <Input placeholder="#3B82F6" className="h-8 text-sm flex-1" />
                  </div>
                </div>
                <div>
                  <Label className="text-xs text-gray-500">Border Radius</Label>
                  <div className="mt-1">
                    <Slider
                      defaultValue={[8]}
                      max={50}
                      step={1}
                      className="w-full"
                    />
                    <div className="flex justify-between text-xs text-gray-400 mt-1">
                      <span>0</span>
                      <span>50px</span>
                    </div>
                  </div>
                </div>
                <div>
                  <Label className="text-xs text-gray-500">Opacity</Label>
                  <div className="mt-1">
                    <Slider
                      defaultValue={[100]}
                      max={100}
                      step={1}
                      className="w-full"
                    />
                    <div className="flex justify-between text-xs text-gray-400 mt-1">
                      <span>0%</span>
                      <span>100%</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <Separator />

            {/* Typography Properties */}
            <div>
              <div className="flex items-center space-x-2 mb-3">
                <Type size={16} className="text-gray-600" />
                <h3 className="text-sm font-medium text-gray-900">Typography</h3>
              </div>
              <div className="space-y-3">
                <div>
                  <Label className="text-xs text-gray-500">Font Family</Label>
                  <Input placeholder="Inter" className="h-8 text-sm" />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label className="text-xs text-gray-500">Size</Label>
                    <Input placeholder="16px" className="h-8 text-sm" />
                  </div>
                  <div>
                    <Label className="text-xs text-gray-500">Weight</Label>
                    <Input placeholder="400" className="h-8 text-sm" />
                  </div>
                </div>
                <div>
                  <Label className="text-xs text-gray-500">Text Color</Label>
                  <div className="flex items-center space-x-2 mt-1">
                    <div className="w-8 h-8 bg-gray-900 rounded border border-gray-200"></div>
                    <Input placeholder="#000000" className="h-8 text-sm flex-1" />
                  </div>
                </div>
              </div>
            </div>

            <Separator />

            {/* Advanced Settings */}
            <div>
              <h3 className="text-sm font-medium text-gray-900 mb-3">Advanced</h3>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label className="text-sm text-gray-700">Visible</Label>
                  <Switch defaultChecked />
                </div>
                <div className="flex items-center justify-between">
                  <Label className="text-sm text-gray-700">Locked</Label>
                  <Switch />
                </div>
                <div className="flex items-center justify-between">
                  <Label className="text-sm text-gray-700">Clip Content</Label>
                  <Switch />
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Collapsed state - show minimal icons */}
      {isCollapsed && (
        <div className="flex flex-col items-center py-4 space-y-4">
          <Button variant="ghost" size="sm" className="p-2">
            <Settings size={18} className="text-gray-600" />
          </Button>
          <Button variant="ghost" size="sm" className="p-2">
            <Layout size={18} className="text-gray-600" />
          </Button>
          <Button variant="ghost" size="sm" className="p-2">
            <Palette size={18} className="text-gray-600" />
          </Button>
          <Button variant="ghost" size="sm" className="p-2">
            <Type size={18} className="text-gray-600" />
          </Button>
        </div>
      )}
    </div>
  );
});

RightSidebar.displayName = 'RightSidebar';

export default RightSidebar;

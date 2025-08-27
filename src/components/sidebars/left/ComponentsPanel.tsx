// src/components/sidebars/left/ComponentsPanel.tsx
// Components panel for adding new elements to the canvas
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import { Plus, Type, Square, Image, Container } from 'lucide-react';

/**
 * ComponentsPanel - Component library for adding new elements
 * 
 * Features:
 * - Basic component types (Text, Button, Image, Container)
 * - Layout components (Stack, Grid, Flex, Card)
 * - Drag-and-drop functionality (future)
 * 
 * Uses EditorUIStore directly - no prop drilling
 */
const ComponentsPanel = observer(() => {
  // Basic components that can be added to the canvas
  const basicComponents = [
    { id: 'text', name: 'Text', icon: Type, color: 'bg-purple-100 text-purple-600' },
    { id: 'button', name: 'Button', icon: Square, color: 'bg-green-100 text-green-600' },
    { id: 'image', name: 'Image', icon: Image, color: 'bg-orange-100 text-orange-600' },
    { id: 'container', name: 'Container', icon: Container, color: 'bg-blue-100 text-blue-600' },
  ];

  // Layout components
  const layoutComponents = [
    { id: 'stack', name: 'Stack', icon: Container, color: 'bg-purple-100 text-purple-600' },
    { id: 'grid', name: 'Grid', icon: Container, color: 'bg-pink-100 text-pink-600' },
    { id: 'flex', name: 'Flex', icon: Container, color: 'bg-cyan-100 text-cyan-600' },
    { id: 'card', name: 'Card', icon: Container, color: 'bg-gray-100 text-gray-600' },
  ];

  return (
    <div className="space-y-4">
      {/* Basic Components */}
      <div>
        <div className="flex items-center space-x-2 mb-3">
          <h3 className="text-sm font-medium text-gray-900">Basic</h3>
          <Plus size={14} className="text-gray-400" />
        </div>
        <div className="space-y-1">
          {basicComponents.map((component) => {
            const IconComponent = component.icon;
            return (
              <div
                key={component.id}
                className="flex items-center space-x-3 p-2 rounded hover:bg-gray-50 cursor-pointer transition-colors"
                onClick={() => {
                  console.log(`Add ${component.name} component`);
                  // TODO: Implement component addition logic
                }}
              >
                <div className={`p-1.5 rounded ${component.color}`}>
                  <IconComponent size={14} />
                </div>
                <span className="text-sm text-gray-700">{component.name}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Layout Components */}
      <div>
        <div className="flex items-center space-x-2 mb-3">
          <h3 className="text-sm font-medium text-gray-900">Layout</h3>
          <Plus size={14} className="text-gray-400" />
        </div>
        <div className="space-y-1">
          {layoutComponents.map((component) => {
            const IconComponent = component.icon;
            return (
              <div
                key={component.id}
                className="flex items-center space-x-3 p-2 rounded hover:bg-gray-50 cursor-pointer transition-colors"
                onClick={() => {
                  console.log(`Add ${component.name} layout`);
                  // TODO: Implement layout component addition logic
                }}
              >
                <div className={`p-1.5 rounded ${component.color}`}>
                  <IconComponent size={14} />
                </div>
                <span className="text-sm text-gray-700">{component.name}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});

ComponentsPanel.displayName = 'ComponentsPanel';

export default ComponentsPanel;


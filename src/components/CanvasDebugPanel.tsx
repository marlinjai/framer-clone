// src/components/CanvasDebugPanel.tsx
// Debug panel to show canvas element information
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import { useStore } from '@/hooks/useStore';
// import { addSampleImageToCanvas, addTextToCanvas, addComponentToCanvas } from '@/utils/canvasHelpers';

const CanvasDebugPanel = observer(() => {
  const rootStore = useStore();
  const currentPage = rootStore.editorUI.currentPage;
  
  if (!currentPage) return null;

  const handleAddImage = () => {
    console.log('Add image functionality temporarily disabled');
    // addSampleImageToCanvas(currentPage, 500, 400);
  };

  const handleAddText = () => {
    console.log('Add text functionality temporarily disabled');
    // addTextToCanvas(currentPage, 'New Text Element', 900, 300);
  };

  const handleAddComponent = () => {
    console.log('Add component functionality temporarily disabled');
    // addComponentToCanvas(currentPage, 1000, 200);
  };

  const handleClearAndReset = () => {
    console.log('Clear and reset functionality temporarily disabled');
    // Clear existing root canvas components (except viewport components)
    // const componentIds = currentPage.rootCanvasComponentsArray
    //   .filter(comp => !comp.id.startsWith('viewport-'))
    //   .map(comp => comp.id);
    // componentIds.forEach(id => currentPage.removeRootCanvasComponent(id));
    
    // Add new sample elements at visible positions
    // addSampleImageToCanvas(currentPage, 1600, 200);
    // addTextToCanvas(currentPage, 'Sample Text Element', 1700, 550);
  };

  return (
    <div className="fixed top-24 right-24 bg-white rounded-lg shadow-lg p-4 text-sm max-w-sm z-50">
      <h3 className="font-semibold mb-3">Canvas Debug Panel</h3>
      
      {/* Root Canvas Components Info */}
      <div className="mb-4">
        <div className="text-gray-600 mb-2">
          Floating Elements: {currentPage.floatingElements.length}
        </div>
        {currentPage.floatingElements.map((component) => (
          <div key={component.id} className="text-xs text-gray-500 mb-1">
            • {component.type} at ({component.canvasX || 0}, {component.canvasY || 0})
          </div>
        ))}
      </div>

      {/* Add Element Buttons */}
      <div className="space-y-2">
        <button
          onClick={handleClearAndReset}
          className="w-full px-3 py-1 bg-red-500 text-white rounded text-xs hover:bg-red-600"
        >
          Clear & Reset Elements
        </button>
        <button
          onClick={handleAddImage}
          className="w-full px-3 py-1 bg-blue-500 text-white rounded text-xs hover:bg-blue-600"
        >
          Add Image
        </button>
        <button
          onClick={handleAddText}
          className="w-full px-3 py-1 bg-green-500 text-white rounded text-xs hover:bg-green-600"
        >
          Add Text
        </button>
        <button
          onClick={handleAddComponent}
          className="w-full px-3 py-1 bg-purple-500 text-white rounded text-xs hover:bg-purple-600"
        >
          Add Component
        </button>
      </div>

      {/* Architecture Info */}
      <div className="mt-4 pt-3 border-t border-gray-200">
        <div className="text-gray-600 text-xs">
          <div>✓ Ground Wrapper Architecture</div>
          <div>✓ Component-Based Canvas Elements</div>
          <div>✓ Page-Specific Root Components</div>
          <div>✓ Framer-Style Positioning</div>
        </div>
      </div>
    </div>
  );
});

CanvasDebugPanel.displayName = 'CanvasDebugPanel';

export default CanvasDebugPanel;

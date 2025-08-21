// src/components/ComponentRenderer.tsx
// Renders ComponentModel instances to React elements
'use client';
import React from 'react';
import { observer } from 'mobx-react-lite';
import { ComponentInstance } from '../models/ComponentModel';
import { EditorUIType, EditorTool } from '../stores/EditorUIStore';

// Component Registry for function components
// In a real app, this would be dynamically populated
const ComponentRegistry: Record<string, React.ComponentType<any>> = {
  // Sample function components
  Card: ({ title, description, variant, onClick, disabled, ...props }) => (
    <div
      className={`
        p-6 rounded-lg shadow-md border cursor-pointer transition-all
        ${variant === 'primary' ? 'bg-blue-50 border-blue-200 hover:bg-blue-100' : ''}
        ${variant === 'secondary' ? 'bg-gray-50 border-gray-200 hover:bg-gray-100' : ''}
        ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
      `}
      onClick={disabled ? undefined : onClick}
      {...props}
    >
      <h3 className="text-lg font-semibold mb-2 text-gray-800">{title}</h3>
      <p className="text-gray-600">{description}</p>
    </div>
  ),

  Button: ({ variant, size, onClick, disabled, children, ...props }) => (
    <button
      className={`
        font-medium rounded transition-all focus:outline-none focus:ring-2 focus:ring-offset-2
        ${size === 'large' ? 'px-6 py-3 text-lg' : 'px-4 py-2 text-sm'}
        ${variant === 'primary' ? 'bg-blue-600 text-white hover:bg-blue-700 focus:ring-blue-500' : ''}
        ${variant === 'secondary' ? 'bg-gray-200 text-gray-800 hover:bg-gray-300 focus:ring-gray-500' : ''}
        ${variant === 'danger' ? 'bg-red-600 text-white hover:bg-red-700 focus:ring-red-500' : ''}
        ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
      `}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      {...props}
    >
      {children}
    </button>
  ),

  // Add more custom components as needed
};

// Props for the ComponentRenderer
interface ComponentRendererProps {
  component: ComponentInstance;
  className?: string;
  style?: React.CSSProperties;
  editorUI?: EditorUIType; // Optional for design-time interactions
}

// Recursive component renderer with MST observer for reactivity
const ComponentRenderer = observer(({ 
  component, 
  className,
  style,
  editorUI 
}: ComponentRendererProps) => {
  // Handle component selection clicks
  const handleComponentClick = (e: React.MouseEvent) => {
    // Only handle clicks if we have editorUI and SELECT tool is active
    if (!editorUI || editorUI.selectedTool !== EditorTool.SELECT) {
      return;
    }
    
    // Prevent event bubbling to parent components
    e.stopPropagation();
    
    // Select this component
    editorUI.selectComponent(component);
  };
  // Handle host elements (intrinsic HTML elements)
  if (component.isHostElement) {
    const elementType = component.type as keyof React.JSX.IntrinsicElements;
    
    // Merge props with any additional props (excluding key)
    const mergedProps = {
      ...component.props,
      className: className ? `${component.props.className || ''} ${className}`.trim() : component.props.className,
      style: style ? { ...component.props.style, ...style } : component.props.style,
      // Add data attribute for selection system
      'data-component-id': component.id,
      // Add click handler for selection (only if editorUI is provided)
      onClick: editorUI ? (e: React.MouseEvent) => {
        // Call original onClick if it exists
        if (component.props.onClick) {
          component.props.onClick(e);
        }
        // Handle selection
        handleComponentClick(e);
      } : component.props.onClick,
    };

    // Render children recursively
    const children = component.children.length > 0 
      ? component.children.map((child: ComponentInstance) => (
          <ComponentRenderer key={child.id} component={child} editorUI={editorUI} />
        ))
      : component.props.children; // Use props.children if no component children

    // Create the React element with key passed separately
    return React.createElement(elementType as string, { key: component.id, ...mergedProps }, children);
  }

  // Handle function components
  if (component.isFunctionComponent) {
    const ComponentFunction = ComponentRegistry[component.type];
    
    if (!ComponentFunction) {
      // Fallback for unknown components
      return (
        <div 
          className="border-2 border-dashed border-red-300 bg-red-50 p-4 rounded"
          style={style}
        >
          <div className="text-red-600 font-medium">Unknown Component: {component.type}</div>
          <div className="text-red-500 text-sm">Component not found in registry</div>
        </div>
      );
    }

    // Merge props and render children (excluding key)
    const mergedProps = {
      ...component.props,
      className: className ? `${component.props.className || ''} ${className}`.trim() : component.props.className,
      style: style ? { ...component.props.style, ...style } : component.props.style,
      // Add data attribute for selection system
      'data-component-id': component.id,
      // Add click handler for selection (only if editorUI is provided)
      onClick: editorUI ? (e: React.MouseEvent) => {
        // Call original onClick if it exists
        if (component.props.onClick) {
          component.props.onClick(e);
        }
        // Handle selection
        handleComponentClick(e);
      } : component.props.onClick,
    };

    // Add children if they exist
    if (component.children.length > 0) {
      mergedProps.children = component.children.map((child: ComponentInstance) => (
        <ComponentRenderer key={child.id} component={child} editorUI={editorUI} />
      ));
    }

    // Render the function component with key passed separately
    return <ComponentFunction key={component.id} {...mergedProps} />;
  }

  // Fallback for unknown component types
  return (
    <div className="border-2 border-dashed border-yellow-300 bg-yellow-50 p-4 rounded">
      <div className="text-yellow-600 font-medium">Invalid Component</div>
      <div className="text-yellow-500 text-sm">Type: {component.type}</div>
    </div>
  );
});

ComponentRenderer.displayName = 'ComponentRenderer';

export default ComponentRenderer;

// Export the component registry for external registration
export { ComponentRegistry };

// Helper function to register new components
export const registerComponent = (name: string, component: React.ComponentType<any>) => {
  ComponentRegistry[name] = component;
};

// Helper function to check if a component is registered
export const isComponentRegistered = (name: string): boolean => {
  return name in ComponentRegistry;
};

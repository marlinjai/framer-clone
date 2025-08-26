// src/utils/canvasHelpers.ts
// Utility functions for working with root canvas components (Framer-style architecture)
import { v4 as uuidv4 } from 'uuid';
import { createRootCanvasComponent, createIntrinsicComponent, ComponentInstance } from '../models/ComponentModel';
import { PageModelType } from '../models/PageModel';

/**
 * Add a sample image to the canvas at the specified position
 * In the new architecture, this creates a root canvas component with absolute positioning
 */
export function addSampleImageToCanvas(page: PageModelType, x: number, y: number): ComponentInstance {
  const imageComponent = createRootCanvasComponent(
    uuidv4(),
    'img',
    {
      src: 'https://picsum.photos/400/300',
      alt: 'Sample image',
      width: '400px',
      height: '300px',
      style: {
        objectFit: 'cover',
        borderRadius: '8px',
      }
    },
    x,
    y
  );

  page.addRootCanvasComponent(imageComponent);
  return imageComponent;
}

/**
 * Add a text element to the canvas at the specified position
 */
export function addTextToCanvas(page: PageModelType, text: string, x: number, y: number): ComponentInstance {
  const textComponent = createRootCanvasComponent(
    uuidv4(),
    'div',
    {
      children: text,
      style: {
        width: '300px',
        height: '100px',
        fontSize: '16px',
        fontFamily: 'Inter, sans-serif',
        color: '#000000',
        padding: '8px',
        boxSizing: 'border-box',
        whiteSpace: 'pre-wrap',
        userSelect: 'none',
        border: '2px solid blue',
        backgroundColor: 'rgba(255, 255, 255, 0.9)',
      }
    },
    x,
    y
  );

  page.addRootCanvasComponent(textComponent);
  return textComponent;
}

/**
 * Add a generic component to the canvas
 */
export function addComponentToCanvas(page: PageModelType, x: number, y: number): ComponentInstance {
  const component = createRootCanvasComponent(
    uuidv4(),
    'div',
    {
      children: 'New Component',
      style: {
        width: '200px',
        height: '100px',
        backgroundColor: '#f3f4f6',
        border: '2px solid #d1d5db',
        borderRadius: '8px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '14px',
        fontFamily: 'Inter, sans-serif',
        color: '#374151',
      }
    },
    x,
    y
  );

  page.addRootCanvasComponent(component);
  return component;
}

/**
 * Create a breakpoint viewport component (positioned on canvas)
 * This represents the viewport/frame for a specific breakpoint
 */
export function createBreakpointViewportComponent(
  viewportId: string,
  breakpointId: string,
  x: number,
  y: number,
  width: number
): ComponentInstance {
  return createRootCanvasComponent(
    viewportId,
    'div',
    {
      'data-breakpoint': breakpointId,
      className: 'breakpoint-viewport-content',
      style: {
        width: `${width}px`,
        minHeight: '600px',
        backgroundColor: 'white',
        borderRadius: '8px',
        boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)',
        overflow: 'hidden',
      }
    },
    x,
    y
  );
}
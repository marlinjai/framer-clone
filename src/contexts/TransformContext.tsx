/* eslint-disable @typescript-eslint/no-explicit-any */
// src/contexts/TransformContext.tsx
// High-performance canvas transform context with ref + subscription model
//
// This system enables zero-React-render canvas transforms by:
// 1. Storing transform state in a React ref (doesn't trigger re-renders)
// 2. Using a subscription pattern for components that need transform updates
// 3. Allowing direct DOM manipulation for smooth 60fps performance
//
// Architecture:
// - Canvas updates transformState.current directly
// - Canvas calls notifySubscribers() after each transform
// - HudSurface subscribes and updates overlay positions via DOM manipulation
// - No React re-renders during pan/zoom operations
'use client';
import React, { createContext, useContext, useRef, MutableRefObject } from 'react';

interface CanvasTransform {
  zoom: number;   // Current zoom level (1.0 = 100%, 0.5 = 50%, 2.0 = 200%)
  panX: number;   // Horizontal pan offset in pixels
  panY: number;   // Vertical pan offset in pixels
}

interface TransformContextValue {
  // Transform state as ref (no React re-renders when changed)
  state: MutableRefObject<CanvasTransform>;
  // Subscribe to transform updates (returns unsubscribe function)
  subscribe: (callback: () => void) => () => void;
}

const TransformContext = createContext<TransformContextValue | null>(null);

interface TransformProviderProps {
  children: React.ReactNode;
}

/**
 * TransformProvider - High-performance canvas transform state management
 * 
 * This provider implements a ref + subscription pattern that enables:
 * - 60fps smooth pan/zoom without React re-renders
 * - Direct DOM manipulation for overlays and UI elements
 * - Clean subscription management with automatic cleanup
 * 
 * Key Design Decisions:
 * 1. Transform state stored in useRef (mutable, no re-renders)
 * 2. Subscribers stored in useRef Set (stable across renders)
 * 3. Subscribe function returns unsubscribe callback (React useEffect pattern)
 * 4. Canvas calls notifySubscribers() after each transform update
 * 
 * Performance Benefits:
 * - Zero React re-renders during transform operations
 * - Direct DOM updates for overlays (no virtual DOM diffing)
 * - Minimal memory allocations (reused refs and callbacks)
 * - Efficient subscription management (Set for O(1) add/remove)
 */
export const TransformProvider: React.FC<TransformProviderProps> = ({ children }) => {
  // Transform state as ref - this is the single source of truth for canvas transforms
  // Using ref ensures mutations don't trigger React re-renders
  const transformState = useRef<CanvasTransform>({
    zoom: 1,    // Start at 100% zoom
    panX: 0,    // Start at origin
    panY: 0
  });
  
  // Set of subscriber callbacks - called when transform changes
  // Using ref ensures Set instance is stable across re-renders
  const subscribers = useRef<Set<() => void>>(new Set());
  
  /**
   * Subscribe to transform updates
   * 
   * @param callback - Function to call when transform changes
   * @returns Unsubscribe function for cleanup
   * 
   * Usage:
   * ```typescript
   * useEffect(() => {
   *   const unsubscribe = subscribe(() => {
   *     // Update your overlay/UI here
   *   });
   *   return unsubscribe; // Cleanup on unmount
   * }, [subscribe]);
   * ```
   */
  const subscribe = (callback: () => void): (() => void) => {
    subscribers.current.add(callback);
    
    // Return unsubscribe function for React useEffect cleanup
    return () => {
      subscribers.current.delete(callback);
    };
  };
  
  /**
   * Notify all subscribers of transform changes
   * 
   * Called by Canvas after each transform update (pan, zoom, etc.)
   * This triggers direct DOM updates in subscribed components
   */
  const notifySubscribers = () => {
    subscribers.current.forEach(callback => callback());
  };
  
  const contextValue: TransformContextValue = {
    state: transformState,
    subscribe
  };
  
  // Expose notifySubscribers for Canvas to call
  // Using type assertion since it's an internal implementation detail
  (contextValue as any).notifySubscribers = notifySubscribers;
  
  return (
    <TransformContext.Provider value={contextValue}>
      {children}
    </TransformContext.Provider>
  );
};

/**
 * Hook to access transform context
 */
export const useTransformContext = () => {
  const context = useContext(TransformContext);
  if (!context) {
    throw new Error('useTransformContext must be used within a TransformProvider');
  }
  return context;
};

/**
 * Hook for Canvas.tsx to get notifySubscribers function
 */
export const useTransformNotifier = () => {
  const context = useContext(TransformContext);
  if (!context) {
    throw new Error('useTransformNotifier must be used within a TransformProvider');
  }
  return (context as any).notifySubscribers as () => void;
};

export default TransformContext;

// src/contexts/TransformContext.tsx
// High-performance canvas transform context with ref + subscription model
'use client';
import React, { createContext, useContext, useRef, MutableRefObject } from 'react';

interface CanvasTransform {
  zoom: number;
  panX: number;
  panY: number;
}

interface TransformContextValue {
  // Transform state as ref (no React re-renders)
  state: MutableRefObject<CanvasTransform>;
  // Subscribe to transform updates
  subscribe: (callback: () => void) => () => void;
}

const TransformContext = createContext<TransformContextValue | null>(null);

interface TransformProviderProps {
  children: React.ReactNode;
}

/**
 * TransformProvider - Provides canvas transform state via ref + subscription
 * 
 * Key benefits:
 * - Transform updates don't trigger React re-renders
 * - Components can subscribe to updates for direct DOM manipulation
 * - Clean unsubscribe pattern for proper cleanup
 */
export const TransformProvider: React.FC<TransformProviderProps> = ({ children }) => {
  // Transform state as ref (never causes re-renders)
  const transformState = useRef<CanvasTransform>({
    zoom: 1,
    panX: 0,
    panY: 0
  });
  
  // Set of subscribers (callbacks to call on transform updates)
  const subscribers = useRef<Set<() => void>>(new Set());
  
  // Subscribe function - returns unsubscribe callback
  const subscribe = (callback: () => void): (() => void) => {
    subscribers.current.add(callback);
    
    // Return unsubscribe function
    return () => {
      subscribers.current.delete(callback);
    };
  };
  
  // Notify all subscribers (called by Canvas after transform updates)
  const notifySubscribers = () => {
    subscribers.current.forEach(callback => callback());
  };
  
  const contextValue: TransformContextValue = {
    state: transformState,
    subscribe
  };
  
  // Expose notifySubscribers for Canvas to call
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

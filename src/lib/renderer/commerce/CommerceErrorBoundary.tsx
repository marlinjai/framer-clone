/* eslint-disable @typescript-eslint/no-explicit-any */
// CommerceErrorBoundary: catches a render failure inside ONE interactive commerce
// control (variant selector, add to cart, cart, checkout button) and shows a
// visible, recoverable message in the node's own host element instead of
// blanking the page around it. Used by the published page's islands
// (server/CommerceIsland) and by the editor canvas and preview
// (createComponentElement), where an uncaught throw would otherwise take down
// the whole editor. The error is logged, never swallowed.
'use client';

import React from 'react';

export type CommerceControlKind = 'variant-selector' | 'add-to-cart' | 'cart-view' | 'checkout-button';

interface CommerceErrorBoundaryProps {
  kind: CommerceControlKind;
  hostType: string;
  hostProps: Record<string, unknown>;
  children: React.ReactNode;
}

export class CommerceErrorBoundary extends React.Component<CommerceErrorBoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error(`CommerceErrorBoundary: the ${this.props.kind} control failed to render.`, error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    const wrapperProps = { ...this.props.hostProps };
    delete (wrapperProps as any).children;
    return React.createElement(
      this.props.hostType as any,
      { ...wrapperProps, 'data-island-error': this.props.kind },
      <span role="alert" style={{ display: 'block', color: '#b91c1c', fontFamily: 'inherit', fontSize: '13px' }}>
        This part of the shop could not be loaded.{' '}
        <button
          type="button"
          onClick={() => this.setState({ failed: false })}
          style={{ font: 'inherit', textDecoration: 'underline', background: 'none', border: 0, padding: 0, color: 'inherit', cursor: 'pointer' }}
        >
          Try again
        </button>
      </span>,
    );
  }
}

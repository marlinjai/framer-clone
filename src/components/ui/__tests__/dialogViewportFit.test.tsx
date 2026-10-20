// Every modal dialog fits the viewport (a live check found the page settings
// dialog overflowing an 800x480 window with Save and Cancel off screen). jsdom
// cannot lay out, so the classes that do the fitting are asserted, plus the
// behaviour that does not need layout (a consumer cannot undo the fit; a long
// alert message becomes a keyboard stop only while it overflows).
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../dialog';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../alert-dialog';
import { classesOf, expectBodyScrollsFooterFixed, expectViewportFitPanel } from './viewportFit';

afterEach(() => cleanup());

describe('DialogContent', () => {
  it('fits the viewport, with a fixed header and footer around a scrolling body', () => {
    render(
      <Dialog open>
        <DialogContent data-testid="panel" className="max-w-[520px]">
          <DialogHeader data-testid="header">
            <DialogTitle>Title</DialogTitle>
            <DialogDescription>Description</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <p data-testid="content">Long content</p>
          </DialogBody>
          <DialogFooter>Buttons</DialogFooter>
        </DialogContent>
      </Dialog>,
    );
    const panel = screen.getByTestId('panel');
    expectBodyScrollsFooterFixed(panel, screen.getByTestId('content'));
    // A consumer's own width still applies on top of the viewport cap.
    expect(classesOf(panel)).toContain('max-w-[520px]');
    expect(classesOf(screen.getByTestId('header'))).toContain('shrink-0');
  });

  it('cannot be undone by a consumer className', () => {
    render(
      <Dialog open>
        <DialogContent data-testid="panel" className="grid w-full max-h-[85vh]">
          <DialogTitle>Title</DialogTitle>
          <DialogDescription>Description</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    const classes = classesOf(screen.getByTestId('panel'));
    expectViewportFitPanel(screen.getByTestId('panel'));
    expect(classes).not.toContain('w-full');
    expect(classes).not.toContain('max-h-[85vh]');
  });
});

describe('AlertDialogContent', () => {
  function renderAlert() {
    render(
      <AlertDialog open>
        <AlertDialogContent data-testid="panel">
          <AlertDialogHeader data-testid="header">
            <AlertDialogTitle data-testid="title">Delete?</AlertDialogTitle>
            <AlertDialogDescription data-testid="message">Long message</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter data-testid="footer">Buttons</AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>,
    );
  }

  it('fits the viewport; the title and buttons stay, the message scrolls', () => {
    renderAlert();
    expectViewportFitPanel(screen.getByTestId('panel'));
    expect(classesOf(screen.getByTestId('header'))).toEqual(
      expect.arrayContaining(['min-h-0', 'flex-1', 'flex-col']),
    );
    expect(classesOf(screen.getByTestId('header'))).not.toContain('overflow-y-auto');
    expect(classesOf(screen.getByTestId('message'))).toEqual(
      expect.arrayContaining(['min-h-0', 'flex-1', 'overflow-y-auto']),
    );
    expect(classesOf(screen.getByTestId('footer'))).toContain('shrink-0');
  });

  it('makes the message a keyboard stop only while it overflows', () => {
    renderAlert();
    const message = screen.getByTestId('message');
    expect(message.getAttribute('tabindex')).toBeNull();
    expect(message.getAttribute('role')).toBeNull();

    // jsdom has no layout: simulate a message taller than its box, then let
    // the description measure again (the ResizeObserver path is not available
    // in jsdom, so remount it).
    cleanup();
    const scrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
    const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 600 });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 120 });
    try {
      act(() => renderAlert());
      const overflowing = screen.getByTestId('message');
      expect(overflowing.getAttribute('tabindex')).toBe('0');
      expect(overflowing.getAttribute('role')).toBe('region');
      expect(overflowing.getAttribute('aria-label')).toBe('Details');
    } finally {
      // jsdom defines these on Element.prototype, so without an own descriptor
      // the override must be deleted, not restored.
      if (scrollHeight) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', scrollHeight);
      else delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
      if (clientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientHeight);
      else delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
    }
  });
});

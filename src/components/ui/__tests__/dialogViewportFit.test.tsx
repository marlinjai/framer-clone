// Every modal dialog fits the viewport (a live check found the page settings
// dialog overflowing an 800x480 window with Save and Cancel off screen). jsdom
// cannot lay out, so these assert the classes that do the fitting: the panel is
// capped at the viewport height and width and is a column, the header and
// footer never shrink, and the body takes the rest and scrolls.
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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
import { DIALOG_VIEWPORT_FIT_CLASSES } from '../dialog-fit';

afterEach(() => cleanup());

function classesOf(el: Element | null): string[] {
  return (el?.getAttribute('class') ?? '').split(/\s+/);
}

/** The panel fits the viewport: capped height and width, a column, scroll fallback. */
function expectViewportFit(panel: Element | null) {
  const classes = classesOf(panel);
  expect(classes).toContain('max-h-[calc(100dvh-2rem)]');
  expect(classes).toContain('w-[calc(100vw-2rem)]');
  expect(classes).toContain('flex');
  expect(classes).toContain('flex-col');
  expect(classes).toContain('overflow-y-auto');
  expect(classes).not.toContain('grid');
}

describe('DialogContent', () => {
  it('fits the viewport, with a fixed header and footer around a scrolling body', () => {
    render(
      <Dialog open>
        <DialogContent data-testid="panel" className="max-w-[520px]">
          <DialogHeader data-testid="header">
            <DialogTitle>Title</DialogTitle>
            <DialogDescription>Description</DialogDescription>
          </DialogHeader>
          <DialogBody data-testid="body">Long content</DialogBody>
          <DialogFooter data-testid="footer">Buttons</DialogFooter>
        </DialogContent>
      </Dialog>,
    );
    const panel = screen.getByTestId('panel');
    expectViewportFit(panel);
    // A consumer's own width still applies on top of the viewport cap.
    expect(classesOf(panel)).toContain('max-w-[520px]');
    expect(classesOf(screen.getByTestId('header'))).toContain('shrink-0');
    expect(classesOf(screen.getByTestId('footer'))).toContain('shrink-0');
    const body = classesOf(screen.getByTestId('body'));
    expect(body).toEqual(expect.arrayContaining(['min-h-0', 'flex-1', 'overflow-y-auto']));
  });

  it('exposes the shared class list', () => {
    expect(DIALOG_VIEWPORT_FIT_CLASSES).toContain('max-h-[calc(100dvh-2rem)]');
  });
});

describe('AlertDialogContent', () => {
  it('fits the viewport; a long message scrolls and the buttons stay on screen', () => {
    render(
      <AlertDialog open>
        <AlertDialogContent data-testid="panel">
          <AlertDialogHeader data-testid="header">
            <AlertDialogTitle>Delete?</AlertDialogTitle>
            <AlertDialogDescription>Long message</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter data-testid="footer">Buttons</AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>,
    );
    expectViewportFit(screen.getByTestId('panel'));
    expect(classesOf(screen.getByTestId('header'))).toEqual(
      expect.arrayContaining(['min-h-0', 'flex-1', 'overflow-y-auto']),
    );
    expect(classesOf(screen.getByTestId('footer'))).toContain('shrink-0');
  });
});

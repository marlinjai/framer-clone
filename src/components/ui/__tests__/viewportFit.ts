// Shared assertions for "this overlay fits the viewport". jsdom cannot lay
// out, so these check the classes that do the fitting (src/components/ui/dialog-fit.ts). Not a test file itself..
import { expect } from 'vitest';

export function classesOf(el: Element | null | undefined): string[] {
  return (el?.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
}

/** A modal panel capped at the viewport, laid out as a column, with a scroll fallback. */
export function expectViewportFitPanel(panel: Element | null | undefined): void {
  expect(classesOf(panel)).toEqual(
    expect.arrayContaining([
      'flex',
      'flex-col',
      'w-[calc(100vw-2rem)]',
      'max-h-[calc(100vh-2rem)]',
      'supports-[height:100dvh]:max-h-[calc(100dvh-2rem)]',
      'overflow-y-auto',
    ]),
  );
  expect(classesOf(panel)).not.toContain('grid');
}

/**
 * The dialog's scrolling body holds `inside`, and the footer (when there is
 * one) sits outside the body, so the buttons never scroll away.
 */
export function expectBodyScrollsFooterFixed(dialog: Element, inside: Element): void {
  expectViewportFitPanel(dialog);
  const body = dialog.querySelector('[data-slot="dialog-body"]');
  expect(body).not.toBeNull();
  expect(classesOf(body)).toEqual(expect.arrayContaining(['min-h-0', 'flex-1', 'overflow-y-auto']));
  expect(body!.contains(inside)).toBe(true);
  const footer = dialog.querySelector('[data-slot="dialog-footer"]');
  if (footer) {
    expect(classesOf(footer)).toContain('shrink-0');
    expect(body!.contains(footer)).toBe(false);
  }
}

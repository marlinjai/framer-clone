// test/setup.client.ts
//
// jsdom polyfills for Radix UI primitives (dropdown-menu, alert-dialog, dialog,
// select, ...). jsdom does not implement Pointer Capture, scrollIntoView, or
// ResizeObserver, which Radix calls during open/close. These are no-op shims so
// the components mount and respond to events under test. Additive only.
//
// Guarded for the DOM: files in the jsdom project that opt into the node
// environment (`// @vitest-environment node`) also run this setup, and there
// `Element`/`window` do not exist. Only apply the polyfills when a DOM is present.

if (typeof Element !== 'undefined') {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {};
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
}

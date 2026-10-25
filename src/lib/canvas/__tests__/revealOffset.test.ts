// Keeping the text being edited above the on-screen keyboard: how far the
// camera pans (src/components/PhoneEditorChrome.tsx applies it).
import { describe, it, expect } from 'vitest';
import { revealOffset } from '../cameraControls';

// A 390x844 phone with a 48px top bar and the keyboard covering the bottom 336px.
const visible = { top: 48, bottom: 508, left: 0, right: 390 };

describe('revealOffset', () => {
  it('leaves a text that already fits where it is', () => {
    expect(revealOffset({ top: 200, bottom: 240, left: 20, right: 300 }, visible)).toEqual({ dx: 0, dy: 0 });
  });

  it('pans a text under the keyboard up until it clears it by the margin', () => {
    const { dx, dy } = revealOffset({ top: 600, bottom: 640, left: 20, right: 300 }, visible, 16);
    expect(dx).toBe(0);
    expect(dy).toBe(508 - 16 - 640);
  });

  it('pans a text above the top bar down', () => {
    expect(revealOffset({ top: 10, bottom: 40, left: 20, right: 300 }, visible, 16).dy).toBe(48 + 16 - 10);
  });

  it('aligns a text taller than the room at its top', () => {
    expect(revealOffset({ top: 300, bottom: 1300, left: 20, right: 300 }, visible, 16).dy).toBe(48 + 16 - 300);
  });

  it('pans sideways for a text off the side of the screen', () => {
    expect(revealOffset({ top: 200, bottom: 240, left: 400, right: 500 }, visible, 16).dx).toBe(390 - 16 - 500);
  });
});

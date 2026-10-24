// Which breakpoint the preview opens with on a narrow window (a phone).
import { describe, expect, it } from 'vitest';
import { viewportForWindow } from '../PreviewShell';

const frames = [
  { viewportWidth: 1280, viewportHeight: 800 },
  { viewportWidth: 768, viewportHeight: 1024 },
  { viewportWidth: 320, viewportHeight: 640 },
];

describe('viewportForWindow', () => {
  it('keeps the widest frame when it fits (desktop, unchanged behaviour)', () => {
    expect(viewportForWindow(frames, 1440)).toBeNull();
    expect(viewportForWindow(frames, 1280)).toBeNull();
  });

  it('picks the widest frame that fits a narrower window', () => {
    expect(viewportForWindow(frames, 390)).toEqual({ width: 320, height: 640 });
    expect(viewportForWindow(frames, 1024)).toEqual({ width: 768, height: 1024 });
  });

  it('falls back to the narrowest frame when none fits, and to 800 high without a height', () => {
    expect(viewportForWindow(frames, 300)).toEqual({ width: 320, height: 640 });
    expect(viewportForWindow([{ viewportWidth: 1280 }, { viewportWidth: 500 }], 400)).toEqual({ width: 500, height: 800 });
    expect(viewportForWindow([], 390)).toBeNull();
  });
});

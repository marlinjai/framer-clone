// The loading placeholder (../placeholder): shown only once a wait is noticeable, breathes only without
// reduced motion, fades out with the scene and gives the box back.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FX_FADE_MS } from '../box';
import { FX_PLACEHOLDER_DELAY_MS, showFxPlaceholder } from '../placeholder';

const placeholders = () => document.querySelectorAll('[data-fc-fx-placeholder]');

describe('showFxPlaceholder', () => {
  let box: HTMLElement;
  let animate: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    box = document.createElement('div');
    document.body.appendChild(box);
    animate = vi.fn(() => ({ cancel: vi.fn() }));
    (HTMLElement.prototype as unknown as { animate: unknown }).animate = animate;
  });
  afterEach(() => {
    vi.useRealTimers();
    box.remove();
  });

  it('a scene that is there before the delay never shows it, and the box is untouched', () => {
    const placeholder = showFxPlaceholder(box, { reduce: false });
    vi.advanceTimersByTime(FX_PLACEHOLDER_DELAY_MS - 1);
    placeholder.remove();
    vi.advanceTimersByTime(FX_PLACEHOLDER_DELAY_MS * 3);
    expect(placeholders()).toHaveLength(0);
    expect(box.getAttribute('style')).toBeNull();
  });

  it('a longer wait shows it behind the content, breathing, and it fades out and gives the box back', () => {
    const placeholder = showFxPlaceholder(box, { reduce: false });
    vi.advanceTimersByTime(FX_PLACEHOLDER_DELAY_MS);
    const [element] = placeholders() as NodeListOf<HTMLElement>;
    expect(element).toBeDefined();
    expect(element.getAttribute('aria-hidden')).toBe('true');
    expect(element.style.zIndex).toBe('-1');
    expect(element.style.pointerEvents).toBe('none');
    expect(element.style.opacity).toBe('1');
    expect(box.style.isolation).toBe('isolate');
    expect(animate).toHaveBeenCalledTimes(1);
    placeholder.remove();
    expect(element.style.opacity).toBe('0');
    expect(placeholders()).toHaveLength(1);
    vi.advanceTimersByTime(FX_FADE_MS);
    expect(placeholders()).toHaveLength(0);
    expect(box.style.isolation).toBe('');
    expect(box.style.position).toBe('');
  });

  it('a placeholder that comes after the scene layer sits behind it in the tree: the layer stays the first child', () => {
    const layer = document.createElement('div');
    layer.setAttribute('data-fc-fx-layer', '');
    box.appendChild(layer);
    showFxPlaceholder(box, { reduce: false });
    vi.advanceTimersByTime(FX_PLACEHOLDER_DELAY_MS);
    expect(box.firstElementChild).toBe(layer);
    expect(layer.nextElementSibling?.hasAttribute('data-fc-fx-placeholder')).toBe(true);
  });

  it('removed now (the page is put away): gone at once, and the box is its own again at once', () => {
    const placeholder = showFxPlaceholder(box, { reduce: false });
    vi.advanceTimersByTime(FX_PLACEHOLDER_DELAY_MS);
    placeholder.remove({ now: true });
    expect(placeholders()).toHaveLength(0);
    expect(box.style.isolation).toBe('');
  });

  it('under reduced motion it shows, still, without breathing', () => {
    showFxPlaceholder(box, { reduce: true });
    vi.advanceTimersByTime(FX_PLACEHOLDER_DELAY_MS);
    expect(placeholders()).toHaveLength(1);
    expect(animate).not.toHaveBeenCalled();
  });
});
// ci-replay touch

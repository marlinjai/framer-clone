// The haptics module: feature detection picks the Vibration API or the iOS
// switch, nothing ever throws, and the person's setting is respected.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HAPTICS_STORAGE_KEY,
  HAPTIC_TICK_MS,
  haptic,
  hapticsEnabled,
  hapticsSupported,
  onHapticsPreferenceChange,
  resetHapticsForTests,
  setHapticsEnabled,
} from '../haptics';

const proto = HTMLInputElement.prototype as unknown as Record<string, unknown>;
const nav = navigator as unknown as Record<string, unknown>;

function stubVibrate(fn: (ms: number) => boolean) {
  Object.defineProperty(navigator, 'vibrate', { value: fn, configurable: true, writable: true });
}

beforeEach(() => {
  resetHapticsForTests();
  window.localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  delete nav.vibrate;
  delete proto.switch;
  resetHapticsForTests();
});

describe('haptic()', () => {
  it('vibrates for one short tick where the Vibration API exists', () => {
    const vibrate = vi.fn(() => true);
    stubVibrate(vibrate);
    expect(hapticsSupported()).toBe(true);
    expect(haptic()).toBe('vibrate');
    expect(vibrate).toHaveBeenCalledWith(HAPTIC_TICK_MS);
  });

  it('clicks the hidden switch label where only the switch control exists (iOS 18)', () => {
    proto.switch = false;
    const click = vi.spyOn(HTMLLabelElement.prototype, 'click');
    expect(hapticsSupported()).toBe(true);
    expect(haptic()).toBe('switch');
    expect(click).toHaveBeenCalledTimes(1);
    const label = document.querySelector('label[data-haptics]') as HTMLLabelElement;
    expect(label).not.toBeNull();
    expect(label.querySelector('input')?.hasAttribute('switch')).toBe(true);
    expect(label.getAttribute('aria-hidden')).toBe('true');
    // Rendered (not display: none, it must toggle), and out of sight.
    expect(label.style.display).not.toBe('none');
    expect(label.style.opacity).toBe('0');
    // Reused, never duplicated.
    haptic();
    expect(document.querySelectorAll('label[data-haptics]')).toHaveLength(1);
  });

  it('does nothing, silently, where neither exists', () => {
    expect(hapticsSupported()).toBe(false);
    expect(haptic()).toBe('none');
    expect(document.querySelector('label[data-haptics]')).toBeNull();
  });

  it('never throws when the platform does', () => {
    stubVibrate(() => {
      throw new Error('blocked');
    });
    expect(() => haptic()).not.toThrow();
    expect(haptic()).toBe('none');
  });
});

describe('the setting', () => {
  it('is on by default and remembered when turned off', () => {
    expect(hapticsEnabled()).toBe(true);
    setHapticsEnabled(false);
    expect(window.localStorage.getItem(HAPTICS_STORAGE_KEY)).toBe('off');
    resetHapticsForTests();
    expect(hapticsEnabled()).toBe(false);
    setHapticsEnabled(true);
    resetHapticsForTests();
    expect(hapticsEnabled()).toBe(true);
  });

  it('off means no tick', () => {
    const vibrate = vi.fn(() => true);
    stubVibrate(vibrate);
    setHapticsEnabled(false);
    expect(haptic()).toBe('none');
    expect(vibrate).not.toHaveBeenCalled();
  });

  it('still works for the session when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(hapticsEnabled()).toBe(true);
    expect(() => setHapticsEnabled(false)).not.toThrow();
    expect(hapticsEnabled()).toBe(false);
  });

  it('tells listeners', () => {
    const seen: boolean[] = [];
    const stop = onHapticsPreferenceChange((on) => seen.push(on));
    setHapticsEnabled(false);
    setHapticsEnabled(true);
    stop();
    setHapticsEnabled(false);
    expect(seen).toEqual([false, true]);
  });
});

// src/lib/haptics.ts
//
// Haptic feedback for the phone editor (plan docs/plans/2026-10-24-editor-on-phones.md,
// section "Quick toolbar"): a light tick when a touch selects an element, on
// each stepper step, and when a long-press opens the context menu.
//
// Progressive enhancement only. Nothing here may throw, and nothing touches
// `document` or `window` at import time (the module is imported by components
// that also render on the server).
//
// Two mechanisms, picked by feature detection:
//
//  1. The Vibration API, `navigator.vibrate(ms)`: Android Chrome and Firefox.
//
//  2. iOS Safari has no Vibration API. Since iOS 18, a native switch control
//     (`<input type="checkbox" switch>`, WebKit's `switch` attribute, exposed
//     as `HTMLInputElement.prototype.switch`) plays the system selection
//     haptic when it toggles, and toggling it through a click on its <label>
//     does the same. We keep one such switch, invisible and off-screen (not
//     display: none, which would stop it from toggling as a rendered control),
//     and click its label.
//
//     THIS RELIES ON UNDOCUMENTED PLATFORM BEHAVIOUR THAT MAY CHANGE. Apple
//     does not promise a haptic for a programmatic label click; a future iOS
//     may drop it, or require transient user activation. That is why callers
//     must call `haptic()` synchronously inside the user gesture (a click or
//     pointerup handler). Note that for touch input the browser's user
//     activation begins at pointerup, so a tick from a long-press timer runs
//     outside activation: it may simply not be felt, which is fine. If the
//     platform stops honouring it, the call stays a silent no-op.
//
// The person can turn haptics off (the phone top bar's More menu); the choice
// is a local preference in localStorage, read and written inside try/catch
// because storage can be unavailable (private mode, sandboxed frames).

export const HAPTICS_STORAGE_KEY = 'framer-clone.haptics';

/** Vibration length for one tick, in milliseconds (a light tap, not a buzz). */
export const HAPTIC_TICK_MS = 10;

type Listener = (enabled: boolean) => void;
const listeners = new Set<Listener>();

/** In-memory fallback when storage is unavailable: the toggle still works for this session. */
let memoryPreference: boolean | undefined;

/** Whether the person wants haptics. On unless turned off. */
export function hapticsEnabled(): boolean {
  if (memoryPreference !== undefined) return memoryPreference;
  try {
    if (typeof window === 'undefined') return true;
    return window.localStorage.getItem(HAPTICS_STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

/** Turn haptics on or off (remembered on this device). */
export function setHapticsEnabled(enabled: boolean): void {
  memoryPreference = enabled;
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(HAPTICS_STORAGE_KEY, enabled ? 'on' : 'off');
  } catch {
    // Storage refused: the in-memory value above still holds for this session.
  }
  for (const l of listeners) {
    try {
      l(enabled);
    } catch {
      // A listener's failure must not break the toggle.
    }
  }
}

/** Subscribe to the preference (for the settings toggle). Returns the unsubscribe. */
export function onHapticsPreferenceChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True when the Vibration API is present. */
export function canVibrate(): boolean {
  try {
    return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
  } catch {
    return false;
  }
}

/** True when the browser knows the native switch control (WebKit, iOS 17.4+; haptic since iOS 18). */
export function hasSwitchControl(): boolean {
  try {
    return typeof HTMLInputElement !== 'undefined' && 'switch' in HTMLInputElement.prototype;
  } catch {
    return false;
  }
}

/** True when some haptic mechanism may work here (the settings toggle shows only then). */
export function hapticsSupported(): boolean {
  return canVibrate() || hasSwitchControl();
}

let switchLabel: HTMLLabelElement | null = null;

/** The hidden switch's label, created on first use. Null when it cannot be made. */
function ensureSwitchLabel(): HTMLLabelElement | null {
  if (switchLabel?.isConnected) return switchLabel;
  try {
    if (typeof document === 'undefined' || !document.body) return null;
    const label = document.createElement('label');
    label.setAttribute('aria-hidden', 'true');
    label.setAttribute('data-haptics', 'true');
    // Rendered (so it toggles as a real control) but invisible and out of the way.
    label.style.cssText =
      'position:fixed;left:-100px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('switch', '');
    input.tabIndex = -1;
    label.appendChild(input);
    document.body.appendChild(label);
    switchLabel = label;
    return label;
  } catch {
    return null;
  }
}

/**
 * One light haptic tick, if supported and enabled. Call it synchronously from
 * the user's gesture. Returns which mechanism was used (for tests), never throws.
 */
export function haptic(): 'vibrate' | 'switch' | 'none' {
  if (!hapticsEnabled()) return 'none';
  try {
    if (canVibrate()) {
      navigator.vibrate(HAPTIC_TICK_MS);
      return 'vibrate';
    }
    if (hasSwitchControl()) {
      const label = ensureSwitchLabel();
      if (!label) return 'none';
      label.click();
      return 'switch';
    }
  } catch {
    // Unsupported or refused: silence is the fallback.
  }
  return 'none';
}

/**
 * True when the page has transient user activation right now (inside a click,
 * pointerup or touchend), where the browser exposes it
 * (navigator.userActivation: Chrome, Safari 16.4+). Undefined when unknown.
 */
export function hasTransientActivation(): boolean | undefined {
  try {
    const ua = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
    return ua ? ua.isActive : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A tick from code that may run outside the user's gesture (the long-press
 * timer). The Vibration API only needs sticky activation (any earlier tap),
 * so Android ticks right away. The iOS switch most likely needs transient
 * activation, which a timer callback does not have (touch activation starts at
 * pointerup): there, when the browser says activation is not active, nothing
 * is attempted now and 'deferred' tells the caller to call haptic() from the
 * next pointerup of the same gesture instead.
 */
export function hapticOrDefer(): 'vibrate' | 'switch' | 'none' | 'deferred' {
  if (!hapticsEnabled()) return 'none';
  if (canVibrate()) return haptic();
  if (hasSwitchControl()) return hasTransientActivation() === false ? 'deferred' : haptic();
  return 'none';
}

let lastSelectionKey: string | null = null;

/**
 * The tick for a finger sliding over a list (the long-press menu's
 * slide-to-select): one tick each time the item under the finger changes to
 * another item, none while it stays on the same one, none when it leaves the
 * list. Platform reality: Android Chrome vibrates during the move (sticky
 * activation suffices); iOS Safari's switch haptic most likely needs transient
 * activation, which touchmove and pointermove never grant, so on iOS these
 * calls are attempted and stay silent. Never throws.
 */
export function selectionTick(key: string | null): 'vibrate' | 'switch' | 'none' {
  if (key === lastSelectionKey) return 'none';
  lastSelectionKey = key;
  if (key === null) return 'none';
  return haptic();
}

/** Start a new slide: the first item reached ticks again. */
export function resetSelectionTick(): void {
  lastSelectionKey = null;
}

/** Test hook: forget the cached switch and the in-memory preference. */
export function resetHapticsForTests(): void {
  try {
    switchLabel?.remove();
  } catch {
    // ignore
  }
  switchLabel = null;
  memoryPreference = undefined;
  lastSelectionKey = null;
  listeners.clear();
}

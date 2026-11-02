// src/lib/behaviour/keys.ts
//
// How a stored key chord reads, shared by the parser and the runtime. The parser
// refuses a printable key on a text entry control it can see. A wrapper hears the
// fields inside it, and those it cannot see, so the runtime checks the same rule again
// against what actually fired.
//
// A leaf on purpose, see names.ts.
//
// PURE and client-safe: no React, no MST.

export const NAMED_KEYS: ReadonlySet<string> = new Set((
  'Printable Enter Space Escape Tab Backspace Delete Insert Home End PageUp PageDown '
  + 'ArrowUp ArrowDown ArrowLeft ArrowRight InlineStart InlineEnd '
  + 'F1 F2 F3 F4 F5 F6 F7 F8 F9 F10 F11 F12'
).split(' '));

/** `hidden` writes its `value` property into the attribute, so it holds no copied text. */
export const NON_TEXT_INPUT_TYPES: ReadonlySet<string> = new Set(['range', 'checkbox', 'radio', 'color', 'button', 'submit', 'reset', 'file', 'hidden']);

const CHORD = /^((?:(?:Ctrl|Shift|Alt|Meta)\+)*)([\s\S]+)$/u;

/** The key of a chord, without its modifiers, or null when the text is no key at all. */
export function keyOfChord(chord: unknown): string | null {
  if (typeof chord !== 'string') return null;
  const match = CHORD.exec(chord);
  if (!match) return null;
  const [, modifiers, key] = match;
  if (key === 'Printable') return modifiers ? null : key;
  if (NAMED_KEYS.has(key)) return key;
  const single = [...key].length === 1 && !/[\s\p{C}]/u.test(key);
  return single ? key : null;
}

/**
 * True for a chord whose key writes into a text field. The leak the taint rule
 * closes is per character, so Space counts, and so does a chord on a printable key.
 */
export function isPrintableChord(chord: string): boolean {
  const key = keyOfChord(chord);
  return key === null || key === 'Printable' || key === 'Space' || !NAMED_KEYS.has(key);
}

/** True when a person can type into this element. */
export function isTextEntry(element: Element): boolean {
  const { tagName } = element;
  return (element as HTMLElement).isContentEditable === true || tagName === 'TEXTAREA'
    || (tagName === 'INPUT' && !NON_TEXT_INPUT_TYPES.has((element as HTMLInputElement).type));
}

const isCharacter = (key: string): boolean => [...key].length === 1;

/**
 * True when this key press may be a character going into a field. A name this
 * list does not hold counts too, because `Dead`, `Process` and a virtual keyboard's
 * `Unidentified` are all someone typing.
 */
const isTyping = (event: KeyboardEvent): boolean => !NAMED_KEYS.has(event.key);

/** What `InlineStart` and `InlineEnd` are in this writing direction. */
const physicalKey = (key: string, rightToLeft: boolean): string => {
  if (key === 'Space') return ' ';
  if (key === 'InlineStart') return rightToLeft ? 'ArrowRight' : 'ArrowLeft';
  if (key === 'InlineEnd') return rightToLeft ? 'ArrowLeft' : 'ArrowRight';
  return key;
};

function chordHolds(chord: string, event: KeyboardEvent, rightToLeft: boolean): boolean {
  const key = keyOfChord(chord);
  if (key === null) return false;
  if (key === 'Printable') return isCharacter(event.key) && event.key !== ' ' && !event.ctrlKey && !event.metaKey;
  const held = chord.slice(0, chord.length - key.length);
  const sameMods = event.ctrlKey === held.includes('Ctrl+') && event.altKey === held.includes('Alt+') && event.metaKey === held.includes('Meta+');
  if (!sameMods) return false;
  // Shift is part of the character, so it counts only on a named key.
  if (!NAMED_KEYS.has(key)) return event.key.toLowerCase() === key.toLowerCase();
  return event.shiftKey === held.includes('Shift+') && event.key === physicalKey(key, rightToLeft);
}

/**
 * True when a key trigger answers this press on `element`. What a person types into a
 * field fires nothing, however the trigger reads and wherever it sits: that is the
 * rule that stops a wrapper counting characters.
 */
export function keysAnswer(keys: readonly string[] | undefined, event: KeyboardEvent, element: Element): boolean {
  const target = event.target as Node | null;
  const field = target?.nodeType === 1 && isTextEntry(target as Element);
  if (field && event.isComposing) return false;
  if (!keys) return !(field && isTyping(event));
  const rightToLeft = keys.some((chord) => chord.startsWith('Inline')) && getComputedStyle(element).direction === 'rtl';
  return keys.some((chord) => !(field && isPrintableChord(chord)) && chordHolds(chord, event, rightToLeft));
}

/** True for an address that leaves the site, which the runtime checks against user activation. */
export function leavesSite(href: string): boolean {
  return !(href.startsWith('#') || (href.startsWith('/') && !href.startsWith('//')));
}

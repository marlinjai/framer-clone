import { describe, expect, it } from 'vitest';
import { resolveAction } from '../keyBindings';

const press = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);

describe('Create component shortcut', () => {
  it('matches Cmd or Ctrl with Alt and K, also when a Mac types another character for Option+K', () => {
    expect(resolveAction(press({ key: 'k', code: 'KeyK', metaKey: true, altKey: true }))?.action).toBe('createComponent');
    expect(resolveAction(press({ key: '˚', code: 'KeyK', metaKey: true, altKey: true }))?.action).toBe('createComponent');
    expect(resolveAction(press({ key: 'k', code: 'KeyK', ctrlKey: true, altKey: true }))?.action).toBe('createComponent');
  });

  it('does not match without Alt, or another key typing the same character', () => {
    expect(resolveAction(press({ key: 'k', code: 'KeyK', metaKey: true }))).toBeNull();
    expect(resolveAction(press({ key: '˚', code: 'KeyJ', metaKey: true, altKey: true }))).toBeNull();
  });
});

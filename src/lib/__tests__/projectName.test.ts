import { describe, it, expect } from 'vitest';
import { validateProjectName, projectNameSchema, PROJECT_NAME_MAX_LENGTH } from '../projectName';

describe('validateProjectName', () => {
  it('trims and accepts a normal name', () => {
    expect(validateProjectName('  Bakery site  ')).toEqual({ ok: true, name: 'Bakery site' });
  });

  it('refuses empty and whitespace-only names', () => {
    expect(validateProjectName('').ok).toBe(false);
    expect(validateProjectName('   ').ok).toBe(false);
  });

  it('allows exactly 100 characters and refuses 101', () => {
    expect(validateProjectName('a'.repeat(PROJECT_NAME_MAX_LENGTH)).ok).toBe(true);
    expect(validateProjectName('a'.repeat(PROJECT_NAME_MAX_LENGTH + 1)).ok).toBe(false);
  });

  it('counts characters, not UTF-16 units (emoji, umlauts)', () => {
    expect(validateProjectName('\u{1F370}'.repeat(PROJECT_NAME_MAX_LENGTH)).ok).toBe(true);
    expect(validateProjectName('Bäckerei Müller').ok).toBe(true);
  });

  it('refuses control characters and line separators', () => {
    for (const bad of ['a\nb', 'a\tb', 'a\u0000b', 'a\u007fb', 'a\u0085b', 'a\u2028b', 'a\u2029b']) {
      expect(validateProjectName(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('refuses bidirectional override and isolate characters', () => {
    for (const bad of ['abc\u202Edef', 'a\u202Ab', 'a\u2066b\u2069', 'a\u200Fb']) {
      expect(validateProjectName(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('treats a name of only invisible characters as empty', () => {
    expect(validateProjectName('\u200B')).toEqual({ ok: false, message: 'A project needs a name.' });
    expect(validateProjectName(' \u200B\u00AD ')).toEqual({ ok: false, message: 'A project needs a name.' });
  });

  it('keeps emoji joined with a zero-width joiner', () => {
    expect(validateProjectName('Family \u{1F468}\u200D\u{1F469}\u200D\u{1F467}').ok).toBe(true);
  });

  it('the zod form parses to the trimmed name', () => {
    expect(projectNameSchema.parse('  X  ')).toBe('X');
    expect(projectNameSchema.safeParse(' ').success).toBe(false);
  });
});

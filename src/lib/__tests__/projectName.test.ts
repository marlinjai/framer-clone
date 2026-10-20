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

  it('the zod form parses to the trimmed name', () => {
    expect(projectNameSchema.parse('  X  ')).toBe('X');
    expect(projectNameSchema.safeParse(' ').success).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MODEL_CHOICES, MODEL_CHOICE_INFO, isModelChoice, loadModelChoice, saveModelChoice } from '../modelChoice';
import { AI_MODELS } from '../anthropicClient';

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('model choice', () => {
  it('offers three steps, cheapest first, each a configured model key', () => {
    expect(MODEL_CHOICES).toEqual(['HAIKU', 'SONNET', 'OPUS']);
    expect(MODEL_CHOICES.map((m) => MODEL_CHOICE_INFO[m].step)).toEqual(['Fast', 'Balanced', 'Best']);
    for (const m of MODEL_CHOICES) expect(AI_MODELS[m]).toMatch(/^claude-/);
  });

  it('allowlists keys only, never raw model ids', () => {
    expect(isModelChoice('OPUS')).toBe(true);
    expect(isModelChoice('claude-opus-5-5')).toBe(false);
    expect(isModelChoice('opus')).toBe(false);
    expect(isModelChoice(undefined)).toBe(false);
  });

  it('remembers the choice per surface', () => {
    saveModelChoice('page-gen', 'HAIKU');
    expect(loadModelChoice('page-gen', 'SONNET')).toBe('HAIKU');
    expect(loadModelChoice('cms-agent', 'OPUS')).toBe('OPUS');
  });

  it('ignores a tampered stored value', () => {
    window.localStorage.setItem('framer-clone:model-choice:page-gen', 'claude-opus-5-5');
    expect(loadModelChoice('page-gen', 'SONNET')).toBe('SONNET');
  });

  it('falls back when storage throws (sandboxed frame, private mode)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(() => saveModelChoice('page-gen', 'OPUS')).not.toThrow();
    expect(loadModelChoice('page-gen', 'SONNET')).toBe('SONNET');
  });
});

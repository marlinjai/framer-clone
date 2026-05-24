// @vitest-environment node
//
// src/lib/ai/__tests__/anthropicClient.test.ts
//
// Pins the fast-fail contract: missing ANTHROPIC_API_KEY throws a
// typed error synchronously. Also verifies the model registry and
// default-model resolution.
//
// Runs in the node environment because the Anthropic SDK refuses to
// initialize in jsdom (it thinks it's in a browser).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AI_MODELS,
  __resetAnthropicClientForTests,
  getAnthropicClient,
  getDefaultModelKey,
  MissingAnthropicKeyError,
  resolveModelId,
} from '../anthropicClient';

const savedKey = process.env.ANTHROPIC_API_KEY;
const savedModel = process.env.AI_DEFAULT_MODEL;

describe('getAnthropicClient', () => {
  beforeEach(() => {
    __resetAnthropicClientForTests();
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    __resetAnthropicClientForTests();
    if (savedKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = savedKey;
    }
  });

  it('throws MissingAnthropicKeyError when env is unset', () => {
    expect(() => getAnthropicClient()).toThrowError(MissingAnthropicKeyError);
  });

  it('throws MissingAnthropicKeyError when env is empty', () => {
    process.env.ANTHROPIC_API_KEY = '';
    expect(() => getAnthropicClient()).toThrowError(MissingAnthropicKeyError);
  });

  it('returns a singleton when a key is present', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-not-real';
    const a = getAnthropicClient();
    const b = getAnthropicClient();
    expect(a).toBe(b);
  });

  it('exposes a code on the error for HTTP mapping', () => {
    try {
      getAnthropicClient();
      throw new Error('expected to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(MissingAnthropicKeyError);
      expect((e as MissingAnthropicKeyError).code).toBe('missing_anthropic_key');
    }
  });
});

describe('model registry', () => {
  afterEach(() => {
    if (savedModel === undefined) {
      delete process.env.AI_DEFAULT_MODEL;
    } else {
      process.env.AI_DEFAULT_MODEL = savedModel;
    }
  });

  it('exposes Haiku / Sonnet / Opus keys', () => {
    expect(AI_MODELS.HAIKU).toMatch(/^claude-haiku/);
    expect(AI_MODELS.SONNET).toMatch(/^claude-sonnet/);
    expect(AI_MODELS.OPUS).toMatch(/^claude-opus/);
  });

  it('defaults to Haiku when AI_DEFAULT_MODEL is unset', () => {
    delete process.env.AI_DEFAULT_MODEL;
    expect(getDefaultModelKey()).toBe('HAIKU');
    expect(resolveModelId()).toBe(AI_MODELS.HAIKU);
  });

  it('honors AI_DEFAULT_MODEL=SONNET', () => {
    process.env.AI_DEFAULT_MODEL = 'SONNET';
    expect(getDefaultModelKey()).toBe('SONNET');
    expect(resolveModelId()).toBe(AI_MODELS.SONNET);
  });

  it('ignores garbage AI_DEFAULT_MODEL and falls back to Haiku', () => {
    process.env.AI_DEFAULT_MODEL = 'lolwut';
    expect(getDefaultModelKey()).toBe('HAIKU');
  });

  it('resolves explicit keys regardless of env', () => {
    process.env.AI_DEFAULT_MODEL = 'SONNET';
    expect(resolveModelId('HAIKU')).toBe(AI_MODELS.HAIKU);
    expect(resolveModelId('OPUS')).toBe(AI_MODELS.OPUS);
  });
});

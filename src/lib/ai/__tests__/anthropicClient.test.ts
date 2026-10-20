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

import Anthropic from '@anthropic-ai/sdk';
import type { BetaContentBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import {
  AI_MODELS,
  isToolInputParseError,
  mergeBetas,
  modelRequestFields,
  progressUpdateFields,
  refusalMessage,
  replayableAssistantContent,
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

  it('maps the keys to the current-generation model ids (no date suffix)', () => {
    expect(AI_MODELS).toEqual({
      HAIKU: 'claude-haiku-5-5',
      SONNET: 'claude-sonnet-5-5',
      OPUS: 'claude-opus-5-5',
    });
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

describe('modelRequestFields', () => {
  it('Sonnet and Opus opt into server-side fallback with an explicit effort', () => {
    for (const key of ['SONNET', 'OPUS'] as const) {
      expect(modelRequestFields(key, 'medium')).toEqual({
        model: AI_MODELS[key],
        output_config: { effort: 'medium' },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      });
    }
  });

  it('Haiku has no server-side fallback (a fallback list would 400)', () => {
    expect(modelRequestFields('HAIKU', 'low')).toEqual({
      model: 'claude-haiku-5-5',
      output_config: { effort: 'low' },
    });
  });

  it('never sends thinking or sampling fields', () => {
    for (const key of ['HAIKU', 'SONNET', 'OPUS'] as const) {
      const fields = modelRequestFields(key, 'low') as Record<string, unknown>;
      for (const banned of ['thinking', 'temperature', 'top_p', 'top_k']) expect(fields).not.toHaveProperty(banned);
    }
  });
});

describe('progressUpdateFields / mergeBetas', () => {
  it('turns on display "updates" for Sonnet and Opus only', () => {
    expect(progressUpdateFields('OPUS')).toEqual({
      thinking: { type: 'adaptive', display: 'updates' },
      betas: ['thinking-display-updates-2026-08-18'],
    });
    expect(progressUpdateFields('HAIKU')).toEqual({});
  });

  it('merges beta lists without duplicates, undefined when empty', () => {
    expect(mergeBetas(['a'], undefined, ['a', 'b'])).toEqual(['a', 'b']);
    expect(mergeBetas(undefined, [])).toBeUndefined();
  });
});

describe('refusalMessage', () => {
  it('is null for every stop reason except refusal', () => {
    for (const stop_reason of ['end_turn', 'tool_use', 'max_tokens'] as const) {
      expect(refusalMessage({ stop_reason })).toBeNull();
    }
  });

  it('names the category when the API gives one', () => {
    expect(refusalMessage({ stop_reason: 'refusal', stop_details: { category: 'bio' } })).toContain('category: bio');
    expect(refusalMessage({ stop_reason: 'refusal', stop_details: null })).toMatch(/declined/);
  });
});

describe('replayableAssistantContent', () => {
  const thinking = { type: 'thinking', thinking: '', signature: 's' };
  const tool = { type: 'tool_use', id: 't', name: 'x', input: {} };
  const text = { type: 'text', text: 'hi', citations: null };
  const fallback = { type: 'fallback', from: { model: 'a' }, to: { model: 'b' } };

  it('returns the content unchanged when no fallback happened', () => {
    const content = [thinking, text, tool] as unknown as BetaContentBlock[];
    expect(replayableAssistantContent(content)).toEqual(content);
  });

  it('drops thinking and tool_use blocks before the last fallback boundary only', () => {
    const content = [thinking, text, tool, fallback, thinking, tool] as unknown as BetaContentBlock[];
    expect(replayableAssistantContent(content).map((b) => b.type)).toEqual(['text', 'fallback', 'thinking', 'tool_use']);
  });
});

describe('isToolInputParseError', () => {
  it('matches only the SDK local tool-input JSON failure, never API errors', () => {
    expect(isToolInputParseError(new Anthropic.AnthropicError('Unable to parse tool parameter JSON from model. x'))).toBe(true);
    expect(isToolInputParseError(new Anthropic.AnthropicError('stream ended'))).toBe(false);
    expect(isToolInputParseError(new Error('Unable to parse tool parameter JSON'))).toBe(false);
  });
});

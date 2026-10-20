// src/lib/ai/modelChoice.ts
//
// The model choice the AI surfaces offer as a three-step slider (Fast,
// Balanced, Best), shared by the Generate page dialog and the CMS content
// agent. Client-safe: no SDK import, no env access.
//
// The wire format is the model KEY ('HAIKU' | 'SONNET' | 'OPUS'), never a raw
// model id. Each route validates the key against this allowlist (a zod enum
// built from MODEL_CHOICES) and maps it to the configured model id on the
// server (AI_MODELS in src/lib/ai/anthropicClient.ts), so a client can never
// pick an arbitrary model.
//
// The last choice is remembered per surface in localStorage. The editor has no
// user id on the client, so "per user" is per browser profile; storage can
// throw (private mode, sandboxed frames) and is only ever a convenience.

/** Slider order, cheapest first. */
export const MODEL_CHOICES = ['HAIKU', 'SONNET', 'OPUS'] as const;
export type ModelChoice = (typeof MODEL_CHOICES)[number];

export interface ModelChoiceInfo {
  /** The slider step name. */
  step: 'Fast' | 'Balanced' | 'Best';
  /** The model's product name, read out by screen readers (aria-valuetext). */
  modelName: string;
  /** One line on speed and relative cost (list prices in anthropicClient.ts). */
  hint: string;
}

export const MODEL_CHOICE_INFO: Record<ModelChoice, ModelChoiceInfo> = {
  HAIKU: {
    step: 'Fast',
    modelName: 'Claude Haiku 5.5',
    hint: 'Quickest answers, about 1/20 of the Balanced cost.',
  },
  SONNET: {
    step: 'Balanced',
    modelName: 'Claude Sonnet 5.5',
    hint: 'Good quality at moderate speed, the standard cost.',
  },
  OPUS: {
    step: 'Best',
    modelName: 'Claude Opus 5.5',
    hint: 'Most careful results, slower, about 2x the Balanced cost.',
  },
};

export function isModelChoice(value: unknown): value is ModelChoice {
  return typeof value === 'string' && (MODEL_CHOICES as readonly string[]).includes(value);
}

/** The AI surfaces that remember a model choice. */
export type ModelChoiceSurface = 'page-gen' | 'cms-agent';

const STORAGE_PREFIX = 'framer-clone:model-choice:';

/** The remembered choice for a surface, or the fallback (unknown or unreadable values are ignored). */
export function loadModelChoice(surface: ModelChoiceSurface, fallback: ModelChoice): ModelChoice {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + surface);
    return isModelChoice(raw) ? raw : fallback;
  } catch {
    return fallback;
  }
}

export function saveModelChoice(surface: ModelChoiceSurface, choice: ModelChoice): void {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + surface, choice);
  } catch {
    // storage unavailable: remembering the choice is a nicety
  }
}

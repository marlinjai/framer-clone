// src/lib/ai/brief/ideas.ts
//
// Six ideas for the Generate dialog's idea row, tailored to the site: one
// non-streamed call to Haiku (effort low) with one tool, `emit_ideas`. The
// context is what the generator itself gets (project name, site facts and
// language, existing page titles, the target kind and, for replace or insert,
// the selected component). One attempt, no repair round: a missing tool call
// or an unusable shape is `invalid_output`, and the dialog keeps showing the
// static ideas (./staticIdeas.ts).
//
// The output is checked, never trusted: each idea is trimmed and capped, an
// idea whose title repeats an existing page title or one already shown is
// dropped, and fewer than MIN_IDEAS usable ideas is a failure.

import type Anthropic from '@anthropic-ai/sdk';
import type { BetaToolUseBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { AI_MODELS, modelRequestFields, refusalMessage } from '@/lib/ai/anthropicClient';
import { classifyProviderError } from '@/lib/ai/pageGen/providerError';
import { siteDataBlock, siteLanguage, targetSentence, type BriefSiteInput } from './context';
import { BRIEF_LIMITS, type BriefErrorPayload, type PageIdea } from './schema';
import { emptyBriefUsage, usageFrom, type BriefUsage } from './usage';

export const IDEAS_TOOL_NAME = 'emit_ideas';
export const IDEAS_MODEL = AI_MODELS.HAIKU;
/** Enough for six short ideas plus Haiku's adaptive thinking at effort low. */
const MAX_OUTPUT_TOKENS = 2_000;
/** Fewer usable ideas than this is a failed call. */
export const MIN_IDEAS = 3;

export interface IdeasInput extends BriefSiteInput {
  /** Titles already shown ("More ideas"): the new set must differ. */
  exclude?: string[];
}

export type IdeasOutcome =
  | { ok: true; ideas: PageIdea[]; usage: BriefUsage }
  | { ok: false; error: BriefErrorPayload; usage: BriefUsage };

export function ideasTool() {
  return {
    name: IDEAS_TOOL_NAME,
    description: `Return exactly ${BRIEF_LIMITS.ideasPerSet} ideas.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        ideas: {
          type: 'array',
          minItems: BRIEF_LIMITS.ideasPerSet,
          maxItems: BRIEF_LIMITS.ideasPerSet,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Two to five words, shown on a chip.' },
              brief: { type: 'string', description: 'One to three sentences: the brief the generator receives.' },
            },
            required: ['title', 'brief'],
            additionalProperties: false,
          },
        },
      },
      required: ['ideas'],
      additionalProperties: false,
    },
  };
}

export function ideasSystemPrompt(input: IdeasInput): string {
  const language = siteLanguage(input);
  return [
    `You suggest starting points for an AI website generator. The person is about to generate ${targetSentence(input.targetKind)}.`,
    `Suggest ${BRIEF_LIMITS.ideasPerSet} different, useful ideas for this particular site. Each idea has a short title (two to five words) and a brief of one to three sentences that names the sections in order and what each one says.`,
    input.targetKind === 'newPage'
      ? 'Each idea is a page this site does not have yet. Never suggest a page whose title matches an existing page title.'
      : 'Each idea is one section that fits where the selected component is and what the site is about.',
    'Keep to what the site data supports. Never invent prices, addresses, phone numbers, opening hours, awards, numbers of customers or other claims: where a fact is needed, say what kind of fact goes there.',
    language
      ? `Write the titles and briefs in ${language}, the site language.`
      : 'Write the titles and briefs in the language of the site data, or in English when it does not show one.',
    `Call ${IDEAS_TOOL_NAME} once with the ideas. Write nothing else.`,
  ].join('\n');
}

export function ideasUserMessage(input: IdeasInput): string {
  const parts = [siteDataBlock(input)];
  const exclude = (input.exclude ?? []).slice(0, BRIEF_LIMITS.maxExclude);
  if (exclude.length > 0) {
    parts.push(
      `These ideas were already shown. Suggest different ones:\n${JSON.stringify(exclude).replace(/</g, '\\u003c')}`,
    );
  }
  parts.push(`Suggest ${BRIEF_LIMITS.ideasPerSet} ideas.`);
  return parts.join('\n\n');
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

function cap(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3).trimEnd()}...` : flat;
}

/**
 * The usable ideas in a tool input: trimmed, capped, without duplicates,
 * existing page titles or already shown titles, at most ideasPerSet.
 */
export function parseIdeas(raw: unknown, input: Pick<IdeasInput, 'existingPageTitles' | 'exclude'>): PageIdea[] {
  const list = raw && typeof raw === 'object' ? (raw as { ideas?: unknown }).ideas : undefined;
  if (!Array.isArray(list)) return [];
  const taken = new Set([...(input.existingPageTitles ?? []), ...(input.exclude ?? [])].map(norm));
  const out: PageIdea[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const { title, brief } = item as { title?: unknown; brief?: unknown };
    if (typeof title !== 'string' || typeof brief !== 'string') continue;
    const t = cap(title, BRIEF_LIMITS.maxIdeaTitleChars);
    const b = cap(brief, BRIEF_LIMITS.maxIdeaBriefChars);
    if (!t || !b || taken.has(norm(t))) continue;
    taken.add(norm(t));
    out.push({ title: t, brief: b });
    if (out.length >= BRIEF_LIMITS.ideasPerSet) break;
  }
  return out;
}

export async function generateIdeas(
  input: IdeasInput,
  deps: { anthropic: Pick<Anthropic, 'beta'>; signal?: AbortSignal },
): Promise<IdeasOutcome> {
  let usage = emptyBriefUsage();
  try {
    const message = await deps.anthropic.beta.messages.create(
      {
        ...modelRequestFields('HAIKU', 'low'),
        max_tokens: MAX_OUTPUT_TOKENS,
        system: ideasSystemPrompt(input),
        tools: [ideasTool()],
        // Current models reject a forced tool_choice: `auto` plus the instruction.
        tool_choice: { type: 'auto', disable_parallel_tool_use: true },
        messages: [{ role: 'user', content: ideasUserMessage(input) }],
      },
      { signal: deps.signal },
    );
    usage = usageFrom(message.usage);
    const refusal = refusalMessage(message);
    if (refusal) return { ok: false, error: { code: 'refused', message: refusal }, usage };
    const toolUse = message.content.find(
      (b): b is BetaToolUseBlock => b.type === 'tool_use' && b.name === IDEAS_TOOL_NAME,
    );
    const ideas = toolUse ? parseIdeas(toolUse.input, input) : [];
    if (ideas.length < MIN_IDEAS) {
      return {
        ok: false,
        error: { code: 'invalid_output', message: 'The AI did not return usable ideas. Try again.' },
        usage,
      };
    }
    return { ok: true, ideas, usage };
  } catch (err) {
    return { ok: false, error: classifyProviderError(err), usage };
  }
}

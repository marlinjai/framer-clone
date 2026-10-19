// src/lib/ai/pageGen/prompt.ts
//
// System prompt, tool definition and per-request context for the page
// generator. The stable part (instructions + the registry-generated schema
// docs) is prompt-cached; the per-request part (breakpoints, target, brief)
// sits after the cache breakpoint (see buildSystemPrompt).

import type Anthropic from '@anthropic-ai/sdk';
import { stableStringify } from '@/lib/ai/serializers/normalize';
import { buildSchemaDocs } from './schemaDocs';
import { BASE_KEY, type BreakpointKey } from './schema';
import type { PageGenTarget } from './protocol';

export const EMIT_TOOL_NAME = 'emit_page';

const INSTRUCTIONS = [
  'You are the page designer of framer-clone, a visual website builder. You turn a short brief into',
  'real, editable components by calling the emit_page tool exactly once. You never answer in prose',
  'instead of calling the tool; if the brief is unclear, make sensible choices and still call it.',
  '',
  'Design guidance:',
  '- Structure a full page as stacked sections, typically: navigation, hero (headline, one sentence,',
  '  one primary call to action), features or benefits, social proof, pricing or details when relevant,',
  '  a closing call to action, and a footer. A partial request (one section) produces only that section.',
  '- Write real, specific copy for the brief. Never lorem ipsum, never "Feature 1".',
  '- Use a consistent spacing scale (4, 8, 12, 16, 24, 32, 48, 64, 96 px) and type scale',
  '  (14, 16, 18, 20, 24, 32, 40, 56 px). Body text 16 to 18px with lineHeight 1.5 to 1.7.',
  '- Keep text contrast readable (dark text on light backgrounds or the reverse). Pick one accent color',
  '  and use it for calls to action and highlights.',
  '- Lay sections out with flex or grid; constrain content width with maxWidth (e.g. 1120px) and',
  '  margin "0 auto". Make every section work on mobile through responsive maps.',
  '- Use semantic tags: header, nav, main, section, footer, h1 (once per page), h2 for section titles.',
  '- Images: use https URLs only when the brief provides them; otherwise use an img with a descriptive',
  '  alt and no src (the editor inserts a placeholder the user replaces).',
  '- Label every section and important node so the layers panel reads like an outline.',
].join('\n');

/**
 * The emit_page tool. The input schema is deliberately shallow (no recursive
 * $ref): the full node grammar is in the schema docs, and the server validates
 * and repairs every node anyway (./validate.ts), so a schema the API might
 * treat differently across models buys nothing.
 */
export function emitPageTool(): Anthropic.Tool {
  return {
    name: EMIT_TOOL_NAME,
    description:
      'Emit the generated components. Call exactly once with every node. Nodes follow the output format in the system prompt.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Page title (new pages only).' },
        description: { type: 'string', description: 'One-sentence page description for search engines (new pages only).' },
        nodes: {
          type: 'array',
          description: 'Top-level nodes in order. For a page: its sections. For a section: usually one node.',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string' },
              preset: { type: 'string' },
              label: { type: 'string' },
              props: { type: 'object' },
              children: { type: 'array', items: { type: 'object' } },
            },
            required: ['type'],
          },
        },
      },
      required: ['nodes'],
    },
    // Stream the (large) tool input as it is generated, so the dialog can show
    // progress. The server owns validation either way.
    eager_input_streaming: true,
  };
}

/** The cached system prefix: instructions plus the registry-generated docs. */
export function stableSystemText(): string {
  return `${INSTRUCTIONS}\n\n${buildSchemaDocs()}`;
}

export interface RequestContextInput {
  breakpoints: BreakpointKey[];
  target: PageGenTarget;
  projectName?: string;
  existingPageTitles?: string[];
}

/** The volatile part of the system prompt (after the cache breakpoint). */
export function requestContextText(input: RequestContextInput): string {
  const lines: string[] = ['# This request', ''];
  lines.push('Breakpoint keys for responsive maps (largest first):');
  for (const bp of input.breakpoints) lines.push(`- "${bp.key}": ${bp.label}, from ${bp.minWidth}px`);
  lines.push(`- "${BASE_KEY}": every breakpoint without its own key`);
  lines.push('');
  if (input.projectName) lines.push(`Project: ${input.projectName}`);
  if (input.target.kind === 'newPage') {
    lines.push('Target: a NEW page. Emit its sections as top-level nodes and give it a title and description.');
    if (input.target.title) lines.push(`The user named the page: ${input.target.title}`);
    if (input.existingPageTitles && input.existingPageTitles.length > 0) {
      lines.push(`Existing pages (do not duplicate their purpose): ${input.existingPageTitles.join(', ')}`);
    }
  } else if (input.target.kind === 'replace') {
    lines.push(
      'Target: REPLACE the component below with your nodes. Keep its role on the page; redesign it as the',
      'brief asks. The current component (ids are informational, never reuse them):',
      stableStringify(input.target.context),
    );
  } else {
    lines.push(
      'Target: INSERT your nodes at the end of the container below (a partial generation, usually one',
      'section). The container (ids are informational, never reuse them):',
      stableStringify(input.target.context),
    );
  }
  return lines.join('\n');
}

/** The user turn: the brief, verbatim. */
export function briefMessage(brief: string): string {
  return `Brief:\n${brief}`;
}

/** The follow-up turn when the first output could not be used. */
export function repairMessage(problems: string[]): string {
  return [
    'Your output could not be applied. Problems:',
    ...problems.slice(0, 40).map((p) => `- ${p}`),
    '',
    `Call ${EMIT_TOOL_NAME} again with a corrected, complete result. If the output was too long, produce fewer nodes.`,
  ].join('\n');
}

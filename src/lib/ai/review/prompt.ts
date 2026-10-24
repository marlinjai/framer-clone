// src/lib/ai/review/prompt.ts
//
// The visual review prompt and its tool (plan
// docs/plans/2026-10-23-ai-design-quality-round-2.md, decision 4). Separate
// from the generator's prompt (src/lib/ai/pageGen/prompt.ts) on purpose: the
// review is a minimal, targeted polish of a page that exists, never a
// redesign. The stable part is cached; the page, findings and images go in
// the user turn.

import type {
  BetaContentBlockParam,
  BetaTool,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { CSS_PROP_SET } from '@/lib/styles/cssPropSet';
import type { BreakpointKey } from '@/lib/ai/pageGen/schema';
import { REVIEW_LIMITS, type ReviewImage, type ReviewTreeNode } from './protocol';
import type { LayoutFinding } from './layoutAudit';

export const REVIEW_TOOL_NAME = 'apply_fixes';

const STYLE_KEYS = [...CSS_PROP_SET].sort();

/** The review's one tool. Empty `ops` means the page needs nothing. */
export function reviewTool(): BetaTool {
  return {
    name: REVIEW_TOOL_NAME,
    description:
      'Submit the fixes for the page as patch operations on existing nodes. Call it exactly once. An empty ops list means the page needs no change.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'ops'],
      properties: {
        summary: {
          type: 'string',
          description: 'Two or three sentences: what you saw and what the fixes change.',
        },
        ops: {
          type: 'array',
          maxItems: REVIEW_LIMITS.maxOps,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['op', 'nodeId', 'reason'],
            properties: {
              op: { type: 'string', enum: ['update_style', 'update_text', 'remove_node'] },
              nodeId: { type: 'string', description: 'The id of an existing node from the page tree.' },
              breakpoint: {
                type: ['string', 'null'],
                description:
                  'update_style only: a breakpoint key from the legend, or null for the largest breakpoint (the base value every smaller breakpoint inherits).',
              },
              property: { type: 'string', enum: STYLE_KEYS, description: 'update_style only: the style key (camelCase).' },
              value: {
                type: ['string', 'number', 'null'],
                description: 'update_style only: the new CSS value, or null to remove the value on that breakpoint.',
              },
              text: { type: 'string', description: 'update_text only: the new text of a plain-text node.' },
              reason: {
                type: 'string',
                description: 'One short sentence the user reads in the list of fixes, e.g. "Hero headline wrapped onto five lines on phone".',
              },
            },
          },
        },
      },
    },
  };
}

/** The stable system prompt (cached). */
export function reviewSystemText(): string {
  return `You are a senior web designer reviewing a page that an AI just generated in a visual website editor. You see the rendered page as images (Desktop and the smallest breakpoint), a list of layout problems the editor MEASURED in the rendered DOM, and the page tree. Your job is a minimal, targeted polish: fix what is broken, keep everything that works.

What to fix, in this order:
1. Every measured finding of severity "error": text cut off by its box or a clipping ancestor (give the box room: remove a fixed height, use minHeight, or reduce the font size on that breakpoint), children overflowing their parent, siblings that collide, anything that makes the smallest breakpoint scroll sideways (a fixed width becomes maxWidth plus width 100%, a wide row becomes a column, a long word gets a smaller size).
2. What the images show that the measurements cannot: a headline wrapping awkwardly or crowding a busy photo, cramped spacing, inconsistent vertical rhythm between sections, a card touching its call to action, weak contrast of text over a photo (strengthen the scrim gradient in the same backgroundImage, keeping the photo url exactly as it is, or put the text on a solid panel).
3. Warnings (headline line counts, a single orphan word on the last line, estimated image contrast) when the fix is small and clearly better.

Rules:
- Keep the content, the structure and the design direction: same palette, same typefaces, same layout idea. Never restyle a section that has no problem. Prefer the fewest operations that solve the problem; ${REVIEW_LIMITS.maxOps} is a hard ceiling, a typical review needs 3 to 15.
- Only existing node ids. Only the operations of the tool: update_style, update_text (plain-text nodes only, for a shorter headline or a fixed typo, never to rewrite copy), remove_node (only for a decorative element that cannot be fixed, at most ${REVIEW_LIMITS.maxRemovals}).
- Responsive values cascade desktop-first, like the editor: the largest breakpoint is the base (breakpoint null); a value on a smaller breakpoint applies there and to every smaller one that does not set its own. So a phone-only fix goes on the phone key, and a fix for every size goes on null. In the page tree, a style value that is an object is a responsive map keyed by "base" and breakpoint keys.
- CSS values are plain strings without semicolons, braces or backslashes, e.g. "clamp(2.5rem, 6vw, 4.5rem)", "24px", "1.1". A url() is only allowed where the node's backgroundImage already holds that exact url.
- Never introduce a tell of generated design: no em or en dashes and no emoji in copy, no Inter, Geist or Space Grotesk, no backdrop-filter glass, no radial-gradient orbs or dot-grid backgrounds, no purple-on-black palette, no rainbow gradients, no hover animations or arrows added to buttons.
- If the page has no real problem, call the tool with an empty ops list. Call the tool exactly once and write nothing else.`;
}

/** The request-specific part of the system prompt: the breakpoint legend. */
export function reviewContextText(breakpoints: BreakpointKey[]): string {
  const legend = breakpoints
    .map((b, i) => `- "${b.key}": ${b.label}, from ${b.minWidth}px${i === 0 ? ' (largest: write it as breakpoint null)' : ''}`)
    .join('\n');
  return `Breakpoints of this page, largest first:\n${legend}`;
}

/** The user turn: images first, then findings, the brief and the tree. */
export function reviewUserContent(input: {
  tree: ReviewTreeNode;
  findings: LayoutFinding[];
  images: ReviewImage[];
  brief?: string;
  notes?: string[];
}): BetaContentBlockParam[] {
  const blocks: BetaContentBlockParam[] = [];
  for (const img of input.images) {
    blocks.push({
      type: 'text',
      text: `Rendered "${img.breakpoint}" frame (${img.cssWidth}px wide, shown at ${img.width}x${img.height}px${
        img.truncated ? ', cut off below: the measured findings cover the rest of the page' : ''
      }):`,
    });
    blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
  }
  const findings =
    input.findings.length === 0
      ? 'The editor measured no layout problems.'
      : input.findings
          .map(
            (f, i) =>
              `${i + 1}. [${f.severity}] ${f.kind} on "${f.breakpoint}", node ${f.nodeId}${
                f.relatedNodeId ? ` (with ${f.relatedNodeId})` : ''
              }: ${f.message} Measured: ${JSON.stringify(f.measured)}`,
          )
          .join('\n');
  const parts = [
    `Measured layout findings (${input.findings.length}):\n${findings}`,
    input.notes && input.notes.length > 0 ? `Notes from the editor:\n${input.notes.map((n) => `- ${n}`).join('\n')}` : '',
    input.brief ? `The brief the page was generated from:\n<brief>\n${input.brief}\n</brief>` : '',
    `The page tree (JSON):\n${JSON.stringify(input.tree)}`,
    `Review the page and call ${REVIEW_TOOL_NAME} once.`,
  ].filter(Boolean);
  blocks.push({ type: 'text', text: parts.join('\n\n') });
  return blocks;
}

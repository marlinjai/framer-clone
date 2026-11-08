import 'server-only';

// src/lib/ai/pageGen/runPageGeneration.ts
//
// The page generator's model loop, shared by POST /api/ai/generate-page (which
// streams it to the editor) and the site operations' generatePage
// (src/server/siteOps, which saves the result): ask the model, validate and
// repair the output (./validate.ts), run the design-tells and page-essentials
// screens, give the model one repair round, then place stock photos and find
// each photo's subject. The route's header describes the rules; nothing here
// knows about a stream, a run registry or a rate limit, which stay with the
// caller, and nothing here throws: every way out is an outcome.

import type Anthropic from '@anthropic-ai/sdk';
import type {
  BetaMessageParam,
  BetaToolUseBlock,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import {
  isToolInputParseError,
  modelRequestFields,
  refusalMessage,
  replayableAssistantContent,
  type AiEffort,
  type AiModelKey,
} from '@/lib/ai/anthropicClient';
import { buildSystemPrompt } from '@/lib/ai/promptCache';
import { logAiCall, startAiCallTimer } from '@/lib/ai/aiLogger';
import { recordUsage } from '@/lib/ai/aiUsageStub';
import { deriveBreakpointKeys, GENERATION_LIMITS, type BreakpointInput, type BreakpointKey } from './schema';
import { addressesHeldBy, validateGeneration, type GenerationResult, type ValidateContext } from './validate';
import {
  EMIT_TOOL_NAME,
  briefMessage,
  emitPageTool,
  repairMessage,
  requestContextText,
  stableSystemText,
  tellRepairMessage,
} from './prompt';
import { autoFixTells, describeFinding, detectTells, treeStats, type TellFinding } from './tells';
import type {
  PageGenErrorPayload,
  PageGenModel,
  PageGenOutline,
  PageGenProgress,
  PageGenResultPayload,
  PageGenSection,
  PageGenTarget,
  StockImageSummary,
} from './protocol';
import { createSectionScanner } from './sectionStream';
import { createOutlineBuilder, withoutOutline } from './outline';
import { classifyProviderError } from './providerError';
import {
  applyStockPhotos,
  resolveStockImages,
  type PlacedPhoto,
  type StockImageResolution,
} from './stockImages';
import { FOCAL_MODEL, detectFocalPoints } from './focalPoints';
import { detectEssentials, fillMissingAlt, type EssentialsOptions } from './essentials';
import { siteAddressOf, type SiteContext } from './promptSections/siteContext';

/**
 * Output ceiling per attempt. A 200-node page is roughly 15k tokens of JSON,
 * and on current models adaptive thinking counts toward the same limit, so
 * the cap leaves room for both. Worst case per request (two full attempts):
 * about $0.03 on Haiku 5.5, $0.64 on Sonnet 5.5 and $1.28 on Opus 5.5 ($0.50,
 * $10 and $20 per million output tokens).
 */
export const MAX_OUTPUT_TOKENS = 32_000;
/**
 * Effort per model (explicit, because the models' defaults differ). Page
 * generation is a single structured design pass with a validation gate after
 * it, so every step runs at `medium`, the level the generator used before the
 * slider existed; raise one only if evals show better layouts are worth the
 * thinking tokens.
 */
const PAGE_GEN_EFFORT: Record<AiModelKey, AiEffort> = {
  HAIKU: 'medium',
  SONNET: 'medium',
  OPUS: 'medium',
};
/** Attempts per request: the first, plus one repair round. */
const MAX_ATTEMPTS = 2;
/** Progress events are throttled to one per this many received characters. */
const PROGRESS_EVERY_CHARS = 1_500;

/** What to generate: the route's validated body without its transport fields. */
export interface PageGenerationInput {
  brief: string;
  model: PageGenModel;
  breakpoints: BreakpointInput[];
  target: PageGenTarget;
  projectName?: string;
  existingPageTitles?: string[];
  siteContext?: SiteContext;
}

export interface PageGenerationContext {
  anthropic: Anthropic;
  /** The only stop: an explicit cancel, never a dropped connection. */
  signal: AbortSignal;
  userId: string;
  workspaceId: string;
  /** Each progress step, in order. */
  onProgress?: (progress: PageGenProgress) => void;
  /**
   * Each top-level section of the first attempt as soon as it is complete and
   * valid on its own (a preview the editor draws as a draft). Optional: without
   * it and without onOutline nothing is scanned.
   */
  onSection?: (section: PageGenSection) => void;
  /**
   * The first attempt's outline (./outline.ts), whole, each time it grows or
   * changes: the editor draws a skeleton per entry until the section of that
   * slot arrives. A caller that forwards the preview elsewhere (the MCP
   * generate_page to open editors) passes the payload on unchanged.
   */
  onOutline?: (outline: PageGenOutline) => void;
}

export interface PageGenerationUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  attempts: number;
  /** The model id the request ran on. */
  model: string;
}

export type PageGenerationOutcome =
  | { kind: 'result'; payload: PageGenResultPayload; placed: PlacedPhoto[] }
  | { kind: 'error'; error: PageGenErrorPayload }
  /** Cancelled before a result: nothing to deliver. */
  | { kind: 'aborted' };

/**
 * Run one generation to its outcome. `requestId` names the result
 * (generationId) and the focal-point log line's parent.
 */
export async function runPageGeneration(
  input: PageGenerationInput,
  context: PageGenerationContext,
  requestId: string,
): Promise<{ outcome: PageGenerationOutcome; usage: PageGenerationUsage }> {
  const { anthropic, signal, userId } = context;
  const progress = (p: PageGenProgress): void => context.onProgress?.(p);
  const usage: PageGenerationUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    attempts: 0,
    model: input.model,
  };
  const done = (outcome: PageGenerationOutcome) => ({ outcome, usage });

  // A valid page that only failed the tells screen: applied if the repair
  // round cannot do better, never thrown away.
  let best: ScreenedGeneration | undefined;
  let tellsBefore = 0;
  let received = 0;

  const deliver = async (c: ScreenedGeneration, attempt: number, notes: string[]): Promise<PageGenerationOutcome> => {
    const { imageRequests, invalidImageQueries, ...screenedResult } = c.result;
    // The last resort for alt texts the repair round did not fix: the photo
    // description (or a meaningful layer name), each one reported.
    const alt = fillMissingAlt(screenedResult.nodes, imageRequests);
    const result = { ...screenedResult, nodes: alt.nodes };
    // Filled alt texts are automatic fixes; an image left without one stays a remaining issue.
    const unfilledAlt = new Set(alt.unfilled);
    const remaining = c.remaining.filter((f) => f.tell !== 'alt-text' || unfilledAlt.has(f.path));
    if (imageRequests.length > 0) {
      progress({ phase: 'images', receivedChars: received, attempt });
    }
    const stock = await resolveStockImagesSafely(imageRequests, signal);
    if (signal.aborted) return { kind: 'aborted' };
    // Where each photo's subject is, so every crop keeps it in view.
    const placed = await withFocalPoints(stock.placed, {
      anthropic,
      signal,
      userId,
      workspaceId: context.workspaceId,
    });
    if (signal.aborted) return { kind: 'aborted' };
    const repaired = best !== undefined && c !== best;
    const repairNote =
      repaired && tellsBefore > c.remaining.length
        ? [`Design: a repair round removed ${tellsBefore - c.remaining.length} of ${tellsBefore} issues (tells of generated design or missing page essentials)`]
        : [];
    // Counts only, never page content.
    console.info(
      `[generate-page] tells fixed=${c.fixCount} remaining=${c.remaining.length} repaired=${repaired} attempts=${attempt} altFilled=${alt.filled} altMissing=${alt.unfilled.length}`,
    );
    const payload: PageGenResultPayload = {
      generationId: requestId,
      ...result,
      warnings: [...result.warnings, ...c.fixLines, ...alt.notes, ...repairNote, ...notes],
      tells: remaining.map(describeFinding),
      nodes: applyStockPhotos(result.nodes, placed),
      model: usage.model,
      images: withInvalidQueries(stock.summary, invalidImageQueries),
    };
    return { kind: 'result', payload, placed: stock.placed };
  };
  // Applies the best valid page when the repair round fails (undefined while there is none).
  const deliverBest = async (reason: string): Promise<PageGenerationOutcome | undefined> => {
    if (!best || signal.aborted) return undefined;
    return deliver(best, usage.attempts, [`The design repair round failed (${reason}); the first version was applied`]);
  };

  try {
    const modelFields = modelRequestFields(input.model, PAGE_GEN_EFFORT[input.model]);
    usage.model = modelFields.model;
    const breakpoints: BreakpointKey[] = deriveBreakpointKeys(input.breakpoints);

    const system = buildSystemPrompt([
      { type: 'text', text: stableSystemText(), cache: true },
      {
        type: 'text',
        text: requestContextText({
          breakpoints,
          target: input.target,
          projectName: input.projectName,
          existingPageTitles: input.existingPageTitles,
          siteContext: input.siteContext,
        }),
        cache: false,
      },
    ]);
    const tools = [emitPageTool()];
    const messages: BetaMessageParam[] = [
      {
        role: 'user',
        content: briefMessage(input.brief, input.target.kind === 'newPage' ? undefined : input.target.context),
      },
    ];

    // The page-essentials checks of this request (./essentials.ts).
    const essentials: EssentialsOptions = {
      newPage: input.target.kind === 'newPage',
      brief: input.brief,
      ...(input.target.kind === 'newPage' && input.target.title ? { pageTitle: input.target.title } : {}),
    };

    let lastProblems: string[] = [];

    // The context every validation of this request runs with (the sections of
    // the preview and the final result alike).
    const heldAddresses = addressesHeldBy(input.target.kind === 'newPage' ? null : input.target.context);
    // A Google map shows the business address of the Site settings, or is dropped.
    const mapAddress = input.siteContext ? siteAddressOf(input.siteContext) : null;
    // Where an inserted or replacing result stands: no preset under a button, link or the like.
    const closedAncestor = input.target.kind === 'newPage' ? undefined : input.target.closedAncestor;

    while (usage.attempts < MAX_ATTEMPTS) {
      usage.attempts += 1;
      const attempt = usage.attempts;
      progress({ phase: attempt === 1 ? 'generating' : 'repairing', receivedChars: 0, attempt });

      // Sonnet 5.5 carries the server-side fallback opt-in (modelRequestFields);
      // Haiku 5.5 has none.
      const stream = anthropic.beta.messages.stream(
        {
          ...modelFields,
          max_tokens: MAX_OUTPUT_TOKENS,
          system,
          tools,
          // `auto` plus the instruction, not a forced tool: current models
          // reject forced tool_choice, and a missing call is handled as a
          // repairable problem below.
          tool_choice: { type: 'auto', disable_parallel_tool_use: true },
          messages,
        },
        { signal },
      );
      received = 0;
      let lastReported = 0;
      // The raw tool-input fragments, kept for a strict parse below.
      let rawInput = '';
      // The preview sections: first attempt only (a repair round rewrites the
      // whole page, and the draft of the first one stays up until the result).
      const sections =
        attempt === 1 && (context.onSection || context.onOutline)
          ? sectionPreview(
              { section: context.onSection, outline: context.onOutline },
              requestId,
              attempt,
              { breakpoints, allowStickyCta: false, heldAddresses, mapAddress, closedAncestor },
            )
          : undefined;
      stream.on('inputJson', (partialJson: string) => {
        rawInput += partialJson;
        received += partialJson.length;
        sections?.push(partialJson);
        if (received - lastReported >= PROGRESS_EVERY_CHARS) {
          lastReported = received;
          progress({ phase: attempt === 1 ? 'generating' : 'repairing', receivedChars: received, attempt });
        }
      });

      let final;
      try {
        final = await stream.finalMessage();
      } catch (err) {
        // Eager input streaming hands over unvalidated JSON; JSON the SDK
        // cannot parse at all is invalid model output, not an outage. There
        // is no assistant turn to send back, so the repair turn is a plain
        // user message. Every other error (API, network, abort) propagates.
        if (!isToolInputParseError(err)) throw err;
        // The attempt was billed even though its output was unusable: count
        // what the stream reported so far (input tokens and the output
        // counted up to the failure).
        const partial = stream.currentMessage?.usage;
        if (partial) {
          usage.inputTokens += partial.input_tokens ?? 0;
          usage.outputTokens += partial.output_tokens ?? 0;
          usage.cacheReadTokens += partial.cache_read_input_tokens ?? 0;
          usage.cacheWriteTokens += partial.cache_creation_input_tokens ?? 0;
        }
        lastProblems = [`the ${EMIT_TOOL_NAME} input was not valid JSON`];
        messages.push({ role: 'user', content: repairMessage(lastProblems) });
        continue;
      }
      usage.inputTokens += final.usage.input_tokens;
      usage.outputTokens += final.usage.output_tokens;
      usage.cacheReadTokens += final.usage.cache_read_input_tokens ?? 0;
      usage.cacheWriteTokens += final.usage.cache_creation_input_tokens ?? 0;

      // With eager input streaming the SDK parses the tool input tolerantly:
      // malformed JSON (an unescaped quote, a missing bracket) can come back
      // as a SHORTER but well-formed object that would pass validation as a
      // smaller page. Parse the raw fragments strictly; if they are not valid
      // JSON, the parsed input is not trusted.
      let malformedInput = false;
      if (rawInput.length > 0) {
        try {
          JSON.parse(rawInput);
        } catch {
          malformedInput = true;
        }
      }

      // A classifier decline (after any server-side fallback) is an HTTP 200:
      // checked before content, never repaired (a refusal can also cut the
      // tool input off mid-way).
      const refusal = refusalMessage(final);
      if (refusal) {
        const delivered = await deliverBest('the model declined');
        if (delivered) return done(delivered);
        return done({ kind: 'error', error: { code: 'refused', message: refusal } });
      }

      // Read by block type: the response may start with thinking blocks.
      const toolUse = final.content.find(
        (b): b is BetaToolUseBlock => b.type === 'tool_use' && b.name === EMIT_TOOL_NAME,
      );
      progress({ phase: 'validating', receivedChars: received, attempt });

      let problems: string[];
      let repairText = repairMessage;
      if (final.stop_reason === 'max_tokens') {
        // Checked before validation: a cut-off eager input usually still
        // parses as a valid-looking partial object.
        problems = [`the output was cut off at ${MAX_OUTPUT_TOKENS} tokens (too long)`];
      } else if (!toolUse) {
        problems = [`no ${EMIT_TOOL_NAME} call was made`];
      } else if (malformedInput) {
        problems = [`the ${EMIT_TOOL_NAME} input was not valid JSON`];
      } else {
        // The outline is a preview hint: it never counts toward the size limit,
        // reaches the result or gets saved.
        const outcome = validateGeneration(withoutOutline(toolUse.input), {
          breakpoints,
          allowStickyCta: input.target.kind === 'newPage',
          heldAddresses,
          mapAddress,
          closedAncestor,
        });
        if (outcome.ok) {
          const screened = screenTells(outcome.result, breakpoints, essentials);
          if (screened.remaining.length === 0 || usage.attempts >= MAX_ATTEMPTS) {
            return done(await deliver(screened, attempt, []));
          }
          // Usable, but with tells the screen cannot fix: one repair round.
          best = screened;
          tellsBefore = screened.remaining.length;
          problems = screened.remaining.map(describeFinding);
          repairText = tellRepairMessage;
        } else {
          problems = outcome.errors;
        }
      }
      lastProblems = problems;

      // Feed the problems back for one repair round. The assistant turn is
      // appended as returned; a tool_use block must be answered by a
      // tool_result in the next user turn.
      messages.push({ role: 'assistant', content: replayableAssistantContent(final.content) });
      const toolUses = final.content.filter((b): b is BetaToolUseBlock => b.type === 'tool_use');
      if (toolUses.length > 0) {
        messages.push({
          role: 'user',
          content: toolUses.map((t) => ({
            type: 'tool_result' as const,
            tool_use_id: t.id,
            is_error: true,
            content: repairText(problems),
          })),
        });
      } else {
        messages.push({ role: 'user', content: repairText(problems) });
      }
    }

    const delivered = await deliverBest(lastProblems[0] ?? 'no usable output');
    if (delivered) return done(delivered);
    return done({
      kind: 'error',
      error: {
        code: 'invalid_output',
        message: 'The AI produced a page the editor cannot use. Try again, or simplify the brief.',
        details: lastProblems.slice(0, 20),
      },
    });
  } catch (err) {
    // A provider error in the repair round must not cost the user the valid
    // first page.
    let delivered: PageGenerationOutcome | undefined;
    try {
      delivered = await deliverBest(classifyProviderError(err).message);
    } catch {
      delivered = undefined;
    }
    if (delivered) return done(delivered);
    return done({ kind: 'error', error: classifyProviderError(err) });
  }
}

/**
 * The preview of one attempt: scans the streaming tool input
 * (./sectionStream.ts) for its outline, the sections as they open, and the
 * complete top-level sections. The outline (the model's own, filled up by each
 * section that opens past it, ./outline.ts) is sent whole each time it
 * changes. Each complete section is validated on its own and the valid ones
 * are sent, numbered without gaps (`index`) and carrying their position in
 * "nodes" (`slot`, the skeleton they replace). A section that fails is left out
 * of the preview, never repaired (the final result corrects it anyway); once
 * the sections sent reach the node budget, no more sections are sent. The
 * page-level screens (tells, essentials) run on the final result only.
 *
 * Never throws: it runs inside the SDK's event handler, where an exception
 * would reject the stream and pass for a provider error.
 */
function sectionPreview(
  send: { section?: (section: PageGenSection) => void; outline?: (outline: PageGenOutline) => void },
  generationId: string,
  attempt: number,
  ctx: ValidateContext,
): { push(fragment: string): void } {
  const scanner = createSectionScanner();
  const outline = createOutlineBuilder();
  let index = 0;
  let nodeCount = 0;
  let sectionsStopped = !send.section;
  let stopped = false;
  return {
    push(fragment) {
      if (stopped) return;
      try {
        const step = scanner.push(fragment);
        if (send.outline) {
          let changed = step.outline ? outline.declare(step.outline) : false;
          for (const element of step.opened) changed = outline.open(element) || changed;
          if (changed) send.outline({ generationId, attempt, outline: outline.entries() });
        }
        if (sectionsStopped || !send.section) return;
        for (const { slot, value } of step.sections) {
          const outcome = validateGeneration({ nodes: [value] }, ctx);
          if (!outcome.ok) continue;
          nodeCount += outcome.result.stats.nodeCount;
          if (nodeCount > GENERATION_LIMITS.maxNodes) {
            sectionsStopped = true;
            return;
          }
          for (const node of outcome.result.nodes) {
            send.section({ generationId, index, slot, node, attempt });
            index += 1;
          }
        }
      } catch (err) {
        // A preview problem must never cost the generation: stop previewing.
        stopped = true;
        console.warn(`[generate-page] section preview stopped ${err instanceof Error ? err.name : 'error'}`);
      }
    },
  };
}

/** A valid generation after the design-tells screen. */
interface ScreenedGeneration {
  /** The validated result with the safe fixes applied (stats recounted). */
  result: GenerationResult;
  /** One line per kind of fix, for the dialog's list of automatic fixes. */
  fixLines: string[];
  fixCount: number;
  /** Tells the screen could not fix. */
  remaining: TellFinding[];
}

/**
 * Run the tells screen (./tells.ts) over a validated result: apply the safe
 * fixes, then detect what is left, plus the page essentials (./essentials.ts).
 * Nodes that will get a stock photo are exempt from the rules that would
 * misread their placeholder.
 */
function screenTells(
  result: GenerationResult,
  breakpoints: BreakpointKey[],
  essentials: EssentialsOptions,
): ScreenedGeneration {
  const opts = {
    photoNodeIds: new Set(result.imageRequests.map((r) => r.nodeId)),
    breakpointKeys: breakpoints.map((b) => b.key),
  };
  const fixed = autoFixTells({ title: result.title, description: result.description, nodes: result.nodes }, opts);
  const remaining = [
    ...fixed.findings,
    ...detectTells(fixed.tree, opts).filter((f) => !f.autoFixable),
    ...detectEssentials(fixed.tree, essentials),
  ];
  const nodes = fixed.tree.nodes;
  return {
    result: {
      ...result,
      ...(fixed.tree.title !== undefined ? { title: fixed.tree.title } : {}),
      ...(fixed.tree.description !== undefined ? { description: fixed.tree.description } : {}),
      nodes,
      stats: treeStats(nodes),
    },
    fixLines: fixed.fixes.map((f) => f.detail),
    fixCount: fixed.fixes.reduce((n, f) => n + f.count, 0),
    remaining,
  };
}

/** Count the images whose description the validator refused as placeholders too. */
function withInvalidQueries(summary: StockImageSummary, invalid: number): StockImageSummary {
  if (invalid === 0) return summary;
  return {
    ...summary,
    requested: summary.requested + invalid,
    fellBack: { ...summary.fellBack, invalid_query: invalid },
  };
}

/**
 * The focal-point pass over the placed photos (./focalPoints.ts): one Haiku
 * vision call, logged as its own AI call (its own request id and model, so the
 * generation's log line keeps one model's tokens). A photo without a point
 * keeps no `focal` and is written as a centred crop. Never throws: a failure
 * here must not cost the user the generated page.
 */
async function withFocalPoints(
  placed: PlacedPhoto[],
  ctx: { anthropic: Anthropic; signal: AbortSignal; userId: string; workspaceId: string },
): Promise<PlacedPhoto[]> {
  if (placed.length === 0) return placed;
  const timer = startAiCallTimer();
  try {
    const pass = await detectFocalPoints(
      placed.map((p) => p.thumbSrc),
      { client: ctx.anthropic, signal: ctx.signal },
    );
    if (pass.status !== 'skipped') {
      recordUsage({
        sessionId: ctx.userId,
        inputTokens: pass.usage.inputTokens,
        outputTokens: pass.usage.outputTokens,
        cachedReadTokens: pass.usage.cacheReadTokens,
        cachedWriteTokens: pass.usage.cacheWriteTokens,
      });
      logAiCall({
        requestId: globalThis.crypto.randomUUID(),
        sessionId: `generate-page-focal:${ctx.workspaceId}`,
        userId: ctx.userId,
        model: FOCAL_MODEL,
        promptChars: 0,
        inputTokens: pass.usage.inputTokens,
        outputTokens: pass.usage.outputTokens,
        cachedReadTokens: pass.usage.cacheReadTokens,
        cachedWriteTokens: pass.usage.cacheWriteTokens,
        latencyMs: timer.latencyMs(),
        status: pass.status === 'failed' ? 'error' : 'ok',
        ...(pass.reason ? { errorCode: pass.reason } : {}),
      });
    }
    return placed.map((p, i) => {
      const focal = pass.points[i];
      return focal ? { ...p, focal } : p;
    });
  } catch (err) {
    console.warn(`[focal-points] pass threw, crops stay centred ${err instanceof Error ? err.name : 'error'}`);
    return placed;
  }
}

/**
 * Stock photos are a nicety on top of a valid generation: whatever goes wrong
 * there (the resolver itself never throws, this is the belt and braces), the
 * generation still succeeds with placeholders and a note.
 */
async function resolveStockImagesSafely(
  requests: Parameters<typeof resolveStockImages>[0],
  signal: AbortSignal,
): Promise<StockImageResolution> {
  try {
    return await resolveStockImages(requests, { signal });
  } catch (err) {
    console.warn(`[stock-images] resolver failed ${err instanceof Error ? err.name : 'error'}`);
    return {
      placed: [],
      summary: {
        requested: requests.length,
        resolved: 0,
        fellBack: requests.length > 0 ? { unavailable: requests.length } : {},
        credits: [],
      },
    };
  }
}

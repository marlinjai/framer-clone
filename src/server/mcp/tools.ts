import 'server-only';

// src/server/mcp/tools.ts
//
// The tools of the Lumitra Sites MCP endpoint (plan
// docs/plans/2026-11-02-lumitra-sites-agent-plugin.md, build step 4). Each tool is
// one site operation (src/server/siteOps), run as the verified key's caller, so
// the endpoint has no write path of its own: permissions, the version lock, the
// blocked-content contract and the audit row all come from the library.
//
// Arguments are checked here with zod; the JSON Schema a client sees is generated
// from the same zod schema, so the two cannot drift. The one exception is
// apply_batch's operations: the library checks each operation itself and refuses
// a bad one by index and reason (all or nothing), which tells an agent far more
// than a schema error, so its schema here only describes them (OPERATION_SCHEMAS,
// kept in step with the library's OperationSchema by a test).
//
// Every answer is text plus structuredContent. A refusal is `isError: true` with
// `{ error: { code, message, ... } }`: the library's own code (site_changed with
// currentVersion, rejected with each operation's index and reason, forbidden,
// rate_limited with retryAfterSec), never a stack trace and never the key.

import { z } from 'zod';
import {
  applyBatch,
  createSite,
  describeVocabulary,
  findImages,
  generatePage,
  getPage,
  getSite,
  listRevisions,
  listSites,
  previewUrl,
  publish,
  rollback,
  type SiteOpsDeps,
} from '@/server/siteOps';
import { MAX_BATCH_OPS, type SiteOpsAction, type SiteOpsCaller, type SiteOpsError, type SiteOpsResult } from '@/lib/siteOps/types';
import { OUTLINE_DEFAULT_CHARS, OUTLINE_MAX_CHARS } from '@/lib/siteOps/read';
import { GENERATION_LIMITS } from '@/lib/ai/pageGen/schema';
import { PAGE_GEN_MODELS } from '@/lib/ai/pageGen/protocol';
import type { PageGenRateLimiter } from '@/lib/ai/pageGen/rateLimit';
import { redactSecrets } from '@/lib/auth-machine';
import { CONFIRMATION_TTL_MS, type ConfirmationStore, type ConfirmFn } from './confirmations';

type JsonSchema = Record<string, unknown>;

/** What a tool runs with: the caller built from the verified key, and the endpoint's own state. */
export interface ToolContext {
  caller: SiteOpsCaller;
  /** The verified key's identity, for confirmation subjects. */
  key: { keyId: string; tenantId: string };
  deps: SiteOpsDeps;
  /** Ask the person through the client's dialog; absent when the client declared no elicitation. */
  confirm?: ConfirmFn;
  confirmations: ConfirmationStore;
  limits: { writes: PageGenRateLimiter; images: PageGenRateLimiter };
  /** Aborts when the client goes away (stops a generation and its spend). */
  signal?: AbortSignal;
}

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
  isError: boolean;
}

interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  title: string;
  description: string;
  args: S;
  annotations: ToolAnnotations;
  /** Asks the person before it acts (publish, rollback): answered as a stream when the client can show a dialog. */
  confirms?: boolean;
  /** Overrides parts of the generated JSON Schema (apply_batch's operations). */
  schemaPatch?: (schema: JsonSchema) => JsonSchema;
  run: (ctx: ToolContext, args: z.infer<S>) => Promise<ToolResult>;
}

// ---------- results ----------

export function toolResult(output: Record<string, unknown>, isError: boolean): ToolResult {
  const text = redactSecrets(JSON.stringify(output, null, 2));
  return { content: [{ type: 'text', text }], structuredContent: JSON.parse(redactSecrets(JSON.stringify(output))) as Record<string, unknown>, isError };
}

export function errorResult(error: SiteOpsError | { code: string; message: string; [k: string]: unknown }): ToolResult {
  return toolResult({ error }, true);
}

function fromResult<T>(result: SiteOpsResult<T>, shape: (value: T) => Record<string, unknown> = (v) => v as Record<string, unknown>): ToolResult {
  return result.ok ? toolResult(shape(result.value), false) : errorResult(result.error);
}

// ---------- rate limits ----------

/**
 * Writes per key: at most WRITE_RATE.maxPerWindow per window and one at a time (the
 * version lock makes a second concurrent write on one site fail anyway).
 * Generation has its own per-actor limit inside the library (generatePage).
 */
export const WRITE_RATE = { maxPerWindow: 60, windowMs: 60_000 } as const;
/** Stock photo searches per key: they spend the shared provider budget. */
export const IMAGE_RATE = { maxPerWindow: 30, windowMs: 10 * 60_000 } as const;

async function limited(
  limiter: PageGenRateLimiter,
  ctx: ToolContext,
  what: string,
  run: () => Promise<ToolResult>,
  holdWhileRunning = true,
): Promise<ToolResult> {
  const slot = limiter.acquire(`key:${ctx.key.keyId}`);
  if (!slot.ok) {
    return errorResult({
      code: 'rate_limited',
      message:
        slot.reason === 'in_flight'
          ? `another ${what} of this key is still running; wait for it, then retry`
          : `too many ${what}s from this key; retry in ${slot.retryAfterSec} seconds`,
      retryAfterSec: slot.retryAfterSec,
    });
  }
  if (!holdWhileRunning) slot.release();
  try {
    return await run();
  } finally {
    slot.release();
  }
}

// ---------- confirmation ----------

const TOKEN_INSTRUCTION =
  'Nothing was done yet. Show `summary` to the person exactly as written and ask them to confirm in the chat. Only after they explicitly say yes, call this tool again with the same arguments plus `confirmationToken`. Never confirm on their behalf. The token works once, only for exactly this, and expires in five minutes.';

/** The person's yes for `summary`, or the result to answer instead (declined, or a token to bring back). */
async function confirmWithPerson(
  ctx: ToolContext,
  summary: string,
  subject: string,
  token: string | undefined,
  done: string,
): Promise<'proceed' | ToolResult> {
  if (token && ctx.confirmations.redeem(token, subject)) return 'proceed';
  let note: string | undefined = token
    ? 'The confirmationToken given was unknown, expired, already used, or issued for something else (another site, version or revision). Ask the person again with this summary.'
    : undefined;
  if (ctx.confirm) {
    const outcome = await ctx.confirm(summary);
    if (outcome === 'confirmed') return 'proceed';
    if (outcome === 'declined') {
      return toolResult({ confirmed: false, declined: true, summary, message: `The person declined in the confirmation dialog. Nothing was ${done}.` }, false);
    }
    note = 'The confirmation dialog got no answer (or this client could not show it).';
  }
  return toolResult(
    {
      confirmationRequired: true,
      summary,
      confirmationToken: ctx.confirmations.issue(subject),
      expiresInSeconds: Math.round(CONFIRMATION_TTL_MS / 1000),
      message: TOKEN_INSTRUCTION,
      ...(note ? { note } : {}),
    },
    false,
  );
}

/**
 * Confirm, then write under the per-key write limit. A call that brings a token
 * takes its write slot first, so a rate limit never spends the person's yes. A
 * call that asks through the dialog takes it after the answer, so a dialog left
 * open does not block the key's other writes (only a call whose token turns out
 * invalid and that then asks through the dialog holds it while asking; a client
 * with a dialog is never handed a token in the first place).
 */
async function confirmedWrite(
  ctx: ToolContext,
  summary: string,
  subject: string,
  token: string | undefined,
  done: string,
  write: () => Promise<ToolResult>,
): Promise<ToolResult> {
  if (token) {
    return limited(ctx.limits.writes, ctx, 'write', async () => {
      const gate = await confirmWithPerson(ctx, summary, subject, token, done);
      return gate === 'proceed' ? write() : gate;
    });
  }
  const gate = await confirmWithPerson(ctx, summary, subject, undefined, done);
  return gate === 'proceed' ? limited(ctx.limits.writes, ctx, 'write', write) : gate;
}

async function allowed(ctx: ToolContext, action: SiteOpsAction): Promise<ToolResult | null> {
  try {
    if (await ctx.caller.can(action)) return null;
  } catch {
    return errorResult({ code: 'unavailable', message: 'the permission check could not be made; try again', retryAfterSec: 5 });
  }
  return errorResult({ code: 'forbidden', message: `this key may not ${action === 'publishSite' ? 'publish or roll back sites' : action}` });
}

// ---------- argument schemas ----------

const siteId = z.string().trim().min(1).max(200).describe('The site id, from list_sites or create_site.');
const pageId = z.string().trim().min(1).max(200).describe('A page id, from get_site.');
const expectedVersion = z
  .number()
  .int()
  .min(1)
  .max(2_147_483_647)
  .describe(
    'The site version this call is based on: the `version` of your last get_site, get_page or write answer. If the site changed since, the call is refused with site_changed and the current version, and nothing is written.',
  );
const confirmationToken = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .optional()
  .describe(
    'Only for a client without a confirmation dialog: the confirmationToken a previous call of this tool returned, sent only after the person said yes in the chat to the summary that came with it.',
  );

const placeSchema: JsonSchema = {
  description: 'Where it goes: into a parent (at an index, appended when absent) or next to a sibling.',
  oneOf: [
    {
      type: 'object',
      properties: { parentId: { type: 'string' }, index: { type: 'integer', minimum: 0 } },
      required: ['parentId'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { siblingId: { type: 'string' }, position: { type: 'string', enum: ['before', 'after'] } },
      required: ['siblingId', 'position'],
      additionalProperties: false,
    },
  ],
};
const breakpointArg: JsonSchema = {
  type: ['string', 'null'],
  description: 'A breakpoint key of the page (get_site lists them, largest first). The largest, or none, writes the base value; a smaller one only its override.',
};
const refArg: JsonSchema = {
  type: 'string',
  pattern: '^[A-Za-z0-9_-]{1,64}$',
  description: 'A name for what this creates; later operations of the same batch name it as "ref:<name>", and the answer maps it to the new id.',
};
const idArg = (what: string): JsonSchema => ({ type: 'string', description: `${what} id, or "ref:<name>" for one created earlier in this batch.` });

function op(name: string, description: string, properties: Record<string, JsonSchema>, required: string[]): JsonSchema {
  return {
    type: 'object',
    description,
    properties: { op: { const: name }, ...properties },
    required: ['op', ...required],
    additionalProperties: false,
  };
}

/** The operations of apply_batch, one schema each. A test keeps them in step with the library's OperationSchema. */
export const OPERATION_SCHEMAS: JsonSchema[] = [
  op('createPage', 'A new page.', {
    title: { type: 'string', minLength: 1, maxLength: 120 },
    slug: { type: 'string', maxLength: 200, description: 'The address path; derived from the title when absent.' },
    description: { type: 'string', maxLength: 300 },
    ref: refArg,
  }, ['title']),
  op('updatePageSettings', "A page's title, address and search settings.", {
    pageId: idArg('The page'),
    title: { type: 'string', maxLength: 120 },
    slug: { type: 'string', maxLength: 200 },
    description: { type: 'string', maxLength: 300 },
    ogImage: { type: 'string', maxLength: 2000, description: 'The social preview image URL.' },
    noIndex: { type: 'boolean' },
    notFoundPage: { type: 'boolean', description: 'Make this the page visitors see for an unknown address.' },
  }, ['pageId']),
  op('insertNodes', 'Insert a node tree in the generation format (describe_vocabulary). Blocked tags or props refuse the operation; nothing is dropped silently.', {
    pageId: idArg('The page'),
    parentId: { type: 'string', description: 'The container to insert into; the page root when absent. May be "ref:<name>".' },
    index: { type: 'integer', minimum: 0, description: "Position among the parent's children; appended when absent." },
    nodes: {
      type: 'array',
      minItems: 1,
      items: { type: 'object', description: 'A node in the generation format: { type, props?, children?, ref?, imageQuery? }.' },
    },
  }, ['pageId', 'nodes']),
  op('updateStyle', "Set or remove one style property of a node, for a breakpoint and a state.", {
    nodeId: idArg('The node'),
    property: { type: 'string', minLength: 1, maxLength: 64, description: 'A camelCase CSS property, e.g. padding, backgroundColor.' },
    value: { type: ['string', 'number', 'null'], description: 'The value; null removes it.' },
    breakpoint: breakpointArg,
    state: { type: 'string', enum: ['hover', 'focused', 'pressed'], description: 'The value applies only while the node is in this state.' },
  }, ['nodeId', 'property', 'value']),
  op('updateText', "Replace a node's text (plain text only, on a node that holds text).", { nodeId: idArg('The node'), text: { type: 'string' } }, ['nodeId', 'text']),
  op('setProps', 'Set or remove attributes (href, alt, src, aria-*). Not style, children, rules or behaviour. An Unsplash src needs the data-credit-* attributes find_images gives, in the same call.', {
    nodeId: idArg('The node'),
    props: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean', 'null'] }, description: 'name to value; null removes it.' },
  }, ['nodeId', 'props']),
  op('moveNode', 'Move a node within its page.', { nodeId: idArg('The node'), to: placeSchema }, ['nodeId', 'to']),
  op('removeNode', 'Remove a node with everything inside it.', { nodeId: idArg('The node') }, ['nodeId']),
  op('addRule', 'A selector rule on a node (&:hover, & > li), optionally inside at-rules.', {
    nodeId: idArg('The node'),
    rule: {
      type: 'object',
      properties: {
        selector: { type: 'string', minLength: 1, maxLength: 500 },
        at: { type: 'array', items: { type: 'string', maxLength: 500 }, maxItems: 4 },
        style: { type: 'object', description: 'Style in breakpoint keys, as in insertNodes.' },
      },
      required: ['selector', 'style'],
      additionalProperties: false,
    },
  }, ['nodeId', 'rule']),
  op('setTheme', 'Replace the whole theme in one write: tokens and document defaults. A style refers to a token as var(--fc-t-<id>).', {
    theme: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['system', 'light', 'dark'] },
        tokens: { type: 'array', maxItems: 700, items: { type: 'object' } },
        document: { type: 'object', additionalProperties: { type: 'string' }, description: 'backgroundColor, color, fontFamily.' },
      },
      required: ['tokens', 'document'],
      additionalProperties: false,
    },
  }, ['theme']),
  op('placeComponent', 'Place an instance of a component definition (get_site lists the components).', {
    pageId: idArg('The page'),
    definitionId: { type: 'string', description: 'The component definition id.' },
    to: placeSchema,
    ref: refArg,
  }, ['pageId', 'definitionId']),
];

const generateTarget = z
  .discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('newPage'), title: z.string().trim().min(1).max(120).optional().describe('The new page title.') }),
    z.strictObject({ kind: z.literal('insert'), pageId, parentId: z.string().trim().min(1).max(200).optional().describe('The container; the page root when absent.') }),
    z.strictObject({ kind: z.literal('replace'), pageId, nodeId: z.string().trim().min(1).max(200).describe('The node the generated section replaces.') }),
  ])
  .describe('What to generate: a new page, a section inserted into a page, or a section replacing a node.');

// ---------- the tools ----------

function define<S extends z.ZodType>(def: ToolDef<S>): ToolDef {
  return def as unknown as ToolDef;
}

function siteSummaryLine(name: string, siteIdValue: string, version: number, pages: Array<{ title: string; slug: string }>): string {
  const list = pages.slice(0, 12).map((p) => `${p.title} (/${p.slug})`).join(', ');
  const more = pages.length > 12 ? ` and ${pages.length - 12} more` : '';
  return `"${name}" (site ${siteIdValue}) at version ${version}, ${pages.length} ${pages.length === 1 ? 'page' : 'pages'}: ${list}${more}`;
}

export const TOOLS: ToolDef[] = [
  define({
    name: 'list_sites',
    title: 'List sites',
    description: "The sites of the key's company: id, name, status (draft or published), last change and address.",
    args: z.strictObject({}),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (ctx) => fromResult(await listSites(ctx.caller, ctx.deps), (sites) => ({ sites })),
  }),
  define({
    name: 'get_site',
    title: 'Read a site',
    description:
      "A site's pages (id, title, slug, breakpoint keys largest first, node count), theme tokens, components, live address and its current `version`, which every write names as expectedVersion.",
    args: z.strictObject({ siteId }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (ctx, args) => fromResult(await getSite(ctx.caller, args, ctx.deps)),
  }),
  define({
    name: 'get_page',
    title: 'Read a page',
    description:
      'An outline of one page in document order: each node with id, parent, depth, tag, text excerpt, own styles keyed by breakpoint, rules and attributes. Long pages come in parts: pass the answer\'s nextCursor as `cursor` for the next part (null means the last). Also answers the site `version`.',
    args: z.strictObject({
      siteId,
      pageId,
      cursor: z.string().trim().min(1).max(200).optional().describe('The nextCursor of the previous part.'),
      maxChars: z
        .number()
        .int()
        .min(2_000)
        .max(OUTLINE_MAX_CHARS)
        .optional()
        .describe(`Size budget of one part in characters of JSON (default ${OUTLINE_DEFAULT_CHARS}).`),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (ctx, args) => fromResult(await getPage(ctx.caller, args, ctx.deps)),
  }),
  define({
    name: 'describe_vocabulary',
    title: 'Describe the vocabulary',
    description:
      'How to write: the batch operations of apply_batch, the node generation format insertNodes takes (tags, props, responsive styles, images), and with a siteId that site\'s breakpoints, theme tokens and components. Read it once before the first write.',
    args: z.strictObject({ siteId: siteId.optional() }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (ctx, args) => fromResult(await describeVocabulary(ctx.caller, args, ctx.deps)),
  }),
  define({
    name: 'create_site',
    title: 'Create a site',
    description: "A new, empty draft site in the key's company with one home page. Answers siteId, homePageId and version 1. Nothing is published.",
    args: z.strictObject({ name: z.string().trim().min(1).max(120).optional().describe('The site name; "Untitled Project" when absent.') }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: (ctx, args) => limited(ctx.limits.writes, ctx, 'write', async () => fromResult(await createSite(ctx.caller, args, ctx.deps))),
  }),
  define({
    name: 'apply_batch',
    title: 'Edit a site',
    description: [
      `Apply a batch of 1 to ${MAX_BATCH_OPS} edit operations to a site's working copy, in order, all or nothing, saved on expectedVersion.`,
      'Operations: createPage, updatePageSettings, insertNodes, updateStyle, updateText, setProps, moveNode, removeNode, addRule, setTheme, placeComponent (describe_vocabulary explains each).',
      'A node or page an operation creates can carry "ref"; later operations of the batch name it as "ref:<name>", and the answer maps each ref to its new id.',
      'Answers the new `version` (name it in the next write), the created ids and one summary line per operation.',
      'Refusals write nothing: site_changed (with currentVersion: read again, then redo the batch on it) or rejected (each refused operation with its index and reason; fix those and resend the whole batch).',
      'This edits the draft only; visitors see nothing until publish. removeNode deletes content from the draft.',
    ].join(' '),
    args: z.strictObject({
      siteId,
      expectedVersion,
      ops: z.array(z.unknown()).min(1).max(MAX_BATCH_OPS).describe('The operations, in order.'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    schemaPatch: (schema) => {
      const properties = schema.properties as Record<string, JsonSchema>;
      properties.ops = { ...properties.ops, items: { oneOf: OPERATION_SCHEMAS } };
      return schema;
    },
    run: (ctx, args) => limited(ctx.limits.writes, ctx, 'write', async () => fromResult(await applyBatch(ctx.caller, args, ctx.deps))),
  }),
  define({
    name: 'generate_page',
    title: 'Generate a page or section',
    description:
      "Generate a page or a section from a brief with the editor's own AI generator and save it on expectedVersion. It runs for a minute or more: wait for the answer, do not retry on a slow response (one generation per key runs at a time, and there is a limit per ten minutes). Answers the new version, the page id, the inserted node ids, and what the generator changed or dropped (warnings). Prefer apply_batch for precise edits; use this for a first draft.",
    args: z.strictObject({
      siteId,
      expectedVersion,
      brief: z.string().trim().min(1).max(GENERATION_LIMITS.maxBriefChars).describe('What the page or section should say and look like.'),
      target: generateTarget,
      model: z.enum(PAGE_GEN_MODELS).optional().describe('The model; SONNET when absent.'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    run: async (ctx, args) => fromResult(await generatePage(ctx.caller, { ...args, signal: ctx.signal }, ctx.deps)),
  }),
  define({
    name: 'find_images',
    title: 'Find stock photos',
    description:
      "Search credited stock photos (Unsplash). Each photo comes with the props that place it: an img's src and data-credit-* attributes, or a container background's. Put those props into insertNodes or setProps unchanged; the credit is required.",
    args: z.strictObject({
      query: z.string().trim().min(1).max(GENERATION_LIMITS.maxImageQueryChars).describe('A short plain description of the photo, e.g. "bakery counter at dawn".'),
      orientation: z.enum(['landscape', 'portrait', 'squarish']).optional(),
      count: z.number().int().min(1).max(10).optional().describe('How many photos (default 5).'),
      widthPx: z.number().int().min(100).max(4000).optional().describe('The width the photo is shown at, for the image size.'),
    }),
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: (ctx, args) => limited(ctx.limits.images, ctx, 'image search', async () => fromResult(await findImages(ctx.caller, args)), false),
  }),
  define({
    name: 'preview_url',
    title: 'Preview link',
    description:
      'The editor preview of the working copy (draft), optionally of one page. Open it in a browser to check every change before publishing; it needs the owner\'s editor sign-in.',
    args: z.strictObject({ siteId, pageId: pageId.optional() }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (ctx, args) => fromResult(await previewUrl(ctx.caller, args, ctx.deps)),
  }),
  define({
    name: 'publish',
    title: 'Publish a site',
    description:
      'Publish the working copy at expectedVersion: visitors see it at once at the site address (allocated on the first publish). Only when the person asked for it. The PERSON confirms every publish: through the client\'s confirmation dialog, or, without one, this tool answers `confirmationRequired` with a `summary` and a `confirmationToken`: show the summary to the person exactly as written, and only after they say yes call again with the same arguments and the token. Never confirm on their behalf. An earlier published version can be served again with rollback.',
    args: z.strictObject({ siteId, expectedVersion, confirmationToken }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    confirms: true,
    run: async (ctx, args) => {
      const site = await getSite(ctx.caller, { siteId: args.siteId }, ctx.deps);
      if (!site.ok) return errorResult(site.error);
      if (site.value.version !== args.expectedVersion) {
        return errorResult({
          code: 'site_changed',
          message: 'the site was changed since that version; read it again and confirm the publish on the current version',
          currentVersion: site.value.version,
        });
      }
      const denied = await allowed(ctx, 'publishSite');
      if (denied) return denied;
      const where = site.value.address ? `at ${site.value.address}` : 'at a new address allocated now (its first publish)';
      const summary = `Publish ${siteSummaryLine(site.value.name, args.siteId, args.expectedVersion, site.value.pages)} ${where}? Visitors see it immediately. An earlier published version can be served again with a rollback.`;
      const subject = ['publish', ctx.key.tenantId, ctx.key.keyId, args.siteId, args.expectedVersion].join('|');
      return confirmedWrite(ctx, summary, subject, args.confirmationToken, 'published', async () =>
        fromResult(await publish(ctx.caller, { siteId: args.siteId, expectedVersion: args.expectedVersion }, ctx.deps)),
      );
    },
  }),
  define({
    name: 'list_revisions',
    title: 'List published versions',
    description: "A site's published versions, newest first, with which one visitors are served (`live`).",
    args: z.strictObject({ siteId }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (ctx, args) => fromResult(await listRevisions(ctx.caller, args, ctx.deps)),
  }),
  define({
    name: 'rollback',
    title: 'Serve an earlier version',
    description:
      'Serve an earlier published version (a revision number from list_revisions) to visitors again. The working copy stays as it is, so the next publish publishes the working copy. Only when the person asked for it. The PERSON confirms every rollback, the same way as publish: the client\'s dialog, or `confirmationRequired` with a `summary` and a `confirmationToken` to bring back after they said yes. Never confirm on their behalf.',
    args: z.strictObject({
      siteId,
      revision: z.number().int().min(1).max(2_147_483_647).describe('The revision number to serve, from list_revisions.'),
      confirmationToken,
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    confirms: true,
    run: async (ctx, args) => {
      const site = await getSite(ctx.caller, { siteId: args.siteId }, ctx.deps);
      if (!site.ok) return errorResult(site.error);
      const denied = await allowed(ctx, 'publishSite');
      if (denied) return denied;
      const history = await listRevisions(ctx.caller, { siteId: args.siteId }, ctx.deps);
      if (!history.ok) return errorResult(history.error);
      const target = history.value.revisions.find((r) => r.number === args.revision);
      if (!target) return errorResult({ code: 'revision_not_found', message: `site "${args.siteId}" has no published version ${args.revision}; list_revisions shows the ones kept` });
      const live = history.value.live;
      const summary = `Serve version ${args.revision} of "${site.value.name}" (site ${args.siteId}, published ${target.createdAt.toISOString().slice(0, 16).replace('T', ' ')} UTC) to visitors again${live ? `, instead of version ${live}` : ''}${site.value.address ? ` at ${site.value.address}` : ''}? The draft stays as it is.`;
      const subject = ['rollback', ctx.key.tenantId, ctx.key.keyId, args.siteId, args.revision, site.value.version, live ?? 'none'].join('|');
      return confirmedWrite(ctx, summary, subject, args.confirmationToken, 'rolled back', async () =>
        fromResult(await rollback(ctx.caller, { siteId: args.siteId, number: args.revision }, ctx.deps)),
      );
    },
  }),
];

// ---------- what tools/list answers ----------

export interface ListedTool {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: ToolAnnotations;
}

function jsonSchemaOf(def: ToolDef): JsonSchema {
  const schema = z.toJSONSchema(def.args, { io: 'input' }) as JsonSchema;
  delete schema.$schema;
  return def.schemaPatch ? def.schemaPatch(schema) : schema;
}

export const LISTED_TOOLS: ListedTool[] = TOOLS.map((def) => ({
  name: def.name,
  title: def.title,
  description: def.description,
  inputSchema: jsonSchemaOf(def),
  annotations: { title: def.title, ...def.annotations },
}));

export function findTool(name: unknown): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}

/** Run a tool on raw arguments: invalid arguments are an `invalid_request` result, a throw a generic failure. */
export async function runTool(def: ToolDef, rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = def.args.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return errorResult({
      code: 'invalid_request',
      message: `the arguments of ${def.name} do not match its input schema`,
      issues: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`),
    });
  }
  try {
    return await def.run(ctx, parsed.data);
  } catch (err) {
    console.error(`[mcp] the tool ${def.name} failed`, err instanceof Error ? redactSecrets(err.message) : typeof err);
    return errorResult({ code: 'internal_error', message: 'the tool failed unexpectedly; read the site again before retrying, a write may or may not have landed' });
  }
}

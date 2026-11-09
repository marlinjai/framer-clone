import 'server-only';

// src/server/siteOps/index.ts
//
// The site operations (plan docs/plans/2026-11-02-lumitra-sites-agent-plugin.md,
// build step 3): one server-side library the MCP endpoint (step 4), the in-editor
// AI (step 7) and a CLI share, so none of them grows a write path of its own.
//
// The caller (src/lib/siteOps/types.ts SiteOpsCaller) arrives verified: its scope
// and company come from its door (a company API key or an editor session), never
// from the request, and `can` answers the real permission. Every operation checks
// it first: reads need viewSite, writes editSite, publish and rollback
// publishSite. A site outside the caller's workspace reads as missing.
//
// Every write goes through the site repository with the version lock: a batch, a
// generated page or a publish names the version it was based on, a newer stored
// version answers `site_changed` with that version, and nothing is written. Each
// successful write leaves one audit row (site_operation_audits) with the actor.
//
// Nothing here throws for an expected failure; every way out is a SiteOpsResult.

import type Anthropic from '@anthropic-ai/sdk';
import { getSnapshot } from 'mobx-state-tree';
import type { ProjectModelType } from '@/models/ProjectModel';
import type { PageModelType } from '@/models/PageModel';
import { getPrismaClient } from '@/server/db';
import {
  getSiteRepository,
  SiteChangedError,
  SiteGoneError,
  SiteNotFoundError,
  SiteRepositoryError,
  SiteRevisionNotFoundError,
  type SiteRepository,
  type SiteRevisionList,
  type SiteSummary,
} from '@/server/sites';
import { SaveAbortedError } from '@/server/sites/repository';
import { revalidateCustomHostsForSiteId, revalidateSiteCache } from '@/server/sites/cachedResolver';
import { ensureCompanyCommerce } from '@/server/sites/companyCommerce';
import { buildEmptyDraftSnapshot } from '@/lib/projects/newProject';
import { projectNameSchema } from '@/lib/projectName';
import { applyOperations, type ApplyDeps, type DeletedPage } from '@/lib/siteOps/applyOps';
import { applyGenerated, generationTarget, type GenerateTarget, type ResolvedTarget } from '@/lib/siteOps/generated';
import { pageOutline, siteOverview, vocabularyFor, type PageOutline, type SiteOverview, type Vocabulary } from '@/lib/siteOps/read';
import {
  BatchSchema,
  fail,
  ok,
  type BatchOutcome,
  type SiteOpsAction,
  type SiteOpsCaller,
  type SiteOpsResult,
} from '@/lib/siteOps/types';
import {
  applyStockPhotos,
  resolveStockImages,
  searchStockPhotos,
  triggerDownloadsForUsedPhotos,
  triggerStockDownloads,
  type FoundPhoto,
  type PlacedPhoto,
} from '@/lib/ai/pageGen/stockImages';
import type { ImageOrientation } from '@/lib/ai/pageGen/validate';
import { runPageGeneration } from '@/lib/ai/pageGen/runPageGeneration';
import { getPageGenRateLimiter } from '@/lib/ai/pageGen/rateLimit';
import { DEFAULT_PAGE_GEN_MODEL, PAGE_GEN_MODELS, type PageGenModel, type StockImageSummary } from '@/lib/ai/pageGen/protocol';
import { GENERATION_LIMITS } from '@/lib/ai/pageGen/schema';
import { siteContextFromSettings } from '@/lib/ai/pageGen/promptSections/siteContext';
import { getAnthropicClient, MissingAnthropicKeyError } from '@/lib/ai/anthropicClient';
import { logAiCall, startAiCallTimer } from '@/lib/ai/aiLogger';
import { recordUsage } from '@/lib/ai/aiUsageStub';
import { recordSiteOperation, type AuditedOp } from './audit';
import type { GenDoneStatus, GenDraftTarget, SiteWriteActor } from '@/lib/projects/liveEvents';
import { openLiveGeneration, type LiveGenerationRun } from '@/server/sites/liveGeneration';
import { refPagesOf, splitCreated } from '@/lib/siteOps/createdIds';
import { fulfilFromBatch } from '@/server/mcp/livePlans';
import { liveAgentId } from './audit';

export type { SiteOpsCaller, SiteOpsResult } from '@/lib/siteOps/types';

/** What the operations need from the outside, injectable for tests. */
export interface SiteOpsDeps {
  repository?: SiteRepository;
  /** The Anthropic client for generatePage (defaults to the configured one). */
  anthropic?: () => Anthropic;
  /** The editor's host, for preview links (defaults to EDITOR_HOST). */
  editorHost?: string | null;
  /** The published sites' base host (defaults to PUBLIC_SITE_BASE_HOST). */
  publicBaseHost?: string | null;
}

const repo = (deps: SiteOpsDeps) => deps.repository ?? getSiteRepository();

// ---------- shared plumbing ----------

async function permitted(caller: SiteOpsCaller, action: SiteOpsAction): Promise<SiteOpsResult<true>> {
  let allowed = false;
  try {
    allowed = await caller.can(action);
  } catch (err) {
    // A permission service that cannot answer is an outage, never a "no" and never a "yes".
    console.error(`[site-ops] permission check for ${action} failed`, err instanceof Error ? err.name : err);
    return fail({ code: 'unavailable', message: 'the permission check could not be made; try again', retryAfterSec: 5 });
  }
  return allowed ? ok(true) : fail({ code: 'forbidden', message: `this caller may not ${action}` });
}

/** What an unexpected failure answers; its cause is in the server log. */
export const GENERIC_LIBRARY_FAILURE = 'the operation failed unexpectedly; read the site again before retrying';

/** A thrown repository error as the result a caller acts on. */
function fromError(err: unknown, siteId?: string): SiteOpsResult<never> {
  if (err instanceof SiteChangedError) {
    return fail({
      code: 'site_changed',
      message: 'the site was changed since that version; read it again and retry on the current version',
      currentVersion: err.currentVersion,
    });
  }
  // The repository's own messages speak to an editor tab ("reload the page", "this
  // tab"); a caller of this library is an agent or a CLI as often, so the codes that
  // can come back here get wording that names what to do through these operations.
  if (err instanceof SiteNotFoundError || err instanceof SiteGoneError) {
    return fail({
      code: 'site_not_found',
      message: siteId ? `no site "${siteId}" for this caller` : 'the site does not exist (any more); nothing was written',
    });
  }
  if (err instanceof SiteRevisionNotFoundError) return fail({ code: 'revision_not_found', message: err.message });
  if (err instanceof SiteRepositoryError && err.code === 'version_required') {
    return fail({
      code: 'invalid_request',
      message: 'this write names no expectedVersion; read the site (its version) and send that number with the write',
    });
  }
  if (err instanceof SiteRepositoryError && err.status === 400) return fail({ code: 'invalid_request', message: err.message });
  if (err instanceof SiteRepositoryError && err.code === 'erased_since_load') {
    return fail({
      code: 'failed',
      message:
        'personal data was erased from this site after it was read, so this write could carry it back; nothing was written. Read the site again and redo the change on its current version',
    });
  }
  // Another conflict: nothing was written, and only a fresh read helps.
  if (err instanceof SiteRepositoryError && err.status === 409) {
    return fail({ code: 'failed', message: `${err.message}; read the site again and retry` });
  }
  // The error's own text (a database driver's, say) stays in the server log: it
  // can name tables, hosts or values a caller has no business reading.
  console.error('[site-ops] unexpected failure', err);
  return fail({ code: 'failed', message: GENERIC_LIBRARY_FAILURE });
}

async function load(
  deps: SiteOpsDeps,
  caller: SiteOpsCaller,
  siteId: string,
): Promise<SiteOpsResult<{ project: ProjectModelType; version: number }>> {
  try {
    return ok(await repo(deps).loadProjectWithVersion(caller.scope, siteId));
  } catch (err) {
    return fromError(err, siteId);
  }
}

const staleVersion = (current: number): SiteOpsResult<never> =>
  fail({
    code: 'site_changed',
    message: 'the site was changed since that version; read it again and retry on the current version',
    currentVersion: current,
  });

/** Places stock photos for a batch's imageQuery requests, keeping what it placed for the download count. */
function photoPlacer(placed: PlacedPhoto[]): NonNullable<ApplyDeps['placeImages']> {
  return async (nodes, requests) => {
    const resolution = await resolveStockImages(requests);
    placed.push(...resolution.placed);
    return { nodes: applyStockPhotos(nodes, resolution.placed), missing: requests.length - resolution.placed.length };
  };
}

/** Write an audit row; a failure is logged loudly but never undoes a write that committed. */
async function audit(caller: SiteOpsCaller, siteId: string, entry: Omit<Parameters<typeof recordSiteOperation>[2], 'siteId'>) {
  try {
    await recordSiteOperation(getPrismaClient(), caller, { siteId, ...entry });
  } catch (err) {
    console.error(`[site-ops] audit row for ${entry.operation} on ${siteId} could not be written`, err);
  }
}

/**
 * The writer as an open editor's live stream names it (src/lib/projects/liveEvents.ts):
 * the caller's declared label, else a generic one. Never the key id.
 */
function liveActor(caller: SiteOpsCaller): SiteWriteActor {
  return { kind: caller.actor.kind, label: caller.actorLabel ?? (caller.actor.kind === 'key' ? 'Agent' : 'Someone') };
}

/**
 * The operations of a batch by name and id. For the audit row, a deleted page is
 * recorded by its resolved id, slug and title (`deleted`), since its row is gone
 * after the write; never its content.
 */
function auditedOps(raw: unknown[], deleted: readonly DeletedPage[] = []): AuditedOp[] {
  const byIndex = new Map(deleted.map((d) => [d.index, d]));
  return raw.map((op, index) => {
    const o = (op ?? {}) as Record<string, unknown>;
    const out: AuditedOp = { op: typeof o.op === 'string' ? o.op : 'unknown' };
    if (typeof o.nodeId === 'string') out.nodeId = o.nodeId;
    if (typeof o.pageId === 'string') out.pageId = o.pageId;
    const gone = byIndex.get(index);
    if (gone) Object.assign(out, { pageId: gone.pageId, slug: gone.slug.slice(0, 200), title: gone.title.slice(0, 120) });
    return out;
  });
}

// ---------- reads ----------

export interface SiteListing {
  siteId: string;
  name: string;
  status: string;
  updatedAt: string;
  subdomain: string | null;
  customDomains: string[];
}

export async function listSites(caller: SiteOpsCaller, deps: SiteOpsDeps = {}): Promise<SiteOpsResult<SiteListing[]>> {
  const allowed = await permitted(caller, 'viewSite');
  if (!allowed.ok) return allowed;
  try {
    const sites: SiteSummary[] = await repo(deps).listSites(caller.scope);
    return ok(
      sites.map((s) => ({
        siteId: s.siteId,
        name: s.name,
        status: s.status,
        updatedAt: s.updatedAt.toISOString(),
        subdomain: s.subdomain,
        customDomains: s.customDomains,
      })),
    );
  } catch (err) {
    return fromError(err);
  }
}

export async function getSite(
  caller: SiteOpsCaller,
  input: { siteId: string },
  deps: SiteOpsDeps = {},
): Promise<SiteOpsResult<SiteOverview & { address: string | null }>> {
  const allowed = await permitted(caller, 'viewSite');
  if (!allowed.ok) return allowed;
  const loaded = await load(deps, caller, input.siteId);
  if (!loaded.ok) return loaded;
  try {
    const { host } = await repo(deps).getSiteAddress(caller.scope, input.siteId, publicBaseHost(deps));
    return ok({ ...siteOverview(loaded.value.project, loaded.value.version), address: host ? `https://${host}` : null });
  } catch (err) {
    return fromError(err, input.siteId);
  }
}

export async function getPage(
  caller: SiteOpsCaller,
  input: { siteId: string; pageId: string; cursor?: string; maxChars?: number },
  deps: SiteOpsDeps = {},
): Promise<SiteOpsResult<PageOutline & { version: number }>> {
  const allowed = await permitted(caller, 'viewSite');
  if (!allowed.ok) return allowed;
  const loaded = await load(deps, caller, input.siteId);
  if (!loaded.ok) return loaded;
  const page = loaded.value.project.pages.get(input.pageId) as PageModelType | undefined;
  if (!page) return fail({ code: 'page_not_found', message: `no page "${input.pageId}" on this site` });
  try {
    return ok({ ...pageOutline(page, { cursor: input.cursor, maxChars: input.maxChars }), version: loaded.value.version });
  } catch (err) {
    return fail({ code: 'invalid_request', message: err instanceof Error ? err.message : 'bad cursor' });
  }
}

/**
 * Whether a key may announce skeleton sections where it says (the MCP tool
 * announce_sections, src/server/mcp/livePlans.ts): `editSite`, the site in the
 * caller's own scope (a site of another company is "not found", as for every
 * operation), the page when one is named, and `after` as a top-level section
 * of that page (a child of its root), where a skeleton can stand. Reads only;
 * writes nothing.
 */
export async function checkPlanAnchor(
  caller: SiteOpsCaller,
  input: { siteId: string; pageId?: string; after?: string },
  deps: SiteOpsDeps = {},
): Promise<SiteOpsResult<{ version: number }>> {
  const allowed = await permitted(caller, 'editSite');
  if (!allowed.ok) return allowed;
  const loaded = await load(deps, caller, input.siteId);
  if (!loaded.ok) return loaded;
  if (input.pageId) {
    const page = loaded.value.project.pages.get(input.pageId) as PageModelType | undefined;
    if (!page) return fail({ code: 'page_not_found', message: `no page "${input.pageId}" on this site` });
    if (input.after) {
      const root = page.appComponentTree as { children: Array<{ id: string }> } | undefined;
      if (!root?.children.some((c) => c.id === input.after)) {
        return fail({
          code: 'invalid_request',
          message: `"after" must be the id of a top-level section of the page (a child of its root, from get_page); "${input.after}" is not one`,
        });
      }
    }
  }
  return ok({ version: loaded.value.version });
}

export async function describeVocabulary(
  caller: SiteOpsCaller,
  input: { siteId?: string } = {},
  deps: SiteOpsDeps = {},
): Promise<SiteOpsResult<Vocabulary>> {
  const allowed = await permitted(caller, 'viewSite');
  if (!allowed.ok) return allowed;
  if (!input.siteId) return ok(vocabularyFor());
  const loaded = await load(deps, caller, input.siteId);
  if (!loaded.ok) return loaded;
  return ok(vocabularyFor(loaded.value.project, loaded.value.version));
}

// ---------- writes ----------

/**
 * Apply one batch of operations (src/lib/siteOps/types.ts) all or nothing and
 * save it on the version it was based on.
 */
export async function applyBatch(caller: SiteOpsCaller, input: unknown, deps: SiteOpsDeps = {}): Promise<SiteOpsResult<BatchOutcome>> {
  const allowed = await permitted(caller, 'editSite');
  if (!allowed.ok) return allowed;
  const parsed = BatchSchema.safeParse(input);
  if (!parsed.success) {
    return fail({
      code: 'invalid_request',
      message: 'a batch is { siteId, expectedVersion, ops: [...] }',
      issues: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.') || 'batch'}: ${i.message}`),
    });
  }
  const { siteId, expectedVersion, ops } = parsed.data;
  const loaded = await load(deps, caller, siteId);
  if (!loaded.ok) return loaded;
  const { project, version } = loaded.value;
  // Fail fast: nothing is applied on a version the caller did not read.
  if (version !== expectedVersion) return staleVersion(version);

  const placed: PlacedPhoto[] = [];
  const applied = await applyOperations(project, ops, { placeImages: photoPlacer(placed) });
  if (!applied.ok) {
    return fail({
      code: 'rejected',
      message: 'the batch was refused and nothing was written',
      rejected: applied.rejected,
    });
  }
  let written: number;
  try {
    ({ version: written } = await repo(deps).saveProject(caller.scope, project, {
      mustExist: true,
      companyId: caller.companyId,
      expectedVersion,
      // Open editors adopt the write and learn what it touched (ids and server-written lines only).
      event: { origin: 'mcp', actor: liveActor(caller), ops: auditedOps(ops), created: applied.created, summary: applied.summary },
      // The skeletons this key announced and this batch wrote are fulfilled before open editors hear of the write,
      // so an editor never adopts the copy while the skeleton still counts as unwritten.
      ...(caller.actor.kind === 'key'
        ? { beforeAnnounce: (v: number) => fulfilFromBatch(siteId, liveAgentId(caller.actor.id), applied.created, v, refPagesOf(ops, applied.created, (pid) => (project.pages.get(pid) as PageModelType | undefined)?.appComponentTree?.id), splitCreated(ops, applied.created).pageIds) }
        : {}),
    }));
  } catch (err) {
    return fromError(err, siteId);
  }
  countPhotoDownloads(project, placed);
  await audit(caller, siteId, { operation: 'batch', ops: auditedOps(ops, applied.deletedPages), versionBefore: version, versionAfter: written, created: splitCreated(ops, applied.created) });
  return ok({ siteId, version: written, created: applied.created, summary: applied.summary });
}

/** Unsplash counts a download when a photo is used: the ones a write just placed. */
function countPhotoDownloads(project: ProjectModelType, placed: PlacedPhoto[]): void {
  if (placed.length > 0) triggerStockDownloads(placed);
  triggerDownloadsForUsedPhotos(JSON.stringify(getSnapshot(project)));
}

/**
 * A new, empty draft site in the caller's company: one home page with the
 * default frames. The company's shop schema is provisioned first, exactly as the
 * project create route does, so a failure leaves nothing behind.
 */
export async function createSite(
  caller: SiteOpsCaller,
  input: { name?: string } = {},
  deps: SiteOpsDeps = {},
): Promise<SiteOpsResult<{ siteId: string; version: number; homePageId: string }>> {
  const allowed = await permitted(caller, 'editSite');
  if (!allowed.ok) return allowed;
  const name = projectNameSchema.safeParse(input.name ?? 'Untitled Project');
  if (!name.success) return fail({ code: 'invalid_request', message: name.error.issues[0]?.message ?? 'invalid name' });

  const commerce = await ensureCompanyCommerce(caller.scope.tenantGroupId, caller.companySlug);
  if (!commerce.ok) {
    return commerce.status === 503
      ? fail({ code: 'unavailable', message: commerce.message, retryAfterSec: commerce.retryAfterSec })
      : commerce.status === 403
        ? fail({ code: 'forbidden', message: commerce.message })
        : fail({ code: 'failed', message: commerce.message });
  }
  const siteId = globalThis.crypto.randomUUID();
  const snapshot = buildEmptyDraftSnapshot(siteId, name.data, Date.now());
  let version: number;
  try {
    ({ version } = await repo(deps).saveProject(caller.scope, snapshot, { companyId: caller.companyId }));
  } catch (err) {
    return fromError(err);
  }
  await audit(caller, siteId, { operation: 'create_site', versionAfter: version });
  return ok({ siteId, version, homePageId: Object.keys(snapshot.pages)[0] });
}

// ---------- generation ----------

export interface GeneratePageInput {
  siteId: string;
  expectedVersion: number;
  brief: string;
  target: GenerateTarget;
  model?: PageGenModel;
  /** Stops the model call (and the spend); the result is then not saved and the open editors drop the draft. */
  signal?: AbortSignal;
}

export interface GeneratePageOutcome {
  siteId: string;
  version: number;
  pageId: string;
  insertedIds: string[];
  /** Everything the generator dropped or changed, and its automatic fixes. */
  warnings: string[];
  /** Design issues the repair round left. */
  tells: string[];
  images: StockImageSummary;
}

/**
 * Generate a page or a section from a brief with the editor's own generator
 * (src/lib/ai/pageGen/runPageGeneration.ts) and save it through the version
 * lock. The per-actor generation rate limit applies, as in the editor.
 */
export async function generatePage(
  caller: SiteOpsCaller,
  input: GeneratePageInput,
  deps: SiteOpsDeps = {},
): Promise<SiteOpsResult<GeneratePageOutcome>> {
  const allowed = await permitted(caller, 'editSite');
  if (!allowed.ok) return allowed;
  const brief = input.brief?.trim() ?? '';
  if (!brief || brief.length > GENERATION_LIMITS.maxBriefChars) {
    return fail({ code: 'invalid_request', message: `the brief is 1 to ${GENERATION_LIMITS.maxBriefChars} characters` });
  }
  const model = input.model ?? DEFAULT_PAGE_GEN_MODEL;
  if (!(PAGE_GEN_MODELS as readonly string[]).includes(model)) {
    return fail({ code: 'invalid_request', message: `model is one of ${PAGE_GEN_MODELS.join(', ')}` });
  }
  const loaded = await load(deps, caller, input.siteId);
  if (!loaded.ok) return loaded;
  const { project, version } = loaded.value;
  if (version !== input.expectedVersion) return staleVersion(version);
  const target = generationTarget(project, input.target);
  if (!target.ok) return fail({ code: 'invalid_request', message: target.reason });

  let anthropic: Anthropic;
  try {
    anthropic = (deps.anthropic ?? getAnthropicClient)();
  } catch (err) {
    if (err instanceof MissingAnthropicKeyError) return fail({ code: 'unavailable', message: 'page generation is not configured on this server' });
    throw err;
  }
  // The same budget as the editor's Generate dialog: one run at a time per actor, a window limit.
  const limiterKey = `${caller.actor.kind}:${caller.actor.id}`;
  const slot = getPageGenRateLimiter().acquire(limiterKey);
  if (!slot.ok) {
    return fail({
      code: 'rate_limited',
      message: slot.reason === 'in_flight' ? 'a generation is already running for this caller' : 'generation limit reached',
      retryAfterSec: slot.retryAfterSec,
    });
  }

  const requestId = globalThis.crypto.randomUUID();
  // The open editors of the site watch the draft build itself (plan
  // docs/plans/2026-11-08-live-agent-canvas.md, section 3): opened only now, after
  // the site was loaded through the caller's own scope. Every way out below ends
  // it exactly once: `saved` from the repository's pre-announcement step, so the
  // editor hears it before the version it fetches; anything else in the finally.
  const live = openLiveGeneration(input.siteId, caller.scope, requestId, liveDraftTarget(target.value, input.target));
  let ended: GenDoneStatus = 'failed';
  try {
    const outcome = await runAndSaveGeneration(caller, input, deps, {
      anthropic,
      slot,
      requestId,
      brief,
      model,
      project,
      version,
      target: target.value,
      live,
    });
    ended = outcome.ended;
    return outcome.result;
  } finally {
    // Saved: already ended in the pre-announcement step (this call then does nothing).
    live.end(ended);
  }
}

/** Where the open editors draw a run's draft: ids only (the model's context stays here). */
function liveDraftTarget(resolved: ResolvedTarget, requested: GenerateTarget): GenDraftTarget {
  if (resolved.kind === 'newPage') return { kind: 'newPage', ...(requested.kind === 'newPage' && requested.title ? { title: requested.title } : {}) };
  if (resolved.kind === 'replace') return { kind: 'replace', pageId: resolved.pageId!, nodeId: resolved.componentId! };
  return { kind: 'insert', pageId: resolved.pageId!, parentId: resolved.componentId! };
}

interface GenerationRun {
  anthropic: Anthropic;
  slot: { release(): void };
  requestId: string;
  brief: string;
  model: PageGenModel;
  project: ProjectModelType;
  version: number;
  target: ResolvedTarget;
  live: LiveGenerationRun;
}

/** generatePage past its checks: run the model, place the result and save it. Answers how the live run ended. */
async function runAndSaveGeneration(
  caller: SiteOpsCaller,
  input: GeneratePageInput,
  deps: SiteOpsDeps,
  run: GenerationRun,
): Promise<{ result: SiteOpsResult<GeneratePageOutcome>; ended: GenDoneStatus }> {
  const { anthropic, slot, requestId, brief, model, project, version, live } = run;
  const target = { value: run.target };
  const timer = startAiCallTimer();
  let generated: Awaited<ReturnType<typeof runPageGeneration>> | undefined;
  try {
    generated = await runPageGeneration(
      {
        brief,
        model,
        breakpoints: target.value.breakpoints.map(({ label, minWidth }) => ({ label, minWidth })),
        target: target.value.wire,
        projectName: project.metadata.title,
        siteContext: siteContextFromSettings(project.site, project.metadata.title, project.pagesArray),
        ...(target.value.kind === 'newPage'
          ? { existingPageTitles: project.pagesArray.map((p) => p.metadata.title).slice(0, 100) }
          : {}),
      },
      {
        anthropic,
        signal: input.signal ?? new AbortController().signal,
        userId: `${caller.actor.kind}:${caller.actor.id}`,
        workspaceId: caller.scope.workspaceId,
        onOutline: (outline) => live.outline(outline),
        onSection: (section) => live.section(section),
      },
      requestId,
    );
  } finally {
    slot.release();
    if (generated) {
      const limiterKey = `${caller.actor.kind}:${caller.actor.id}`;
      const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = generated.usage;
      recordUsage({ sessionId: limiterKey, inputTokens, outputTokens, cachedReadTokens: cacheReadTokens, cachedWriteTokens: cacheWriteTokens });
      logAiCall({
        requestId,
        sessionId: `site-ops-generate:${caller.scope.workspaceId}`,
        userId: limiterKey,
        model: generated.usage.model,
        promptChars: brief.length,
        inputTokens,
        outputTokens,
        cachedReadTokens: cacheReadTokens,
        cachedWriteTokens: cacheWriteTokens,
        latencyMs: timer.latencyMs(),
        status: generated.outcome.kind === 'result' ? 'ok' : 'error',
        ...(generated.outcome.kind === 'error' ? { errorCode: String(generated.outcome.error.code) } : {}),
      });
    }
  }

  // A stop while the model streams comes back as the provider's abort error, not as `aborted`.
  const { outcome } = generated;
  if (outcome.kind === 'error' && outcome.error.code !== 'aborted' && input.signal?.aborted !== true) {
    const { error } = outcome;
    if (error.code === 'rate_limited' || error.code === 'overloaded') {
      return { ended: 'failed', result: fail({ code: 'unavailable', message: error.message, retryAfterSec: 30 }) };
    }
    return { ended: 'failed', result: fail({ code: 'failed', message: error.message }) };
  }
  // Stopped after the model answered (the MCP client went away while photos were placed): nothing is written either.
  if (outcome.kind !== 'result' || input.signal?.aborted === true) {
    return { ended: 'stopped', result: fail({ code: 'failed', message: 'the generation was stopped; nothing was saved' }) };
  }
  const { payload, placed } = outcome;
  const applied = applyGenerated(
    project,
    target.value,
    payload,
    input.target.kind === 'newPage' ? input.target.title : undefined,
  );
  if (!applied.ok) {
    return {
      ended: 'rejected',
      result: fail({ code: 'rejected', message: applied.reason, rejected: [{ index: 0, op: 'generatePage', reason: applied.reason }] }),
    };
  }
  let written: number;
  try {
    ({ version: written } = await repo(deps).saveProject(caller.scope, project, {
      mustExist: true,
      companyId: caller.companyId,
      expectedVersion: input.expectedVersion,
      event: {
        origin: 'generate',
        actor: liveActor(caller),
        ops: [{ op: `generate:${input.target.kind}`, pageId: applied.pageId }],
      },
      // After the commit, before the `site:version` goes out: the open editors
      // learn that the draft ends at this version, and drop it in the same step
      // they adopt it.
      signal: input.signal,
      beforeAnnounce: (savedAt) => live.end('saved', { version: savedAt, insertedIds: applied.insertedIds, nodes: payload.nodes }),
    }));
  } catch (err) {
    // Stopped while the save waited for its transaction: it rolled back, nothing was written.
    if (err instanceof SaveAbortedError) {
      return { ended: 'stopped', result: fail({ code: 'failed', message: 'the generation was stopped; nothing was saved' }) };
    }
    return { ended: err instanceof SiteChangedError ? 'site_changed' : 'failed', result: fromError(err, input.siteId) };
  }
  // A write that wrote nothing (the repeat of a lost answer) runs no pre-announcement step.
  live.end('saved', { version: written, insertedIds: applied.insertedIds, nodes: payload.nodes });
  if (placed.length > 0) triggerStockDownloads(placed);
  await audit(caller, input.siteId, {
    operation: 'generate_page',
    ops: [{ op: `generate:${input.target.kind}`, pageId: applied.pageId }],
    versionBefore: version,
    versionAfter: written,
    created: { nodeIds: applied.insertedIds, pageIds: [] },
  });
  return {
    ended: 'saved',
    result: ok({
      siteId: input.siteId,
      version: written,
      pageId: applied.pageId,
      insertedIds: applied.insertedIds,
      warnings: payload.warnings,
      tells: payload.tells ?? [],
      images: payload.images,
    }),
  };
}

// ---------- images ----------

const ORIENTATIONS: readonly ImageOrientation[] = ['landscape', 'portrait', 'squarish'];

/**
 * Stock photos for a query, each with the props that place it (an img's src and
 * credit, or a container background's credit). The provider key stays on the
 * server; the download is counted when a later write uses the photo.
 */
export async function findImages(
  caller: SiteOpsCaller,
  input: { query: string; orientation?: ImageOrientation; count?: number; widthPx?: number },
): Promise<SiteOpsResult<{ photos: FoundPhoto[] }>> {
  const allowed = await permitted(caller, 'editSite');
  if (!allowed.ok) return allowed;
  if (input.orientation && !ORIENTATIONS.includes(input.orientation)) {
    return fail({ code: 'invalid_request', message: `orientation is one of ${ORIENTATIONS.join(', ')}` });
  }
  const outcome = await searchStockPhotos(input.query ?? '', {
    orientation: input.orientation,
    count: input.count,
    widthPx: input.widthPx,
  });
  if (outcome.ok) return ok({ photos: outcome.photos });
  switch (outcome.reason) {
    case 'invalid_query':
      return fail({ code: 'invalid_request', message: 'the query is a short plain description of the photo' });
    case 'disabled':
      return fail({ code: 'unavailable', message: 'stock photos are not configured on this server' });
    case 'rate_limited':
      return fail({ code: 'rate_limited', message: 'the stock photo budget is spent for now', retryAfterSec: 600 });
    default:
      return fail({ code: 'unavailable', message: `the stock photo search is unavailable (${outcome.reason})`, retryAfterSec: 60 });
  }
}

// ---------- preview and publish ----------

function publicBaseHost(deps: SiteOpsDeps): string | null | undefined {
  return deps.publicBaseHost !== undefined ? deps.publicBaseHost : process.env.PUBLIC_SITE_BASE_HOST;
}

/** The editor's preview of the working copy (it needs the owner's editor sign-in). */
export async function previewUrl(
  caller: SiteOpsCaller,
  input: { siteId: string; pageId?: string },
  deps: SiteOpsDeps = {},
): Promise<SiteOpsResult<{ url: string }>> {
  const allowed = await permitted(caller, 'viewSite');
  if (!allowed.ok) return allowed;
  const loaded = await load(deps, caller, input.siteId);
  if (!loaded.ok) return loaded;
  if (input.pageId && !loaded.value.project.pages.get(input.pageId)) {
    return fail({ code: 'page_not_found', message: `no page "${input.pageId}" on this site` });
  }
  const host = (deps.editorHost !== undefined ? deps.editorHost : process.env.EDITOR_HOST)?.trim();
  const path = `/projects/${encodeURIComponent(input.siteId)}/preview${input.pageId ? `?page=${encodeURIComponent(input.pageId)}` : ''}`;
  return ok({ url: host ? `https://${host}${path}` : path });
}

export interface PublishOutcome {
  siteId: string;
  revision: number;
  version: number;
  subdomain: string;
  liveUrl: string | null;
}

/** The revision's author as the repository keeps it: a user id, or `key:<id>` for an API key. */
const publishedBy = (caller: SiteOpsCaller) => (caller.actor.kind === 'user' ? caller.actor.id : `key:${caller.actor.id}`);

/**
 * Publish the working copy as it is stored at `expectedVersion`: freeze it as a
 * revision visitors are served, allocate the address on a first publish and
 * refresh the caches, as the editor's Publish does. A confirmation step belongs
 * to the caller's door (the MCP endpoint's), not here.
 */
export async function publish(
  caller: SiteOpsCaller,
  input: { siteId: string; expectedVersion: number },
  deps: SiteOpsDeps = {},
): Promise<SiteOpsResult<PublishOutcome>> {
  const allowed = await permitted(caller, 'publishSite');
  if (!allowed.ok) return allowed;
  const loaded = await load(deps, caller, input.siteId);
  if (!loaded.ok) return loaded;
  const { project, version } = loaded.value;
  if (version !== input.expectedVersion) return staleVersion(version);
  const repository = repo(deps);
  let written: { revision: number; version: number } | undefined;
  try {
    written = await repository.publishProject(caller.scope, project, {
      companyId: caller.companyId,
      publishedBy: publishedBy(caller),
      expectedVersion: input.expectedVersion,
      event: { actor: liveActor(caller) },
    });
    const { subdomain } = await repository.ensureSiteDomain(caller.scope, input.siteId);
    revalidateSiteCache(subdomain);
    // The publish committed: a failure to refresh a custom host is logged, as in the route.
    await revalidateCustomHostsForSiteId(input.siteId).catch((err: unknown) => {
      console.error(`[site-ops] custom-domain cache revalidation failed for ${input.siteId}`, err);
    });
    await audit(caller, input.siteId, {
      operation: 'publish',
      versionBefore: version,
      versionAfter: written.version,
      revision: written.revision,
    });
    const baseHost = publicBaseHost(deps);
    return ok({
      siteId: input.siteId,
      revision: written.revision,
      version: written.version,
      subdomain,
      liveUrl: baseHost ? `https://${subdomain}.${baseHost}` : null,
    });
  } catch (err) {
    const failure = fromError(err instanceof SiteNotFoundError && written ? new SiteGoneError() : err, input.siteId);
    // Published, then a later step failed: the working copy moved, and the caller must know to which version.
    if (written && !failure.ok) {
      await audit(caller, input.siteId, { operation: 'publish', versionBefore: version, versionAfter: written.version, revision: written.revision });
      return fail({ code: 'failed', message: failure.error.message, writtenVersion: written.version });
    }
    return failure;
  }
}

export async function listRevisions(
  caller: SiteOpsCaller,
  input: { siteId: string },
  deps: SiteOpsDeps = {},
): Promise<SiteOpsResult<SiteRevisionList>> {
  const allowed = await permitted(caller, 'viewSite');
  if (!allowed.ok) return allowed;
  try {
    return ok(await repo(deps).listRevisions(caller.scope, input.siteId));
  } catch (err) {
    return fromError(err, input.siteId);
  }
}

/**
 * Serve an earlier revision again. The working copy and its version stay as they
 * are, so the next publish publishes the working copy.
 */
export async function rollback(
  caller: SiteOpsCaller,
  input: { siteId: string; number: number },
  deps: SiteOpsDeps = {},
): Promise<SiteOpsResult<{ siteId: string; live: number }>> {
  const allowed = await permitted(caller, 'publishSite');
  if (!allowed.ok) return allowed;
  if (!Number.isInteger(input.number) || input.number < 1 || input.number > 2147483647) {
    return fail({ code: 'revision_not_found', message: `no revision ${input.number} on this site` });
  }
  const repository = repo(deps);
  try {
    await repository.rollbackToRevision(caller.scope, input.siteId, input.number);
    // Idempotent, so a site unpublished before the rollback gets its address back too.
    const { subdomain } = await repository.ensureSiteDomain(caller.scope, input.siteId);
    revalidateSiteCache(subdomain);
    // Cached custom-host hits never expire on their own: surface a failure so the caller retries.
    await revalidateCustomHostsForSiteId(input.siteId);
  } catch (err) {
    return fromError(err, input.siteId);
  }
  await audit(caller, input.siteId, { operation: 'rollback', revision: input.number });
  return ok({ siteId: input.siteId, live: input.number });
}

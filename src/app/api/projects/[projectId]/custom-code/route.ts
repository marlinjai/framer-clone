// src/app/api/projects/[projectId]/custom-code/route.ts
//
// The one way a site's sandboxed custom code is written (plan
// docs/plans/2026-11-02-sandboxed-custom-code.md, slice C4, decisions D99 to D112):
//
// GET  /api/projects/<projectId>/custom-code              the site's custom code status for the
//      editor: whether it is switched on, whether this person may write it, whether this server
//      serves blocks at all, the limits and the live code the site holds (viewSite)
// GET  /api/projects/<projectId>/custom-code?sha256=<hex>  one block's stored code, declaration and
//      title, for the panel (viewSite); only a hash this site holds
// POST /api/projects/<projectId>/custom-code              { pageId, nodeId, title, document,
//      declaration, replaces? } -> { sha256, created } (manageCustomCode). The node then names the
//      hash through one model action in the editor.
//
// Both answer 404 `custom_code_unavailable` while CUSTOM_CODE_AVAILABLE is not exactly `1` (D99),
// before any session is read. Otherwise guarded like every per-project editor route
// (src/server/domains/guard.ts): editor host only, a verified session (401), the project in one of
// the session's companies (403), auth-brain or OpenFGA outages as 503. Every refusal is the
// `{ error: { code, message } }` envelope, with a sentence a person can act on.
//
// Neither the code nor anything a database error says about it is ever logged.

import { z } from 'zod';
import { withAuthAvailability, AuthzUnavailableError, authzUnavailableResponse } from '@/lib/authBrainAvailability';
import { jsonError, readBodyText } from '@/lib/api/respond';
import { checkWorkspaceAccess } from '@/lib/auth-check';
import { authorizeDomainProject, type DomainProjectResult } from '@/server/domains/guard';
import { BOX_LIMITS, BOX_SHA256_PATTERN } from '@/lib/customCode/contract';
import { boxFrameSource } from '@/lib/customCode/customCode';
import {
  CUSTOM_CODE_REQUEST_MAX_BYTES,
  CUSTOM_CODE_WRITES_PER_HOUR,
  checkCustomCodeInput,
  isCustomCodeAvailable,
  type CustomCodeRefusal,
} from '@/lib/customCode/authoring';
import { readCustomCodeBlob, readCustomCodeStatus, writeCustomCodeBlob } from '@/server/customCode/authoring';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ projectId: string }> };

const NO_STORE = { 'cache-control': 'no-store' };

/** A page or node id as the editor writes them: short, printable, never markup. */
const idSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9_:.-]+$/);

const writeBodySchema = z.object({
  pageId: idSchema,
  nodeId: idSchema,
  // Checked by checkCustomCodeInput, which gives each its own reason.
  title: z.unknown(),
  document: z.unknown(),
  declaration: z.unknown(),
  replaces: z.string().regex(BOX_SHA256_PATTERN).optional(),
}).strict();

function unavailable(): Response {
  return jsonError('custom_code_unavailable', 'Custom code is not available on this server yet.', 404);
}

/** The guard's answer, with a reason in place of its bare "Forbidden". */
function guardResponse(auth: Extract<DomainProjectResult, { ok: false }>): Response {
  if (auth.response.status === 403) {
    return jsonError('forbidden', 'This project does not exist, or your account has no access to it.', 403);
  }
  return auth.response;
}

function refusalResponse(refusal: CustomCodeRefusal): Response {
  const extra = refusal.retryAfterSeconds !== undefined ? { retryAfterSeconds: refusal.retryAfterSeconds } : undefined;
  const response = jsonError(refusal.code, refusal.message, refusal.status, extra);
  if (refusal.retryAfterSeconds !== undefined) response.headers.set('retry-after', String(refusal.retryAfterSeconds));
  return response;
}

/** A failure nobody planned for: logged by its name and code only, since a database error can quote the row. */
function failure(what: string, err: unknown): Response {
  const name = err instanceof Error ? err.name : 'unknown error';
  const code = typeof (err as { code?: unknown })?.code === 'string' ? ` ${(err as { code: string }).code}` : '';
  console.error(`[custom code] ${what} failed: ${name}${code}`);
  return jsonError('custom_code_failed', `The custom code could not be ${what === 'write' ? 'saved' : 'read'}. Nothing was changed; try again in a moment.`, 500);
}

async function handleGET(req: Request, { params }: Ctx): Promise<Response> {
  if (!isCustomCodeAvailable(process.env.CUSTOM_CODE_AVAILABLE)) return unavailable();
  const { projectId } = await params;
  const auth = await authorizeDomainProject(req, projectId, 'viewSite');
  if (!auth.ok) return guardResponse(auth);
  const { id, workspaceId, tenantGroupId } = auth.project;

  const sha256 = new URL(req.url).searchParams.get('sha256');
  if (sha256 !== null) {
    if (!BOX_SHA256_PATTERN.test(sha256)) {
      return jsonError('bad_hash', 'A block is named by 64 lower case hex characters.', 400);
    }
    try {
      const blob = await readCustomCodeBlob({ siteId: id, workspaceId }, sha256);
      if (!blob) {
        return jsonError('blob_not_found', 'This site holds no code under that hash. It may belong to another site, or it was never saved.', 404);
      }
      return Response.json(blob, { headers: NO_STORE });
    } catch (err) {
      return failure('read', err);
    }
  }

  let canManage: boolean;
  try {
    canManage = await checkWorkspaceAccess(auth.userId, workspaceId, 'manageCustomCode');
  } catch (err) {
    if (err instanceof AuthzUnavailableError) return authzUnavailableResponse();
    throw err;
  }
  try {
    const status = await readCustomCodeStatus({ siteId: id, workspaceId, tenantGroupId });
    if (!status) return jsonError('forbidden', 'This project does not exist, or your account has no access to it.', 403);
    return Response.json(
      {
        enabled: status.enabled,
        branch: status.branch,
        canManage,
        serving: boxFrameSource({ CUSTOM_CODE_DISABLED: process.env.CUSTOM_CODE_DISABLED, SANDBOX_ORIGIN: process.env.SANDBOX_ORIGIN }) !== null,
        usedBytes: status.usedBytes,
        disabledByLumitra: status.disabledByLumitra,
        limits: {
          blockBytes: BOX_LIMITS.documentBytes,
          siteBytes: BOX_LIMITS.siteBytes,
          blocksPerPage: BOX_LIMITS.blocksPerPage,
          writesPerHour: CUSTOM_CODE_WRITES_PER_HOUR,
        },
      },
      { headers: NO_STORE },
    );
  } catch (err) {
    return failure('read', err);
  }
}

async function handlePOST(req: Request, { params }: Ctx): Promise<Response> {
  if (!isCustomCodeAvailable(process.env.CUSTOM_CODE_AVAILABLE)) return unavailable();
  const { projectId } = await params;
  // The project first with the read right, so a person who may see it but not write code is told why.
  const auth = await authorizeDomainProject(req, projectId, 'viewSite');
  if (!auth.ok) return guardResponse(auth);
  const { id, workspaceId, tenantGroupId } = auth.project;
  let allowed: boolean;
  try {
    allowed = await checkWorkspaceAccess(auth.userId, workspaceId, 'manageCustomCode');
  } catch (err) {
    if (err instanceof AuthzUnavailableError) return authzUnavailableResponse();
    throw err;
  }
  if (!allowed) {
    return jsonError('permission_denied', 'Only a workspace admin can save custom code. Ask an admin of this workspace to save it.', 403);
  }

  const text = await readBodyText(req, CUSTOM_CODE_REQUEST_MAX_BYTES);
  if (!text.ok) {
    return jsonError('too_large', `The request is larger than ${CUSTOM_CODE_REQUEST_MAX_BYTES / 1024} KB; a block holds at most ${BOX_LIMITS.documentBytes / 1024} KB of code and declaration.`, 413);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.text);
  } catch {
    return jsonError('bad_json', 'The request is not valid JSON.', 400);
  }
  const body = writeBodySchema.safeParse(raw);
  if (!body.success) {
    return jsonError('bad_body', 'The request needs pageId, nodeId, title, document and declaration, and nothing else besides replaces.', 400, { issues: body.error.issues });
  }
  const checked = checkCustomCodeInput(body.data);
  if (!checked.ok) return refusalResponse(checked.refusal);

  try {
    const result = await writeCustomCodeBlob({
      siteId: id,
      workspaceId,
      tenantGroupId,
      actor: auth.userId,
      pageId: body.data.pageId,
      nodeId: body.data.nodeId,
      code: checked.value,
      replaces: body.data.replaces,
    });
    if (!result.ok) {
      if ('notFound' in result) return jsonError('forbidden', 'This project does not exist, or your account has no access to it.', 403);
      return refusalResponse(result.refusal);
    }
    return Response.json({ sha256: result.sha256, created: result.created }, { status: result.created ? 201 : 200, headers: NO_STORE });
  } catch (err) {
    return failure('write', err);
  }
}

export const GET = withAuthAvailability(handleGET);
export const POST = withAuthAvailability(handlePOST);

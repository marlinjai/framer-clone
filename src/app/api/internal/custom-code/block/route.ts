// src/app/api/internal/custom-code/block/route.ts
//
// POST /api/internal/custom-code/block
//
// The operator's takedown of sandboxed custom code (plan docs/plans/2026-11-02-sandboxed-custom-code.md,
// "Abuse handling" steps 1 and 2, decisions D116 to D119). An operator runs it by hand (curl) after an abuse
// report; nothing calls it on a timer. The body names one action:
//
//   { "action": "block",        "sha256": "<64 hex>", "reason": "...", "by": "operator:abuse-report" }
//   { "action": "unblock",      "sha256": "<64 hex>", "reason": "..." }
//   { "action": "disable-site", "siteId": "<site id>", "reason": "..." }
//   { "action": "lift-site",    "siteId": "<site id>", "reason": "..." }
//
// `by` is the operator label of D34 (`operator`, the default, or `operator:<lower-case-words>`), never a
// person's id; `reason` is at most 500 characters and must name no person (the takedown list outlives a
// company erasure). A blocked hash answers 410 from the box within six minutes on every site and cannot be
// written again; a disabled site shows every block's fallback at its next request and its editors read the
// reason in the custom code panel. Lifting a site's disable leaves its switch off; the site's admin may switch it on
// again through the enable step (slice C7), which refuses while an operator's disable stands.
//
//   - not the editor host             -> 404
//   - token not configured            -> 503 custom_code_operator_not_configured, nothing changed
//   - missing or wrong token          -> 401, nothing changed
//   - malformed body                  -> 400 bad_json / bad_body / bad_label
//   - a site action on no such site   -> 404 site_not_found
//   - a site action on a branch       -> 400 branch_site
//   - success                         -> 200 with what changed (sites by id, never code)
//   - a database failure              -> 500, the transaction rolled back
//
// Access: src/server/customCode/operatorAuth.ts (editor host, CUSTOM_CODE_OPERATOR_TOKEN).

import { z } from 'zod';
import { jsonError, parseBody } from '@/lib/api/respond';
import { BOX_SHA256_PATTERN } from '@/lib/customCode/contract';
import { checkCustomCodeOperatorRequest } from '@/server/customCode/operatorAuth';
import {
  OPERATOR_LABEL_MAX,
  OPERATOR_LABEL_PATTERN,
  TAKEDOWN_REASON_MAX,
  blockCustomCodeHash,
  disableCustomCodeForSite,
  liftCustomCodeDisable,
  unblockCustomCodeHash,
} from '@/server/customCode/takedown';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 4 * 1024;
const NO_STORE = { 'cache-control': 'no-store' };

const common = {
  reason: z.string().trim().min(1).max(TAKEDOWN_REASON_MAX),
  by: z.string().optional(),
};

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('block'), sha256: z.string().regex(BOX_SHA256_PATTERN), ...common }).strict(),
  z.object({ action: z.literal('unblock'), sha256: z.string().regex(BOX_SHA256_PATTERN), ...common }).strict(),
  z.object({ action: z.literal('disable-site'), siteId: z.string().min(1).max(64), ...common }).strict(),
  z.object({ action: z.literal('lift-site'), siteId: z.string().min(1).max(64), ...common }).strict(),
]);

export async function POST(req: Request): Promise<Response> {
  const denied = checkCustomCodeOperatorRequest(req);
  if (denied) return denied;

  const parsed = await parseBody(req, bodySchema, { maxBytes: MAX_BODY_BYTES });
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const label = body.by ?? 'operator';
  // Checked here so a wrong label is a 400 with the format, never the database CHECK as a 500 (D34).
  if (label.length > OPERATOR_LABEL_MAX || !OPERATOR_LABEL_PATTERN.test(label)) {
    return jsonError('bad_label', '`by` is `operator` or `operator:` followed by lower case words joined by hyphens, at most 64 characters, and never a person\'s name or id', 400);
  }
  const actor = { label, reason: body.reason };

  try {
    if (body.action === 'disable-site' || body.action === 'lift-site') {
      const result = body.action === 'disable-site'
        ? await disableCustomCodeForSite(body.siteId, actor)
        : await liftCustomCodeDisable(body.siteId, actor);
      if (!result.ok && result.reason === 'not_found') return jsonError('site_not_found', 'no site has this id', 404);
      if (!result.ok) return jsonError('branch_site', 'this id is a site branch, whose blocks follow its main site; use the main site\'s id instead', 400);
      console.error(`[custom code] takedown: ${body.action} ${result.siteId} by ${label}`);
      const answer = 'wasEnabled' in result ? { wasEnabled: result.wasEnabled } : { lifted: result.lifted };
      return Response.json({ action: body.action, siteId: result.siteId, ...answer }, { headers: NO_STORE });
    }
    const result = body.action === 'block'
      ? await blockCustomCodeHash(body.sha256, actor)
      : await unblockCustomCodeHash(body.sha256, actor);
    console.error(`[custom code] takedown: ${body.action} ${result.sha256} by ${label}, list ${result.listChanged ? 'changed' : 'unchanged'}, ${result.sites.length} site row(s)`);
    return Response.json({ action: body.action, sha256: result.sha256, listChanged: result.listChanged, sites: result.sites }, { headers: NO_STORE });
  } catch (err) {
    console.error(`[custom code] takedown ${body.action} failed:`, err);
    return jsonError('takedown_failed', 'the takedown failed and nothing was changed; try again', 500);
  }
}

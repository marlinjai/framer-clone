import 'server-only';

// src/server/commerce/mail/ownerHandlers.ts
//
// What the payments page's "Receipt email" card asks (docs/plans/2026-10-27-shop-receipt-email.md, decision 2),
// behind the company owner guard (companyOwnerRoute):
//
//   GET    /api/payments/mail          the connection, and the person's workspaces of this company
//   GET    /api/payments/mail/senders  the sending accounts of one of those workspaces (?workspace=)
//   POST   /api/payments/mail          connect { workspaceId, providerId, attempt }
//   DELETE /api/payments/mail          disconnect ({ keyRevoked: false } when the person may not revoke the key)
//
// Lumitra Mail's answers become stable codes: 503 mail_not_configured (this platform has no Lumitra Mail
// connection), 503 mail_unavailable (unreachable or failing; try again), 403/404/409 with the reason when it
// refuses, 400 for a request that is not one.

import { z } from 'zod';

import { jsonError } from '@/lib/api/respond';
import type { CompanyOwnerContext } from '../companyOwnerRoute';
import { shopMailConfig } from './config';
import { ConnectRefused, connectShopMail, disconnectShopMail, readConnection, shopSenders, shopWorkspaces } from './connection';
import { MailRefused, MailRetryLater, type LumitraMail } from './lumitraMail';

export interface MailOwnerDeps {
  mail: LumitraMail | null;
  sealKey: Buffer | null;
  now?: () => Date;
}

const connectBody = z.object({
  workspaceId: z.string().uuid(),
  providerId: z.string().uuid(),
  attempt: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
});

/** A thrown Lumitra Mail or connect failure as the page reads it; anything else propagates (a logged 500). */
function failure(err: unknown): Response {
  if (err instanceof ConnectRefused) {
    const status = err.code === 'workspace_of_another_company' || err.code === 'role_too_low' ? 403 : 404;
    return jsonError(err.code, err.message, status);
  }
  if (err instanceof MailRetryLater) {
    console.error('[shop-mail] Lumitra Mail did not answer:', err.message);
    return jsonError('mail_unavailable', 'Lumitra Mail cannot be reached right now: try again in a minute.', 503);
  }
  if (err instanceof MailRefused) {
    console.error('[shop-mail] Lumitra Mail refused:', err.message);
    const status = err.reason === 'not_a_member' || err.reason === 'role_too_low' ? 403 : err.reason === 'not_found' ? 404 : 409;
    return jsonError(`mail_${err.reason}`, err.message, status);
  }
  throw err;
}

function configured(deps: MailOwnerDeps): { mail: LumitraMail; sealKey: Buffer } | null {
  return deps.mail && deps.sealKey ? { mail: deps.mail, sealKey: deps.sealKey } : null;
}

const NOT_CONFIGURED = () => jsonError('mail_not_configured', 'Receipt emails through Lumitra Mail are not set up on this platform yet.', 503);

export async function mailStatus(ctx: CompanyOwnerContext, deps: MailOwnerDeps): Promise<Response> {
  const now = (deps.now ?? (() => new Date()))();
  const connection = await readConnection(ctx.db, ctx.companyId, now);
  const ready = configured(deps);
  if (!ready) return Response.json({ configured: false, connection, workspaces: [], otherCompanies: 0 });
  try {
    const { workspaces, otherCompanies } = await shopWorkspaces(ready.mail, ctx.subject, ctx.companyId);
    return Response.json({
      configured: true,
      connection,
      workspaces: workspaces.map((ws) => ({ id: ws.id, name: ws.name, role: ws.role })),
      otherCompanies,
    });
  } catch (err) {
    // The connection is still shown when Lumitra Mail cannot list workspaces right now.
    if (err instanceof MailRetryLater || err instanceof MailRefused) {
      return Response.json({ configured: true, connection, workspaces: [], otherCompanies: 0, workspacesError: failureCode(err) });
    }
    throw err;
  }
}

function failureCode(err: MailRetryLater | MailRefused): string {
  return err instanceof MailRetryLater ? 'mail_unavailable' : `mail_${err.reason}`;
}

export async function mailSenders(ctx: CompanyOwnerContext, deps: MailOwnerDeps, req: Request): Promise<Response> {
  const ready = configured(deps);
  if (!ready) return NOT_CONFIGURED();
  const workspaceId = new URL(req.url).searchParams.get('workspace') ?? '';
  if (!z.string().uuid().safeParse(workspaceId).success) return jsonError('invalid_request', 'name a workspace', 400);
  try {
    return Response.json({ senders: await shopSenders(ready.mail, ctx.subject, ctx.companyId, workspaceId) });
  } catch (err) {
    return failure(err);
  }
}

export async function mailConnect(ctx: CompanyOwnerContext, deps: MailOwnerDeps, req: Request): Promise<Response> {
  const ready = configured(deps);
  if (!ready) return NOT_CONFIGURED();
  const parsed = connectBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError('invalid_request', 'choose a workspace and a sending account', 400);
  const now = (deps.now ?? (() => new Date()))();
  try {
    const connection = await connectShopMail(ctx.db, ready.mail, ready.sealKey, { subject: ctx.subject, companyId: ctx.companyId, ...parsed.data, now });
    return Response.json({ connection });
  } catch (err) {
    return failure(err);
  }
}

export async function mailDisconnect(ctx: CompanyOwnerContext, deps: MailOwnerDeps): Promise<Response> {
  const ready = configured(deps);
  if (!ready) return NOT_CONFIGURED();
  try {
    const { keyRevoked } = await disconnectShopMail(ctx.db, ready.mail, ctx.subject, ctx.companyId);
    return Response.json({ connection: null, keyRevoked });
  } catch (err) {
    return failure(err);
  }
}

/** The platform's dependencies for these routes. */
export function platformMailOwnerDeps(mail: LumitraMail | null): MailOwnerDeps {
  return { mail, sealKey: shopMailConfig()?.sealKey ?? null };
}

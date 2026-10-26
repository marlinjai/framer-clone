import 'server-only';

// src/server/commerce/mail/connection.ts
//
// Connecting a shop to its company's Lumitra Mail workspace, and taking it back (the payments page, "Receipt
// email"; docs/plans/2026-10-27-shop-receipt-email.md, decision 2). Everything here acts for the signed-in
// owner: Lumitra Mail checks that person's membership and role on each call.
//
//   - Only a workspace of the shop's own company may be chosen (its `company_id` equals the shop's): nothing
//     else would stop shop A from sending as company B.
//   - Connecting adds the two languages the mails are written in when missing, creates the shop's `send` key
//     (the attempt id makes a repeated press mint no second key), installs the templates with it and stores the
//     key sealed. When installing fails, the new key is revoked again. A shop connected before has its old
//     key revoked once the new one works.
//   - Disconnecting revokes the key first and forgets the connection only then, so no working key is left
//     behind; a key already gone counts as revoked.

import type { Kysely } from 'kysely';

import { toJsonb } from '@/server/books/snapshots';
import type { CommerceDB } from '../db-types';
import { MailRefused, type LumitraMail, type MailSender, type MailWorkspace } from './lumitraMail';
import { seal } from './seal';
import { templatesVersion } from './templates';

/** The roles that may create and revoke a key in Lumitra Mail. */
const ADMIN_ROLES = new Set(['owner', 'admin']);

export interface MailConnectionView {
  workspaceId: string;
  workspaceName: string;
  sender: string;
  connectedAt: string;
  /** Letters of the last 30 days that could not be sent, with the latest reason. */
  failed: { count: number; latestReason: string | null };
}

export class ConnectRefused extends Error {
  constructor(
    readonly code: 'workspace_not_found' | 'workspace_of_another_company' | 'role_too_low' | 'sender_not_found',
    message: string,
  ) {
    super(message);
    this.name = 'ConnectRefused';
  }
}

/** Whether the company sends its buyers the receipt email (it is connected to Lumitra Mail). */
export async function hasShopMail(db: Kysely<CommerceDB>, tenantId: string): Promise<boolean> {
  return (await db.selectFrom('shop_mail_connection').select('tenant_id').where('tenant_id', '=', tenantId).executeTakeFirst()) !== undefined;
}

export async function readConnection(db: Kysely<CommerceDB>, tenantId: string, now: Date): Promise<MailConnectionView | null> {
  const row = await db.selectFrom('shop_mail_connection').selectAll().where('tenant_id', '=', tenantId).executeTakeFirst();
  if (!row) return null;
  const since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const failed = await db
    .selectFrom('shop_mail')
    .select(['last_error', 'updated_at'])
    .where('tenant_id', '=', tenantId)
    .where('status', '=', 'failed')
    .where('updated_at', '>=', since)
    .orderBy('updated_at', 'desc')
    .execute();
  return {
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    sender: row.sender,
    connectedAt: new Date(row.updated_at).toISOString(),
    failed: { count: failed.length, latestReason: failed[0]?.last_error ?? null },
  };
}

/** The person's workspaces that belong to the shop's company, and how many others they have. */
export async function shopWorkspaces(
  mail: LumitraMail,
  subject: string,
  companyId: string,
): Promise<{ workspaces: MailWorkspace[]; otherCompanies: number }> {
  const all = await mail.workspaces(subject);
  const own = all.filter((ws) => ws.companyId === companyId);
  return { workspaces: own, otherCompanies: all.length - own.length };
}

async function ownWorkspace(mail: LumitraMail, subject: string, companyId: string, workspaceId: string): Promise<MailWorkspace> {
  const workspace = (await mail.workspaces(subject)).find((ws) => ws.id === workspaceId);
  if (!workspace) throw new ConnectRefused('workspace_not_found', 'You are not a member of that mail workspace.');
  if (workspace.companyId !== companyId) {
    throw new ConnectRefused('workspace_of_another_company', 'That mail workspace belongs to another company: choose one of this company.');
  }
  if (!ADMIN_ROLES.has(workspace.role)) {
    throw new ConnectRefused('role_too_low', `Connecting needs an owner or admin of the mail workspace; you are ${workspace.role} there.`);
  }
  return workspace;
}

export async function shopSenders(
  mail: LumitraMail,
  subject: string,
  companyId: string,
  workspaceId: string,
): Promise<MailSender[]> {
  const workspace = (await mail.workspaces(subject)).find((ws) => ws.id === workspaceId);
  if (!workspace || workspace.companyId !== companyId) {
    throw new ConnectRefused('workspace_not_found', 'That mail workspace is not one of this company.');
  }
  return mail.senders(subject, workspaceId);
}

export async function connectShopMail(
  db: Kysely<CommerceDB>,
  mail: LumitraMail,
  sealKey: Buffer,
  args: { subject: string; companyId: string; workspaceId: string; providerId: string; attempt: string; now: Date },
): Promise<MailConnectionView> {
  const workspace = await ownWorkspace(mail, args.subject, args.companyId, args.workspaceId);
  const sender = (await mail.senders(args.subject, workspace.id)).find((s) => s.id === args.providerId);
  if (!sender) throw new ConnectRefused('sender_not_found', 'That sending account is not in the mail workspace.');
  await mail.ensureLanguages(args.subject, workspace);
  const key = await mail.createKey(args.subject, workspace.id, args.attempt);
  let templateIds: Record<string, string>;
  try {
    templateIds = await mail.installTemplates(key.key);
  } catch (err) {
    await mail.revokeKey(args.subject, workspace.id, key.id).catch((revokeErr: unknown) => {
      console.error(`[shop-mail] the key of a failed connect could not be revoked (workspace ${workspace.id}):`, revokeErr);
    });
    throw err;
  }

  const previous = await db.selectFrom('shop_mail_connection').selectAll().where('tenant_id', '=', args.companyId).executeTakeFirst();
  const values = {
    workspace_id: workspace.id,
    workspace_name: workspace.name,
    provider_id: sender.id,
    sender: sender.label,
    api_key_id: key.id,
    api_key_sealed: seal(sealKey, key.key),
    template_ids: toJsonb(templateIds),
    templates_version: templatesVersion(),
    connected_by: args.subject,
    updated_at: args.now,
  };
  await db
    .insertInto('shop_mail_connection')
    .values({ tenant_id: args.companyId, ...values })
    .onConflict((oc) => oc.column('tenant_id').doUpdateSet(values))
    .execute();
  // The new key works: the old one (a reconnect) is taken back.
  if (previous && previous.api_key_id !== key.id) {
    await mail.revokeKey(args.subject, previous.workspace_id, previous.api_key_id).catch((err: unknown) => {
      if (err instanceof MailRefused && (err.reason === 'not_found' || err.reason === 'key_revoked')) return;
      console.error(`[shop-mail] the previous key of company ${args.companyId} could not be revoked:`, err);
    });
  }
  return (await readConnection(db, args.companyId, args.now))!;
}

export async function disconnectShopMail(db: Kysely<CommerceDB>, mail: LumitraMail, subject: string, companyId: string): Promise<void> {
  const row = await db.selectFrom('shop_mail_connection').selectAll().where('tenant_id', '=', companyId).executeTakeFirst();
  if (!row) return;
  try {
    await mail.revokeKey(subject, row.workspace_id, row.api_key_id);
  } catch (err) {
    // Already gone at Lumitra Mail: nothing is left to take back.
    if (!(err instanceof MailRefused && (err.reason === 'not_found' || err.reason === 'key_revoked'))) throw err;
  }
  await db.deleteFrom('shop_mail_connection').where('tenant_id', '=', companyId).execute();
}

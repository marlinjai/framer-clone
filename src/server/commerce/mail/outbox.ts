import 'server-only';

// src/server/commerce/mail/outbox.ts
//
// The shop's mail outbox (docs/plans/2026-10-27-shop-receipt-email.md, decision 4; table `shop_mail`, migration
// 023). A row is written when a paid order's receipt is issued (`order_confirmation`) or a late payment is
// refunded (`late_refund`), only while the company is connected to Lumitra Mail. It is sent right after, and
// the sweep (every minute) sends what is due again:
//
//   sent      Lumitra Mail took the letter (its mailing id kept)
//   blocked   the address is blocked for transactional mail there (bounce, complaint, by hand): never retried
//   failed    Lumitra Mail kept refusing, or the attempts ran out; the reason is kept and shown to the owner
//   pending   waiting for its next attempt: after 1, 5, 15 and 60 minutes, then every 6 hours, for 3 days
//
// Sending never throws into its caller (a payment stands whatever the mail does); every failure is recorded on
// the row and logged without personal data or secrets.

import type { Kysely } from 'kysely';

import type { CommerceDB } from '../db-types';
import { readBuyer } from '../payment/buyer';
import type { LumitraMail } from './lumitraMail';
import { MailRefused, MailRetryLater } from './lumitraMail';
import { receiptToken } from './receiptLink';
import { unseal } from './seal';
import type { ShopMailKind, ShopMailLocale } from './templates';

/** Minutes to wait after the n-th failed attempt (1-based); past the list, every 6 hours. */
const BACKOFF_MINUTES = [1, 5, 15, 60];
const LATER_MINUTES = 6 * 60;
/** How long a letter is tried for before it is left `failed`. */
const GIVE_UP_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

export interface SiteInfo {
  name: string;
  /** The published site's language: the letter's, `de` unless the site writes English. */
  language: string;
}

export interface OutboxDeps {
  db: Kysely<CommerceDB>;
  tenantGroupId: string;
  /** Null while the platform has no Lumitra Mail connection configured: nothing is sent, rows stay pending. */
  mail: LumitraMail | null;
  sealKey: Buffer | null;
  linkKey: Buffer | null;
  linkBase: string;
  siteInfo: (siteId: string) => Promise<SiteInfo | null>;
  now?: () => Date;
}

export function nextAttemptDelayMs(failedAttempts: number): number {
  const minutes = BACKOFF_MINUTES[failedAttempts - 1] ?? LATER_MINUTES;
  return minutes * 60 * 1000;
}

/**
 * Write the letter for an order, when the company is connected (once per order and kind). Answers whether a
 * letter is waiting now.
 */
export async function enqueueShopMail(
  db: Kysely<CommerceDB>,
  tenantId: string,
  orderId: string,
  kind: ShopMailKind,
  at: Date,
): Promise<boolean> {
  const connected = await db.selectFrom('shop_mail_connection').select('tenant_id').where('tenant_id', '=', tenantId).executeTakeFirst();
  if (!connected) return false;
  await db
    .insertInto('shop_mail')
    .values({ tenant_id: tenantId, order_id: orderId, kind, next_attempt_at: at, updated_at: at })
    .onConflict((oc) => oc.columns(['tenant_id', 'order_id', 'kind']).doNothing())
    .execute();
  return true;
}

function localeOf(language: string): ShopMailLocale {
  return language.toLowerCase().startsWith('en') ? 'en' : 'de';
}

function money(cents: number, currency: string, locale: ShopMailLocale): string {
  return new Intl.NumberFormat(locale === 'de' ? 'de-DE' : 'en-GB', { style: 'currency', currency }).format(cents / 100);
}

function day(at: Date, locale: ShopMailLocale): string {
  return new Intl.DateTimeFormat(locale === 'de' ? 'de-DE' : 'en-GB', { dateStyle: 'long', timeZone: 'Europe/Berlin' }).format(at);
}

/** What the letter says, read from the order, its payment and receipt, and the site. */
async function letterValues(deps: OutboxDeps, tenantId: string, orderId: string, kind: ShopMailKind) {
  const order = await deps.db
    .selectFrom('order')
    .innerJoin('order_payment', (join) =>
      join.onRef('order_payment.order_id', '=', 'order.id').onRef('order_payment.tenant_id', '=', 'order.tenant_id'),
    )
    .leftJoin('sales_document', (join) =>
      join
        .onRef('sales_document.id', '=', 'order_payment.receipt_document_id')
        .onRef('sales_document.tenant_id', '=', 'order_payment.tenant_id'),
    )
    .select([
      'order.order_number as orderNumber',
      'order.total as total',
      'order.currency_code as currency',
      'order.created_at as createdAt',
      'order.site_id as siteId',
      'order_payment.buyer as buyer',
      'order_payment.receipt_document_id as receiptId',
      'sales_document.document_number as receiptNumber',
    ])
    .where('order.tenant_id', '=', tenantId)
    .where('order.id', '=', orderId)
    .executeTakeFirst();
  if (!order) throw new MailRefused('other', `order ${orderId} has no payment`);
  const buyer = readBuyer(order.buyer as Record<string, unknown>);
  if (!buyer) throw new MailRefused('recipient_refused', `order ${orderId} has no buyer to write to`);
  const site = order.siteId ? await deps.siteInfo(order.siteId) : null;
  const locale = localeOf(site?.language ?? 'de');
  const firstName = buyer.kind === 'organization' ? '' : buyer.name.trim().split(/\s+/)[0] ?? '';
  const merge: Record<string, string> = {
    shop_name: site?.name || 'Shop',
    order_number: order.orderNumber,
    total_text: money(order.total, order.currency, locale),
    ...(firstName ? { first_name: firstName } : {}),
  };
  if (kind === 'order_confirmation') {
    if (!order.receiptId || !order.receiptNumber) throw new MailRetryLater(`order ${orderId} has no issued receipt yet`);
    if (!deps.linkKey) throw new MailRetryLater('RECEIPT_LINK_KEY is not configured');
    const token = receiptToken(deps.linkKey, { tenantGroupId: deps.tenantGroupId, tenantId, documentId: order.receiptId });
    merge.order_date_text = day(new Date(order.createdAt), locale);
    merge.receipt_number = order.receiptNumber;
    merge.receipt_url = `${deps.linkBase}/api/receipts/${token}`;
  }
  return { to: buyer.email, locale, merge };
}

/** One attempt at one letter. Never throws: the outcome is written on its row. Answers the row's new status. */
export async function deliverShopMail(
  deps: OutboxDeps,
  tenantId: string,
  orderId: string,
  kind: ShopMailKind,
): Promise<'sent' | 'blocked' | 'failed' | 'pending' | 'none'> {
  const now = (deps.now ?? (() => new Date()))();
  const row = await deps.db
    .selectFrom('shop_mail')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('order_id', '=', orderId)
    .where('kind', '=', kind)
    .executeTakeFirst();
  if (!row) return 'none';
  if (row.status !== 'pending') return row.status;

  const record = async (status: 'sent' | 'blocked' | 'failed' | 'pending', fields: { last_error?: string | null; mailing_id?: string | null }) => {
    const attempts = row.attempts + 1;
    await deps.db
      .updateTable('shop_mail')
      .set({
        status,
        attempts,
        next_attempt_at: status === 'pending' ? new Date(now.getTime() + nextAttemptDelayMs(attempts)) : now,
        updated_at: now,
        ...('last_error' in fields ? { last_error: fields.last_error?.slice(0, 1000) ?? null } : {}),
        ...('mailing_id' in fields ? { mailing_id: fields.mailing_id ?? null } : {}),
      })
      .where('tenant_id', '=', tenantId)
      .where('order_id', '=', orderId)
      .where('kind', '=', kind)
      .where('status', '=', 'pending')
      .execute();
    return status;
  };

  try {
    if (!deps.mail || !deps.sealKey) throw new MailRetryLater('Lumitra Mail is not configured on this platform');
    const connection = await deps.db.selectFrom('shop_mail_connection').selectAll().where('tenant_id', '=', tenantId).executeTakeFirst();
    if (!connection) throw new MailRefused('other', 'the shop is no longer connected to Lumitra Mail');
    const templateId = (connection.template_ids as Record<string, string>)[kind];
    if (!templateId) throw new MailRefused('template_missing', `no ${kind} template is installed: connect the shop again`);
    const values = await letterValues(deps, tenantId, orderId, kind);
    const sent = await deps.mail.send(unseal(deps.sealKey, connection.api_key_sealed), {
      key: `shop:${tenantId}:${orderId}:${kind}`,
      kind,
      locale: values.locale,
      templateId,
      providerId: connection.provider_id,
      to: values.to,
      merge: values.merge,
    });
    return await record(sent.delivery, { mailing_id: sent.mailingId, last_error: null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[shop-mail] ${kind} of order ${orderId} (company ${tenantId}): ${message}`);
    const givingUp = now.getTime() - new Date(row.created_at).getTime() >= GIVE_UP_AFTER_MS;
    if (err instanceof MailRefused || givingUp) return record('failed', { last_error: message });
    return record('pending', { last_error: message });
  }
}

/** Send every letter of the tenant group that is due. Answers how many were attempted. */
export async function sweepShopMail(deps: OutboxDeps, limit = 50): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const due = await deps.db
    .selectFrom('shop_mail')
    .select(['tenant_id', 'order_id', 'kind'])
    .where('status', '=', 'pending')
    .where('next_attempt_at', '<=', now)
    .orderBy('next_attempt_at')
    .limit(limit)
    .execute();
  for (const row of due) await deliverShopMail(deps, row.tenant_id, row.order_id, row.kind);
  return due.length;
}

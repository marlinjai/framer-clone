import 'server-only';

// src/server/commerce/mail/outbox.ts
//
// The shop's mail outbox (docs/plans/2026-10-27-shop-receipt-email.md, decision 4; table `shop_mail`, migration
// 023), driven by the job engine since slice B5 of docs/plans/2026-11-02-shop-backbone.md. A row and its `shop_mail`
// job are written together, in the transaction of the change that needs the letter, when a paid order's receipt is
// issued (`order_confirmation`, event `receipt.issued`) or a late payment is refunded (`late_refund`, event
// `payment.refunded`), only while the company is connected to Lumitra Mail. The job owns the schedule; the row keeps
// what is about the letter:
//
//   sent      Lumitra Mail took the letter (its mailing id kept); the job is done
//   blocked   the address is blocked for transactional mail there (bounce, complaint, by hand): the job is done,
//             nothing a person can change here
//   failed    Lumitra Mail kept refusing, or three days of failures; the reason is kept and shown to the owner, and
//             the job is dead
//   pending   waiting for its next attempt (the job's backoff: 1, 5, 15 and 60 minutes, then every 6 hours)
//
// The letter is built once, at its first attempt, and kept on the row: every retry sends exactly it, under the
// same idempotency keys, because Lumitra Mail refuses a key repeated with another body (a site renamed or a
// language switched between two attempts would otherwise end the letter as failed). A letter is tied to the
// workspace it was made for: after a reconnect to another workspace it is built again there, under keys of that
// workspace.
//
// `attempts`, `next_attempt_at` and the old build's sweep are gone from here: the old build's rows are given a job by
// the mail backfill (jobs/backfills.ts), and B9 drops the columns.

import type { Kysely, Transaction } from 'kysely';

import { toJsonb } from '@/server/books/snapshots';
import { scheduleJob } from '../jobs/schedule';
import { JobRefused, JobRetryLater } from '../jobs/types';
import type { CommerceDB } from '../db-types';
import { readBuyer } from '../payment/buyer';
import type { LumitraMail } from './lumitraMail';
import { MailRefused, MailRetryLater } from './lumitraMail';
import { receiptToken } from './receiptLink';
import { unseal } from './seal';
import type { ShopMailKind, ShopMailLocale } from './templates';

export const SHOP_MAIL_JOB_KIND = 'shop_mail';
/** The job's dedupe key: one per order and kind of letter, whatever the number of attempts. */
export const shopMailJobKey = (orderId: string, kind: ShopMailKind) => `mail:${orderId}:${kind}`;
/** How long a letter is tried for before it is left `failed`. */
export const GIVE_UP_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

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

/**
 * Write the letter row and its job for an order, in the caller's transaction, when the company is connected (once per
 * order and kind). Answers the job's id, or null when nothing was written (not connected, or already written).
 */
export async function enqueueShopMail(
  trx: Transaction<CommerceDB>,
  tenantId: string,
  orderId: string,
  kind: ShopMailKind,
  at: Date,
): Promise<string | null> {
  const connected = await trx.selectFrom('shop_mail_connection').select('tenant_id').where('tenant_id', '=', tenantId).executeTakeFirst();
  if (!connected) return null;
  await trx
    .insertInto('shop_mail')
    .values({ tenant_id: tenantId, order_id: orderId, kind, next_attempt_at: at, updated_at: at })
    .onConflict((oc) => oc.columns(['tenant_id', 'order_id', 'kind']).doNothing())
    .execute();
  return scheduleJob(trx, {
    tenantId,
    kind: SHOP_MAIL_JOB_KIND,
    dedupeKey: shopMailJobKey(orderId, kind),
    eventType: kind === 'order_confirmation' ? 'receipt.issued' : 'payment.refunded',
    payload: { orderId, kind },
    runAt: at,
    at,
  });
}

/** A letter as built at its first attempt. */
export interface FrozenLetter {
  workspaceId: string;
  to: string;
  locale: ShopMailLocale;
  templateId: string;
  providerId: string;
  merge: Record<string, string>;
}

function readFrozen(stored: Record<string, unknown> | null): FrozenLetter | null {
  if (!stored || typeof stored.workspaceId !== 'string' || typeof stored.to !== 'string') return null;
  return stored as unknown as FrozenLetter;
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

/**
 * One attempt at one letter, for the `shop_mail` job. Answers how the letter stands when nothing is left to do:
 * `sent`, `blocked`, or `none` (no row, or one already settled as failed). Anything else ends the attempt as a job
 * outcome: a refusal is written `failed` on the row and throws `JobRefused` (dead), and what may heal throws
 * `JobRetryLater` with the row still `pending`, until three days have passed, when it too is written `failed`.
 */
export async function deliverShopMail(
  deps: OutboxDeps,
  tenantId: string,
  orderId: string,
  kind: ShopMailKind,
): Promise<'sent' | 'blocked' | 'none'> {
  const now = (deps.now ?? (() => new Date()))();
  const row = await deps.db
    .selectFrom('shop_mail')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('order_id', '=', orderId)
    .where('kind', '=', kind)
    .executeTakeFirst();
  if (!row) return 'none';
  if (row.status === 'sent' || row.status === 'blocked') return row.status;
  // A letter the owner was told failed stays failed: its job is dead already.
  if (row.status === 'failed') return 'none';

  // Never writes over a settled row: two attempts at one letter (a job reclaimed after its lease, or the old build's
  // sweep during a deploy) end with whichever settled first.
  const record = async (
    status: 'sent' | 'blocked' | 'failed' | 'pending',
    fields: { last_error?: string | null; mailing_id?: string | null },
  ) => {
    await deps.db
      .updateTable('shop_mail')
      .set({
        status,
        updated_at: now,
        ...('last_error' in fields ? { last_error: fields.last_error?.slice(0, 1000) ?? null } : {}),
        ...('mailing_id' in fields ? { mailing_id: fields.mailing_id ?? null } : {}),
      })
      .where('tenant_id', '=', tenantId)
      .where('order_id', '=', orderId)
      .where('kind', '=', kind)
      .where('status', '=', 'pending')
      .execute();
  };

  try {
    if (!deps.mail || !deps.sealKey) throw new MailRetryLater('Lumitra Mail is not configured on this platform');
    const connection = await deps.db.selectFrom('shop_mail_connection').selectAll().where('tenant_id', '=', tenantId).executeTakeFirst();
    if (!connection) throw new MailRefused('other', 'the shop is no longer connected to Lumitra Mail');
    let letter = readFrozen(row.letter);
    if (!letter || letter.workspaceId !== connection.workspace_id) {
      const templateId = (connection.template_ids as Record<string, string>)[kind];
      if (!templateId) throw new MailRefused('template_missing', `no ${kind} template is installed: connect the shop again`);
      const values = await letterValues(deps, tenantId, orderId, kind);
      letter = { workspaceId: connection.workspace_id, to: values.to, locale: values.locale, templateId, providerId: connection.provider_id, merge: values.merge };
      await deps.db
        .updateTable('shop_mail')
        .set({ letter: toJsonb(letter), updated_at: now })
        .where('tenant_id', '=', tenantId)
        .where('order_id', '=', orderId)
        .where('kind', '=', kind)
        .where('status', '=', 'pending')
        .execute();
    }
    const sent = await deps.mail.send(unseal(deps.sealKey, connection.api_key_sealed), {
      key: `shop:${tenantId}:${orderId}:${kind}:${letter.workspaceId}`,
      kind,
      locale: letter.locale,
      templateId: letter.templateId,
      providerId: letter.providerId,
      to: letter.to,
      merge: letter.merge,
    });
    await record(sent.delivery, { mailing_id: sent.mailingId, last_error: null });
    return sent.delivery;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[shop-mail] ${kind} of order ${orderId} (company ${tenantId}): ${message}`);
    if (err instanceof MailRefused) {
      await record('failed', { last_error: message });
      throw new JobRefused(err.reason);
    }
    if (now.getTime() - new Date(row.created_at).getTime() >= GIVE_UP_AFTER_MS) {
      await record('failed', { last_error: message });
      throw new JobRefused('gave_up');
    }
    await record('pending', { last_error: message });
    // MailRetryLater, and anything unexpected: the letter may still go out.
    throw new JobRetryLater(err instanceof MailRetryLater ? message.slice(0, 200) : 'mail_attempt_failed');
  }
}

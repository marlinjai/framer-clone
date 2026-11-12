import 'server-only';

// src/server/forms/notify.ts
//
// The email that tells a site owner about a new form submission (docs/plans/2026-10-23-published-site-essentials.md,
// "Form notification emails"; migration 031_form_notification). It is the second letter of the shop's Lumitra Mail
// pipeline (docs/plans/2026-10-27-shop-receipt-email.md): the company's own connection, sealed send key and
// templates, the same `form_mail` job engine, the same retry shape as the buyer's letters (mail/outbox.ts).
//
// Three entry points:
//   - `writeFormNotification`, in the transaction that stores the submission: a row, and a job when the company is
//     connected to Lumitra Mail and a recipient is known; otherwise the row is `skipped` and says why, so the
//     owner sees in the submissions view that no email was sent and why, never a silent gap;
//   - `deliverFormNotification`, one attempt for the job (a repeat is harmless: a settled row answers as it is and
//     Lumitra Mail's idempotency keys refuse a second send);
//   - `resendFormNotification`, the owner's "send again" for a failed or never-sent one.
//
// A failure never touches the submission: it is stored before any of this runs, and the notification is a row of
// its own. The visitor's words travel only inside the frozen `letter`, which is emptied as soon as the letter is
// settled, and the job payload carries the submission id and nothing else.

import { sql, type Kysely, type Transaction } from 'kysely';

import { toJsonb } from '@/server/books/snapshots';
import { scheduleJob } from '@/server/commerce/jobs/schedule';
import { JobRefused, JobRetryLater } from '@/server/commerce/jobs/types';
import type { CommerceDB } from '@/server/commerce/db-types';
import { GIVE_UP_AFTER_MS, type OutboxDeps } from '@/server/commerce/mail/outbox';
import { FORM_MAIL_KIND, templatesVersion, type ShopMailLocale } from '@/server/commerce/mail/templates';
import { MailRefused, MailRetryLater } from '@/server/commerce/mail/lumitraMail';
import { unseal } from '@/server/commerce/mail/seal';
import type { StoredField } from '@/lib/forms/validation';

export const FORM_MAIL_JOB_KIND = 'form_mail';
/** The job's dedupe key: one per submission and round (a "send again" starts the next round). */
export const formMailJobKey = (submissionId: string, round: number) => `formmail:${submissionId}:${round}`;

/** Why a notification was never sent, kept in `last_error` of a `skipped` row. */
export const SKIPPED_NOT_CONNECTED = 'not_connected';
export const SKIPPED_NO_RECIPIENT = 'no_recipient';
export const SKIPPED_NO_COMPANY = 'no_company';

export interface NewFormNotification {
  /** The company the site belongs to: the connection's key and the job's tenant. Null: the site is not linked to one. */
  companyId: string | null;
  /** The address decided from the published form, or null when neither it nor the site names one. */
  recipient: string | null;
  at: Date;
}

/**
 * Write the notification row, and its job when it can be sent, in the submission's transaction. Call only after the
 * submission row was actually inserted (a repeated post of the same submission id must not write a second one).
 */
export async function writeFormNotification(
  trx: Transaction<CommerceDB>,
  tenantGroupId: string,
  submissionId: string,
  notification: NewFormNotification,
): Promise<'pending' | 'skipped'> {
  const { recipient, at } = notification;
  // No company: no connection can exist, so nothing is sent, but the owner still sees why (the empty company id marks it).
  const companyId = notification.companyId ?? '';
  const connected = recipient && companyId
    ? await trx.selectFrom('shop_mail_connection').select('tenant_id').where('tenant_id', '=', companyId).executeTakeFirst()
    : undefined;
  const status = recipient && connected ? 'pending' : 'skipped';
  const skippedWhy = !companyId ? SKIPPED_NO_COMPANY : recipient ? SKIPPED_NOT_CONNECTED : SKIPPED_NO_RECIPIENT;
  await trx
    .insertInto('form_notification')
    .values({
      submission_id: submissionId,
      tenant_id: tenantGroupId,
      company_id: companyId,
      recipient,
      status,
      last_error: status === 'skipped' ? skippedWhy : null,
      round_started_at: at,
      updated_at: at,
    })
    .onConflict((oc) => oc.column('submission_id').doNothing())
    .execute();
  if (status === 'pending') await scheduleFormMail(trx, companyId, submissionId, 1, at);
  return status;
}

function scheduleFormMail(trx: Transaction<CommerceDB>, companyId: string, submissionId: string, round: number, at: Date) {
  return scheduleJob(trx, {
    tenantId: companyId,
    kind: FORM_MAIL_JOB_KIND,
    dedupeKey: formMailJobKey(submissionId, round),
    payload: { submissionId },
    runAt: at,
    at,
  });
}

// ---------- the letter ----------

const VALUE_CHARS = 300;
const SUMMARY_CHARS = 1800;

/** "label: value" per field, one line of text (a merge value is one scalar), shortened. Yes and no for a checkbox. */
export function summaryText(fields: readonly StoredField[], locale: ShopMailLocale): string {
  const yes = locale === 'de' ? 'ja' : 'yes';
  const no = locale === 'de' ? 'nein' : 'no';
  const parts = fields.map((field) => {
    const raw = typeof field.value === 'boolean' ? (field.value ? yes : no) : field.value;
    const value = raw.replace(/\s+/g, ' ').trim();
    const shown = value.length > VALUE_CHARS ? `${value.slice(0, VALUE_CHARS - 1)}…` : value;
    return `${field.label.replace(/\s+/g, ' ').trim()}: ${shown}`;
  });
  const whole = parts.join(' | ');
  return whole.length > SUMMARY_CHARS ? `${whole.slice(0, SUMMARY_CHARS - 1)}…` : whole;
}

interface FrozenFormLetter {
  workspaceId: string;
  to: string;
  locale: ShopMailLocale;
  templateId: string;
  providerId: string;
  merge: Record<string, string>;
}

function readFrozen(stored: Record<string, unknown> | null): FrozenFormLetter | null {
  if (!stored || typeof stored.workspaceId !== 'string' || typeof stored.to !== 'string') return null;
  return stored as unknown as FrozenFormLetter;
}

const localeOfLanguage = (language: string): ShopMailLocale => (language.toLowerCase().startsWith('en') ? 'en' : 'de');

function received(at: Date, locale: ShopMailLocale): string {
  return new Intl.DateTimeFormat(locale === 'de' ? 'de-DE' : 'en-GB', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Berlin' }).format(at);
}

function parseFields(raw: unknown): StoredField[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (f): f is StoredField => !!f && typeof f === 'object' && typeof (f as StoredField).label === 'string' && ['string', 'boolean'].includes(typeof (f as StoredField).value),
  );
}

/**
 * One attempt at one notification, for the `form_mail` job. Answers `sent`, `blocked`, or `none` (no row, a deleted
 * submission, or one already settled as failed or skipped). A refusal is written `failed` on the row and throws
 * `JobRefused`; what may heal throws `JobRetryLater` with the row still `pending`, until three days have passed.
 *
 * The whole attempt, the call to Lumitra Mail included, runs in ONE transaction that holds the notification row's lock
 * (`FOR UPDATE`). That is the fence between an attempt and everything else that writes the row:
 *   - the owner's "send again" (`resendFormNotification`) waits for an in-flight send, then sees `sent` and refuses, or
 *     sees `failed` (this very attempt gave up) and starts the next round only after nothing can still land a letter of
 *     the old one: a late success of round 1 beside a round 2 cannot happen;
 *   - a second attempt at the same letter (a job reclaimed after its lease, two workers) waits and then finds it settled;
 *   - a worker that dies mid-send drops its connection, the lock goes with it, and the next attempt sends the SAME frozen
 *     letter under the SAME idempotency key, which Lumitra Mail replays instead of sending twice.
 * The failure outcomes are returned out of the transaction and thrown after it commits, so what the attempt wrote
 * (`failed`, `pending` with its error) is kept.
 */
export async function deliverFormNotification(
  deps: OutboxDeps,
  companyId: string,
  submissionId: string,
): Promise<'sent' | 'blocked' | 'none'> {
  const outcome = await deps.db.transaction().execute(async (trx): Promise<AttemptOutcome> => {
    try {
      // A lock another attempt holds for a send in flight is waited for, but not forever (the job's own deadline is 90 s).
      await sql`SET LOCAL lock_timeout = '60s'`.execute(trx);
      return await attemptUnderLock(deps, trx, companyId, submissionId);
    } catch (err) {
      if (isLockTimeout(err)) return { type: 'throw', error: new JobRetryLater('another attempt holds this notification') };
      throw err;
    }
  });
  if (outcome.type === 'throw') throw outcome.error;
  return outcome.result;
}

type AttemptOutcome = { type: 'done'; result: 'sent' | 'blocked' | 'none' } | { type: 'throw'; error: Error };

/** Postgres `lock_not_available` (55P03): `lock_timeout` ran out. */
export function isLockTimeout(err: unknown): boolean {
  const code = (err as { code?: unknown; cause?: { code?: unknown } } | null);
  return code?.code === '55P03' || code?.cause?.code === '55P03';
}

async function attemptUnderLock(
  deps: OutboxDeps,
  trx: Transaction<CommerceDB>,
  companyId: string,
  submissionId: string,
): Promise<AttemptOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  // The company comes from the job and is part of the key: a payload cannot reach another company's notification.
  const row = await trx
    .selectFrom('form_notification')
    .innerJoin('form_submission', 'form_submission.id', 'form_notification.submission_id')
    .select([
      'form_notification.status as status',
      'form_notification.round as round',
      'form_notification.round_started_at as roundStartedAt',
      'form_notification.recipient as recipient',
      'form_notification.letter as letter',
      'form_submission.site_id as siteId',
      'form_submission.page_path as pagePath',
      'form_submission.form_name as formName',
      'form_submission.fields as fields',
      'form_submission.created_at as submittedAt',
    ])
    .where('form_notification.submission_id', '=', submissionId)
    .where('form_notification.tenant_id', '=', deps.tenantGroupId)
    .where('form_notification.company_id', '=', companyId)
    .forUpdate('form_notification')
    .executeTakeFirst();
  if (!row) return { type: 'done', result: 'none' };
  if (row.status === 'sent' || row.status === 'blocked') return { type: 'done', result: row.status };
  if (row.status !== 'pending') return { type: 'done', result: 'none' };

  // Never writes over a settled row or a newer round: a job reclaimed after its lease, or an attempt of a round the owner
  // replaced by "send again", ends with whatever is already written.
  const record = async (
    status: 'sent' | 'blocked' | 'failed' | 'pending',
    fields: { last_error?: string | null; mailing_id?: string | null },
  ) => {
    await trx
      .updateTable('form_notification')
      .set({
        status,
        updated_at: now,
        ...(status === 'pending' ? {} : { letter: null }),
        ...('last_error' in fields ? { last_error: fields.last_error?.slice(0, 1000) ?? null } : {}),
        ...('mailing_id' in fields ? { mailing_id: fields.mailing_id ?? null } : {}),
      })
      .where('submission_id', '=', submissionId)
      .where('tenant_id', '=', deps.tenantGroupId)
      .where('company_id', '=', companyId)
      .where('round', '=', row.round)
      .where('status', '=', 'pending')
      .execute();
  };

  try {
    if (!deps.mail || !deps.sealKey) throw new MailRetryLater('Lumitra Mail is not configured on this platform');
    if (!row.recipient) throw new MailRefused('recipient_refused', 'the notification has no recipient');
    const connection = await trx.selectFrom('shop_mail_connection').selectAll().where('tenant_id', '=', companyId).executeTakeFirst();
    if (!connection) throw new MailRefused('other', 'the company is no longer connected to Lumitra Mail: connect it again, then send this again');
    const apiKey = unseal(deps.sealKey, connection.api_key_sealed);
    let letter = readFrozen(row.letter);
    if (!letter || letter.workspaceId !== connection.workspace_id) {
      // A connection made before this notice existed holds no template for it: install the templates with the
      // company's own send key (what connecting does), keep the ids, and go on.
      let templateIds = connection.template_ids as Record<string, string>;
      if (!templateIds[FORM_MAIL_KIND]) {
        templateIds = await deps.mail.installTemplates(apiKey);
        await trx
          .updateTable('shop_mail_connection')
          .set({ template_ids: toJsonb(templateIds), templates_version: templatesVersion(), updated_at: now })
          .where('tenant_id', '=', companyId)
          .execute();
      }
      const templateId = templateIds[FORM_MAIL_KIND];
      if (!templateId) throw new MailRefused('template_missing', 'no form notification template is installed: connect the company again');
      const site = await deps.siteInfo(row.siteId);
      const locale = localeOfLanguage(site?.language ?? 'de');
      const fields = parseFields(row.fields);
      letter = {
        workspaceId: connection.workspace_id,
        to: row.recipient,
        locale,
        templateId,
        providerId: connection.provider_id,
        merge: {
          site_name: site?.name || 'Site',
          form_name: row.formName,
          page_path: row.pagePath,
          received_text: received(new Date(row.submittedAt), locale),
          summary_text: summaryText(fields, locale),
          inbox_url: `${deps.linkBase}/projects/${row.siteId}`,
        },
      };
      await trx
        .updateTable('form_notification')
        .set({ letter: toJsonb(letter), updated_at: now })
        .where('submission_id', '=', submissionId)
        .where('tenant_id', '=', deps.tenantGroupId)
        .where('company_id', '=', companyId)
        .where('round', '=', row.round)
        .where('status', '=', 'pending')
        .execute();
    }
    const sent = await deps.mail.send(apiKey, {
      key: `form:${companyId}:${submissionId}:${row.round}:${letter.workspaceId}`,
      kind: FORM_MAIL_KIND,
      locale: letter.locale,
      templateId: letter.templateId,
      providerId: letter.providerId,
      to: letter.to,
      merge: letter.merge,
    });
    await record(sent.delivery, { mailing_id: sent.mailingId, last_error: null });
    return { type: 'done', result: sent.delivery };
  } catch (err) {
    // The message names no visitor data: Lumitra Mail's errors describe the call, never the letter.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[form-mail] submission ${submissionId} (company ${companyId}): ${message}`);
    if (err instanceof MailRefused) {
      await record('failed', { last_error: message });
      return { type: 'throw', error: new JobRefused(err.reason) };
    }
    if (now.getTime() - new Date(row.roundStartedAt).getTime() >= GIVE_UP_AFTER_MS) {
      await record('failed', { last_error: message });
      return { type: 'throw', error: new JobRefused('gave_up') };
    }
    await record('pending', { last_error: message });
    return { type: 'throw', error: new JobRetryLater(err instanceof MailRetryLater ? message.slice(0, 200) : 'mail_attempt_failed') };
  }
}

export type ResendResult = 'queued' | 'not_found' | 'not_resendable' | 'not_connected' | 'no_recipient' | 'busy';

/** How long "send again" waits for an attempt that is sending right now (see `deliverFormNotification`). */
export const RESEND_LOCK_WAIT_MS = 5_000;

/**
 * The owner's "send again": a notification that failed, was blocked, or was never sent (the company was not connected, or
 * no address was known) becomes pending in the next round with a new job and a new letter. The recipient is read AGAIN
 * from the live published form and site (`currentRecipient`, null when it names none), so an owner who fixed the address
 * in the form settings is not sent to the old one, and one who removed it is not sent to at all; only when the live site
 * cannot be read (null vs undefined, see below) does the frozen one stay. One site's rows only (the
 * caller's session decided the site), and only while the company is connected.
 */
export async function resendFormNotification(
  db: Kysely<CommerceDB>,
  ref: { tenantGroupId: string; siteId: string; submissionId: string },
  now: Date,
  currentRecipient: (formId: string) => Promise<string | null | undefined> = async () => undefined,
  options: { lockWaitMs?: number } = {},
): Promise<ResendResult> {
  const found = await db
    .selectFrom('form_notification')
    .innerJoin('form_submission', 'form_submission.id', 'form_notification.submission_id')
    .select(['form_submission.form_id as formId'])
    .where('form_notification.submission_id', '=', ref.submissionId)
    .where('form_notification.tenant_id', '=', ref.tenantGroupId)
    .where('form_submission.tenant_id', '=', ref.tenantGroupId)
    .where('form_submission.site_id', '=', ref.siteId)
    .executeTakeFirst();
  if (!found) return 'not_found';
  // Outside the transaction: it reads the published site, which can take a moment.
  // null: the live site names none (so none is sent, never the old address the owner removed); undefined: the live site
  // cannot be read (not published), so the address stored at submit time stays.
  const live = await currentRecipient(found.formId);

  return db.transaction().execute(async (trx): Promise<ResendResult> => {
    // The row's lock is held by an attempt while it sends: wait for it (it ends sent, or failed and then a new round is
    // safe), but only briefly; the owner is told to try again.
    const waitMs = Math.max(1, Math.trunc(options.lockWaitMs ?? RESEND_LOCK_WAIT_MS));
    await sql`SELECT set_config('lock_timeout', ${`${waitMs}ms`}, true)`.execute(trx);
    let row;
    try {
      row = await trx
        .selectFrom('form_notification')
        .select(['company_id as companyId', 'status', 'last_error as lastError', 'round', 'recipient'])
        .where('submission_id', '=', ref.submissionId)
        .where('tenant_id', '=', ref.tenantGroupId)
        .forUpdate()
        .executeTakeFirst();
    } catch (err) {
      if (isLockTimeout(err)) return 'busy';
      throw err;
    }
    if (!row) return 'not_found';
    const resendable =
      row.status === 'failed' ||
      row.status === 'blocked' ||
      (row.status === 'skipped' && (row.lastError === SKIPPED_NOT_CONNECTED || row.lastError === SKIPPED_NO_RECIPIENT));
    if (!resendable) return 'not_resendable';
    const recipient = live === undefined ? row.recipient : live;
    if (!recipient) return 'no_recipient';
    const connected = await trx.selectFrom('shop_mail_connection').select('tenant_id').where('tenant_id', '=', row.companyId).executeTakeFirst();
    if (!connected) return 'not_connected';
    const round = row.round + 1;
    await trx
      .updateTable('form_notification')
      .set({ status: 'pending', round, recipient, round_started_at: now, last_error: null, mailing_id: null, letter: null, updated_at: now })
      .where('submission_id', '=', ref.submissionId)
      .where('tenant_id', '=', ref.tenantGroupId)
      .execute();
    await scheduleFormMail(trx, row.companyId, ref.submissionId, round, now);
    return 'queued';
  });
}

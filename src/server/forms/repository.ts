import 'server-only';

// src/server/forms/repository.ts
//
// The form submissions of a site (migration 017_form_submissions). Every query
// runs on the SCOPED handle of one tenant group's schema (`commerceTenantDb`)
// and filters on the tenant group AND the site, so a row of another site in the
// same schema answers "not found", exactly like an unknown id.
//
// Deletes are real DELETEs. Three paths reach every row (house rule "deletion
// and erasure by design"):
//   - the owner deletes one submission in the submissions view
//     (`deleteFormSubmission`);
//   - deleting the project deletes its submissions (`deleteSiteSubmissions`,
//     called by DELETE /api/projects/<id> after the site row is gone);
//   - a company erasure deletes the company's rows by workspace
//     (`deleteWorkspaceSubmissions`), or with the whole `tg_<id>` schema.

import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import type { CommerceDB } from '@/server/commerce/db-types';
import { toJsonb } from '@/server/books/snapshots';
import type { StoredField } from '@/lib/forms/validation';
import { FIELD_TYPES } from '@/lib/forms/definition';

export interface NewFormSubmission {
  id: string;
  tenantId: string;
  workspaceId: string;
  siteId: string;
  pageId: string;
  pagePath: string;
  formId: string;
  formName: string;
  fields: StoredField[];
}

export interface FormSubmission {
  id: string;
  siteId: string;
  pageId: string;
  pagePath: string;
  formId: string;
  formName: string;
  fields: StoredField[];
  readAt: Date | null;
  createdAt: Date;
}

const storedFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(FIELD_TYPES),
  value: z.union([z.string(), z.boolean()]),
});

/** Parse the stored JSON; a row written by a different version keeps what parses. */
function parseFields(raw: unknown): StoredField[] {
  if (!Array.isArray(raw)) return [];
  const out: StoredField[] = [];
  for (const item of raw) {
    const parsed = storedFieldSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

type Row = {
  id: string;
  site_id: string;
  page_id: string;
  page_path: string;
  form_id: string;
  form_name: string;
  fields: unknown;
  read_at: Date | null;
  created_at: Date;
};

function toSubmission(row: Row): FormSubmission {
  return {
    id: row.id,
    siteId: row.site_id,
    pageId: row.page_id,
    pagePath: row.page_path,
    formId: row.form_id,
    formName: row.form_name,
    fields: parseFields(row.fields),
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

const COLUMNS = ['id', 'site_id', 'page_id', 'page_path', 'form_id', 'form_name', 'fields', 'read_at', 'created_at'] as const;

/**
 * Store one submission. Idempotent on the id: the island re-sends a lost
 * answer with the same id, which must not store the message twice. Returns
 * whether a row was written (false: it existed already).
 */
export async function insertFormSubmission(db: Kysely<CommerceDB>, row: NewFormSubmission): Promise<boolean> {
  const result = await db
    .insertInto('form_submission')
    .values({
      id: row.id,
      tenant_id: row.tenantId,
      workspace_id: row.workspaceId,
      site_id: row.siteId,
      page_id: row.pageId,
      page_path: row.pagePath,
      form_id: row.formId,
      form_name: row.formName,
      fields: toJsonb(row.fields),
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .executeTakeFirst();
  return Number(result.numInsertedOrUpdatedRows ?? 0) > 0;
}

export interface SiteRef {
  tenantId: string;
  siteId: string;
}

export interface ListOptions {
  formId?: string;
  /** Page size, 1 to 200 (default 50). */
  limit?: number;
  /** Continue after this row (the last row of the previous page). */
  before?: { createdAt: Date; id: string };
}

/** One page of a site's submissions, newest first. */
export async function listFormSubmissions(
  db: Kysely<CommerceDB>,
  ref: SiteRef,
  options: ListOptions = {},
): Promise<{ submissions: FormSubmission[]; hasMore: boolean }> {
  const limit = Math.min(200, Math.max(1, Math.trunc(options.limit ?? 50)));
  let query = db
    .selectFrom('form_submission')
    .select(COLUMNS)
    .where('tenant_id', '=', ref.tenantId)
    .where('site_id', '=', ref.siteId);
  if (options.formId) query = query.where('form_id', '=', options.formId);
  if (options.before) {
    const { createdAt, id } = options.before;
    query = query.where((eb) =>
      eb.or([eb('created_at', '<', createdAt), eb.and([eb('created_at', '=', createdAt), eb('id', '<', id)])]),
    );
  }
  const rows = (await query
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(limit + 1)
    .execute()) as Row[];
  return { submissions: rows.slice(0, limit).map(toSubmission), hasMore: rows.length > limit };
}

/** Every submission of a site (optionally one form), newest first, for the CSV export. Bounded. */
export async function exportFormSubmissions(
  db: Kysely<CommerceDB>,
  ref: SiteRef,
  options: { formId?: string; max: number },
): Promise<{ submissions: FormSubmission[]; truncated: boolean }> {
  let query = db
    .selectFrom('form_submission')
    .select(COLUMNS)
    .where('tenant_id', '=', ref.tenantId)
    .where('site_id', '=', ref.siteId);
  if (options.formId) query = query.where('form_id', '=', options.formId);
  const rows = (await query
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(options.max + 1)
    .execute()) as Row[];
  return { submissions: rows.slice(0, options.max).map(toSubmission), truncated: rows.length > options.max };
}

export interface FormSummary {
  formId: string;
  formName: string;
  total: number;
  unread: number;
}

/** The forms that received submissions on this site, with counts (the view's filter). */
export async function summarizeForms(db: Kysely<CommerceDB>, ref: SiteRef): Promise<FormSummary[]> {
  const rows = await db
    .selectFrom('form_submission')
    .select([
      'form_id',
      // The newest name the form was submitted under (an owner may rename a form).
      sql<string>`(array_agg("form_name" ORDER BY "created_at" DESC))[1]`.as('form_name'),
      sql<string>`count(*)`.as('total'),
      sql<string>`count(*) FILTER (WHERE "read_at" IS NULL)`.as('unread'),
    ])
    .where('tenant_id', '=', ref.tenantId)
    .where('site_id', '=', ref.siteId)
    .groupBy('form_id')
    .execute();
  return rows
    .map((r) => ({ formId: r.form_id, formName: r.form_name, total: Number(r.total), unread: Number(r.unread) }))
    .sort((a, b) => a.formName.localeCompare(b.formName) || a.formId.localeCompare(b.formId));
}

/** Mark one submission read or unread. Returns false when the site has no such row. */
export async function setFormSubmissionRead(
  db: Kysely<CommerceDB>,
  ref: SiteRef,
  id: string,
  read: boolean,
): Promise<boolean> {
  const result = await db
    .updateTable('form_submission')
    .set({ read_at: read ? sql<Date>`COALESCE("read_at", CURRENT_TIMESTAMP)` : null })
    .where('tenant_id', '=', ref.tenantId)
    .where('site_id', '=', ref.siteId)
    .where('id', '=', id)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

/** Delete one submission for good. Returns false when the site has no such row. */
export async function deleteFormSubmission(db: Kysely<CommerceDB>, ref: SiteRef, id: string): Promise<boolean> {
  const result = await db
    .deleteFrom('form_submission')
    .where('tenant_id', '=', ref.tenantId)
    .where('site_id', '=', ref.siteId)
    .where('id', '=', id)
    .executeTakeFirst();
  return Number(result.numDeletedRows) > 0;
}

/** Delete every submission of a site (the project delete). Returns how many rows went. */
export async function deleteSiteSubmissions(db: Kysely<CommerceDB>, ref: SiteRef): Promise<number> {
  const result = await db
    .deleteFrom('form_submission')
    .where('tenant_id', '=', ref.tenantId)
    .where('site_id', '=', ref.siteId)
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}

/** Delete every submission of a company's workspace (company erasure). Returns how many rows went. */
export async function deleteWorkspaceSubmissions(
  db: Kysely<CommerceDB>,
  ref: { tenantId: string; workspaceId: string },
): Promise<number> {
  const result = await db
    .deleteFrom('form_submission')
    .where('tenant_id', '=', ref.tenantId)
    .where('workspace_id', '=', ref.workspaceId)
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}

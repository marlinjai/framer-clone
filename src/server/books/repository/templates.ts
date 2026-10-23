// src/server/books/repository/templates.ts
//
// Document templates (Books plan P1.1 `document_template`; versioned by the
// visual template composer plan, decisions 3 and 4, migration
// 012_books_template_v2): the LAYOUT of the company's documents, nothing
// legal. The sender identity, the tax status and the number formats are NOT
// on the template (P1.12 items 2 and 4): they are company configuration in
// `books_company_settings` and `document_number_counter`, so switching a
// template can never change who issues a document or split a number series.
//
// A template row carries its name, whether it is the company's default, the
// locale, the default intro and outro texts of a new draft, and its CURRENT
// VERSION. Every saved layout is a row of `document_template_version`
// (append-only): a template document of model version 2 (template/schema.ts),
// numbered 1, 2, 3. Saving a layout writes a new version and moves the
// current one, in one transaction, only after the save gate passes
// (template/gate.ts: the structural rules and the probe render).
//
// The layout is edited only as a whole document, by the visual composer
// (phase 4, /projects/books/templates/<id>); the phase 3 form's partial edits
// (accent colour, small print) are gone with it. A template is created from a
// preset or a whole document.
//
// Rules: names are unique among a company's live templates
// (DUPLICATE_TEMPLATE); at most one default per company (making one the
// default clears the others in the same transaction); a template a draft uses
// cannot be removed (TEMPLATE_IN_USE). Removing ARCHIVES it (the versions an
// issued document was rendered with are never deleted): it leaves the list and
// the picker, and its name is free again. Every query filters on the company:
// another company's template is TEMPLATE_NOT_FOUND.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { sql, type Kysely, type Transaction } from 'kysely';

import type { CommerceDB } from '../../commerce/db-types';
import { BooksError, constraintName, invalid, sqlState, withDbErrors } from '../errors';
import type { BooksScope } from '../scope';
import { storedTemplateDocumentSchema, toJsonb, type TemplateSnapshotV2 } from '../snapshots';
import { assertTemplateSavable } from '../template/gate';
import { klassisch, PRESETS, preset } from '../template/presets';
import { templateDocumentV2Schema, templateLogo, type TemplateDocumentV2 } from '../template/schema';
import { templateAssets } from './assets';

type Db = Kysely<CommerceDB> | Transaction<CommerceDB>;

export interface DocumentTemplate {
  id: string;
  name: string;
  isDefault: boolean;
  locale: string;
  /** The current version (its id and number) and its document. */
  currentVersionId: string;
  version: number;
  document: TemplateDocumentV2;
  /** The current version's accent colour (the templates list shows it as a swatch). */
  accentColor: string;
  defaultIntroText: string | null;
  defaultOutroText: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Who saves a version (the signed-in user), recorded on the version row. */
export interface TemplateActor {
  userId?: string | null;
}

type TemplateRow = {
  id: string;
  name: string;
  is_default: boolean;
  locale: string;
  current_version_id: string;
  default_intro_text: string | null;
  default_outro_text: string | null;
  created_at: Date;
  updated_at: Date;
  version: number;
  document: unknown;
};

/** The template rows of a company joined with their current version. */
function selectTemplates(db: Db, scope: BooksScope) {
  return db
    .selectFrom('document_template as t')
    .innerJoin('document_template_version as v', (j) =>
      j.onRef('v.tenant_id', '=', 't.tenant_id').onRef('v.template_id', '=', 't.id').onRef('v.id', '=', 't.current_version_id'),
    )
    .select([
      't.id',
      't.name',
      't.is_default',
      't.locale',
      't.current_version_id',
      't.default_intro_text',
      't.default_outro_text',
      't.created_at',
      't.updated_at',
      'v.version',
      'v.document',
    ])
    .where('t.tenant_id', '=', scope.tenantId);
}

function mapTemplate(row: TemplateRow): DocumentTemplate {
  // A stored version is read with the shape check only (snapshots.ts): a later, stricter schema never hides it.
  const document = storedTemplateDocumentSchema.parse(row.document);
  return {
    id: row.id,
    name: row.name,
    isDefault: row.is_default,
    locale: row.locale,
    currentVersionId: row.current_version_id,
    version: row.version,
    document,
    accentColor: document.theme.accent,
    defaultIntroText: row.default_intro_text,
    defaultOutroText: row.default_outro_text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const optionalText = z.string().trim().max(4000).nullable().optional();
const fields = {
  name: z.string().trim().min(1).max(100),
  isDefault: z.boolean(),
  locale: z.enum(['de-DE']),
  defaultIntroText: optionalText,
  defaultOutroText: optionalText,
};

const createInput = z
  .object({
    name: fields.name,
    isDefault: fields.isDefault.optional(),
    locale: fields.locale.optional(),
    /** The starting layout: a preset (Klassisch when neither is given), or a whole document. */
    preset: z.enum(PRESETS).optional(),
    document: z.unknown().optional(),
    defaultIntroText: fields.defaultIntroText,
    defaultOutroText: fields.defaultOutroText,
  })
  .strict()
  .refine((v) => v.preset === undefined || v.document === undefined, { message: 'give a preset or a document, not both', path: ['document'] });
export type CreateTemplateInput = z.input<typeof createInput>;

const updateInput = z
  .object({
    name: fields.name.optional(),
    isDefault: fields.isDefault.optional(),
    locale: fields.locale.optional(),
    /** A whole new layout (saved as the next version). */
    document: z.unknown().optional(),
    /** The version the edit was made on: a newer saved version refuses it (CONCURRENT_EDIT). */
    baseVersionId: z.string().min(1).optional(),
    defaultIntroText: fields.defaultIntroText,
    defaultOutroText: fields.defaultOutroText,
  })
  .strict();
export type UpdateTemplateInput = z.input<typeof updateInput>;

/** JSON with sorted keys: a stored document comes back from JSONB in Postgres' key order, not the schema's. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** A template document from the request (INVALID_INPUT with the paths when it does not parse). */
function parseDocument(value: unknown): TemplateDocumentV2 {
  const parsed = templateDocumentV2Schema.safeParse(value);
  if (!parsed.success) {
    throw invalid(
      'INVALID_INPUT',
      parsed.error.issues.map((i) => ({ ...i, path: ['document', ...i.path] })),
    );
  }
  return parsed.data;
}

function duplicateOrRethrow(err: unknown): never {
  if (sqlState(err) === '23505' && constraintName(err) === 'document_template_tenant_id_name_key') {
    throw new BooksError('DUPLICATE_TEMPLATE', 'DUPLICATE_TEMPLATE: a template with this name exists', {
      issues: [{ path: 'name', message: 'already used by another template' }],
    });
  }
  throw err;
}

export async function listTemplates(scope: BooksScope): Promise<DocumentTemplate[]> {
  const rows = await selectTemplates(scope.db, scope)
    .where('t.archived_at', 'is', null)
    .orderBy('t.is_default', 'desc')
    .orderBy('t.name')
    .execute();
  return rows.map(mapTemplate);
}

/** One live template of the company, or TEMPLATE_NOT_FOUND. */
export async function getTemplate(scope: BooksScope, id: string): Promise<DocumentTemplate> {
  const row = await selectTemplates(scope.db, scope).where('t.id', '=', id).where('t.archived_at', 'is', null).executeTakeFirst();
  if (!row) throw new BooksError('TEMPLATE_NOT_FOUND', 'TEMPLATE_NOT_FOUND', { templateId: id });
  return mapTemplate(row);
}

/** One saved version of a template, as the composer's version list shows it. */
export interface TemplateVersionSummary {
  id: string;
  version: number;
  createdAt: Date;
  /** Whether this is the template's current version. */
  current: boolean;
  /** The issued documents laid out with this version (their frozen snapshots name it). */
  documentCount: number;
}

/**
 * The saved versions of one live template, newest first, each with the number
 * of issued documents frozen with it ("Version 3 of 21.10.2026, used by 4
 * documents"). A draft is not counted: it always previews the current version
 * and freezes one only at issue. Another company's or an archived template is
 * TEMPLATE_NOT_FOUND, as in getTemplate.
 */
export async function listTemplateVersions(scope: BooksScope, templateId: string): Promise<TemplateVersionSummary[]> {
  const template = await scope.db
    .selectFrom('document_template')
    .select(['id', 'current_version_id'])
    .where('tenant_id', '=', scope.tenantId)
    .where('id', '=', templateId)
    .where('archived_at', 'is', null)
    .executeTakeFirst();
  if (!template) throw new BooksError('TEMPLATE_NOT_FOUND', 'TEMPLATE_NOT_FOUND', { templateId });
  const rows = await scope.db
    .selectFrom('document_template_version')
    .select(['id', 'version', 'created_at'])
    .where('tenant_id', '=', scope.tenantId)
    .where('template_id', '=', templateId)
    .orderBy('version', 'desc')
    .execute();
  // One pass over the company's documents of this template, counted per frozen version.
  const counts = await scope.db
    .selectFrom('sales_document')
    .select((eb) => [sql<string>`template_snapshot->>'templateVersionId'`.as('version_id'), eb.fn.countAll<string>().as('n')])
    .where('tenant_id', '=', scope.tenantId)
    .where(sql<string>`template_snapshot->>'templateId'`, '=', templateId)
    .groupBy(sql`template_snapshot->>'templateVersionId'`)
    .execute();
  const used = new Map(counts.map((c) => [c.version_id, Number(c.n)]));
  return rows.map((r) => ({
    id: r.id,
    version: r.version,
    createdAt: r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
    current: r.id === template.current_version_id,
    documentCount: used.get(r.id) ?? 0,
  }));
}

/** The company's default template id, or null when it has none. */
export async function defaultTemplateId(scope: BooksScope): Promise<string | null> {
  const row = await scope.db
    .selectFrom('document_template')
    .select('id')
    .where('tenant_id', '=', scope.tenantId)
    .where('is_default', '=', true)
    .where('archived_at', 'is', null)
    .executeTakeFirst();
  return row?.id ?? null;
}

/**
 * Serialize the company's template writes that move the default: two first
 * templates created at once would both claim it and one would fail on the
 * one-default index. A transaction lock per company makes the second wait and
 * see the first.
 */
async function lockTemplates(trx: Transaction<CommerceDB>, scope: BooksScope): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`books-templates:${scope.tenantId}`}, 0))`.execute(trx);
}

async function clearDefault(trx: Transaction<CommerceDB>, scope: BooksScope, except: string | null): Promise<void> {
  let q = trx
    .updateTable('document_template')
    .set({ is_default: false, updated_at: new Date() })
    .where('tenant_id', '=', scope.tenantId)
    .where('is_default', '=', true);
  if (except) q = q.where('id', '<>', except);
  await q.execute();
}

export async function createTemplate(scope: BooksScope, input: CreateTemplateInput, actor: TemplateActor = {}): Promise<DocumentTemplate> {
  const parsed = createInput.safeParse(input);
  if (!parsed.success) throw invalid('INVALID_INPUT', parsed.error.issues);
  const args = parsed.data;
  // Every written version passes the strict schema (a preset does by construction; the gate proves it below).
  const document = args.document !== undefined ? parseDocument(args.document) : preset(args.preset ?? 'klassisch');
  // The save gate runs before anything is written (it renders the probe documents with the company's logo).
  await assertTemplateSavable(document, await templateAssets(scope.db, scope, document));
  const id = randomUUID();
  const versionId = randomUUID();
  try {
    return await withDbErrors(() =>
      scope.db
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (trx) => {
          await lockTemplates(trx, scope);
          // The first template of a company is its default, unless told otherwise.
          const existing = await trx
            .selectFrom('document_template')
            .select('id')
            .where('tenant_id', '=', scope.tenantId)
            .where('archived_at', 'is', null)
            .limit(1)
            .executeTakeFirst();
          const isDefault = args.isDefault ?? !existing;
          if (isDefault) await clearDefault(trx, scope, null);
          // The current version key is deferred (012): the row may name its first version before it exists.
          await trx
            .insertInto('document_template')
            .values({
              id,
              tenant_id: scope.tenantId,
              name: args.name,
              is_default: isDefault,
              locale: args.locale ?? 'de-DE',
              current_version_id: versionId,
              default_intro_text: args.defaultIntroText ?? null,
              default_outro_text: args.defaultOutroText ?? null,
              updated_at: new Date(),
            })
            .execute();
          await trx
            .insertInto('document_template_version')
            .values({
              id: versionId,
              tenant_id: scope.tenantId,
              template_id: id,
              version: 1,
              document: toJsonb(document),
              created_by: actor.userId ?? null,
            })
            .execute();
          return mapTemplate(await selectTemplates(trx, scope).where('t.id', '=', id).executeTakeFirstOrThrow());
        }),
    );
  } catch (err) {
    duplicateOrRethrow(err);
  }
}

export async function updateTemplate(
  scope: BooksScope,
  id: string,
  input: UpdateTemplateInput,
  actor: TemplateActor = {},
): Promise<DocumentTemplate> {
  const parsed = updateInput.safeParse(input);
  if (!parsed.success) throw invalid('INVALID_INPUT', parsed.error.issues);
  const args = parsed.data;
  const newDocument = args.document !== undefined ? parseDocument(args.document) : undefined;

  // The gate renders seven probe documents: run it before the transaction, on
  // the layout the edit produces from the version it was made on, and check
  // under the lock that this version is still the current one.
  let candidate: { base: string; document: TemplateDocumentV2 } | null = null;
  if (newDocument) {
    const current = await getTemplate(scope, id);
    if (args.baseVersionId && args.baseVersionId !== current.currentVersionId) {
      throw new BooksError('CONCURRENT_EDIT', 'CONCURRENT_EDIT: the template has a newer version', {
        templateId: id,
        currentVersionId: current.currentVersionId,
      });
    }
    // Saving the same layout again is not a new version.
    if (canonical(newDocument) !== canonical(current.document)) {
      // Assets are append-only, so a logo found here is still there when the version is written.
      await assertTemplateSavable(newDocument, await templateAssets(scope.db, scope, newDocument));
      candidate = { base: current.currentVersionId, document: newDocument };
    }
  }

  try {
    return await withDbErrors(() =>
      scope.db
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (trx) => {
          if (args.isDefault === true) await lockTemplates(trx, scope);
          const row = await trx
            .selectFrom('document_template')
            .select(['id', 'current_version_id'])
            .where('tenant_id', '=', scope.tenantId)
            .where('id', '=', id)
            .where('archived_at', 'is', null)
            .forUpdate()
            .executeTakeFirst();
          if (!row) throw new BooksError('TEMPLATE_NOT_FOUND', 'TEMPLATE_NOT_FOUND', { templateId: id });
          let currentVersionId = row.current_version_id;
          if (candidate) {
            if (candidate.base !== row.current_version_id) {
              throw new BooksError('CONCURRENT_EDIT', 'CONCURRENT_EDIT: the template has a newer version', {
                templateId: id,
                currentVersionId: row.current_version_id,
              });
            }
            const last = await trx
              .selectFrom('document_template_version')
              .select((eb) => eb.fn.max('version').as('version'))
              .where('tenant_id', '=', scope.tenantId)
              .where('template_id', '=', id)
              .executeTakeFirstOrThrow();
            currentVersionId = randomUUID();
            await trx
              .insertInto('document_template_version')
              .values({
                id: currentVersionId,
                tenant_id: scope.tenantId,
                template_id: id,
                version: Number(last.version ?? 0) + 1,
                document: toJsonb(candidate.document),
                created_by: actor.userId ?? null,
              })
              .execute();
          }
          if (args.isDefault === true) await clearDefault(trx, scope, id);
          await trx
            .updateTable('document_template')
            .set({
              ...(args.name !== undefined ? { name: args.name } : {}),
              ...(args.isDefault !== undefined ? { is_default: args.isDefault } : {}),
              ...(args.locale !== undefined ? { locale: args.locale } : {}),
              ...(args.defaultIntroText !== undefined ? { default_intro_text: args.defaultIntroText } : {}),
              ...(args.defaultOutroText !== undefined ? { default_outro_text: args.defaultOutroText } : {}),
              current_version_id: currentVersionId,
              updated_at: new Date(),
            })
            .where('tenant_id', '=', scope.tenantId)
            .where('id', '=', id)
            .execute();
          return mapTemplate(await selectTemplates(trx, scope).where('t.id', '=', id).executeTakeFirstOrThrow());
        }),
    );
  } catch (err) {
    duplicateOrRethrow(err);
  }
}

/**
 * Remove a template from the company's list: archive it (decision 4: the
 * versions an issued document was rendered with stay). A template a draft
 * uses is TEMPLATE_IN_USE: the draft would lose its layout; issued documents
 * carry theirs frozen and do not hold the template.
 */
export async function deleteTemplate(scope: BooksScope, id: string): Promise<void> {
  await withDbErrors(() =>
    scope.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx) => {
        const row = await trx
          .selectFrom('document_template')
          .select('id')
          .where('tenant_id', '=', scope.tenantId)
          .where('id', '=', id)
          .where('archived_at', 'is', null)
          .forUpdate()
          .executeTakeFirst();
        if (!row) throw new BooksError('TEMPLATE_NOT_FOUND', 'TEMPLATE_NOT_FOUND', { templateId: id });
        const draft = await trx
          .selectFrom('sales_document')
          .select('id')
          .where('tenant_id', '=', scope.tenantId)
          .where('template_id', '=', id)
          .where('status', '=', 'draft')
          .limit(1)
          .executeTakeFirst();
        if (draft) throw new BooksError('TEMPLATE_IN_USE', 'TEMPLATE_IN_USE: drafts use this template', { templateId: id });
        await trx
          .updateTable('document_template')
          .set({ archived_at: new Date(), is_default: false, updated_at: new Date() })
          .where('tenant_id', '=', scope.tenantId)
          .where('id', '=', id)
          .execute();
      }),
  );
}

/**
 * The template a document is laid out with: the current version of its
 * template, or the built-in Klassisch layout when it has none (or the template
 * is gone). Reads through the caller's handle, so it runs inside the issue
 * transaction.
 */
export async function templateSnapshotFor(db: Db, scope: BooksScope, templateId: string | null): Promise<TemplateSnapshotV2> {
  const row = templateId ? await selectTemplates(db, scope).where('t.id', '=', templateId).executeTakeFirst() : undefined;
  if (!row) return { v: 2, templateId: null, templateVersionId: null, name: null, document: klassisch(), logo: null };
  const document = storedTemplateDocumentSchema.parse(row.document);
  return {
    v: 2,
    templateId: row.id,
    templateVersionId: row.current_version_id,
    name: row.name,
    document,
    // The template's one logo (rules.ts), by hash: the re-render reads exactly these bytes (books_asset is append-only).
    logo: templateLogo(document),
  };
}

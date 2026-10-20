// src/server/books/repository/templates.ts
//
// Document templates (Books plan P1.1 table `document_template`, phase 3): the
// LAYOUT of the company's documents, nothing legal. A template carries a name,
// whether it is the company's default, the locale, an accent colour, up to four
// footer blocks of small print, and default intro and outro texts a new draft
// starts with. The sender identity, the tax status and the number formats are
// NOT on the template (P1.12 items 2 and 4): they are company configuration in
// `books_company_settings` and `document_number_counter`, so switching a
// template can never change who issues a document or split a number series.
//
// `logo_file_id` stays NULL from here: a logo is a storage-brain file and this
// repository has no storage-brain client yet (Books plan, phase 2 and 3 build
// notes). The column is kept for that connection.
//
// Rules: names are unique per company (DUPLICATE_TEMPLATE); at most one default
// per company (making one the default clears the others in the same
// transaction); a template a document points at cannot be deleted
// (TEMPLATE_IN_USE, the foreign key is the backstop), only replaced as default.
// Every query filters on the company: another company's template is
// TEMPLATE_NOT_FOUND.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { BooksError, constraintName, invalid, sqlState, withDbErrors } from '../errors';
import type { BooksScope } from '../scope';
import { toJsonb } from '../snapshots';

/** One footer block: a short heading and a few lines of small print. */
export const footerBlockSchema = z.object({
  heading: z.string().trim().max(60).nullable().optional(),
  text: z.string().trim().min(1).max(400),
});
export type FooterBlock = z.infer<typeof footerBlockSchema>;
const footerBlocksInput = z.array(footerBlockSchema).max(4);

export interface DocumentTemplate {
  id: string;
  name: string;
  isDefault: boolean;
  locale: string;
  accentColor: string | null;
  footerBlocks: FooterBlock[];
  defaultIntroText: string | null;
  defaultOutroText: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const TEMPLATE_COLUMNS = [
  'id',
  'name',
  'is_default',
  'locale',
  'accent_color',
  'footer_blocks',
  'default_intro_text',
  'default_outro_text',
  'created_at',
  'updated_at',
] as const;

type TemplateRow = {
  id: string;
  name: string;
  is_default: boolean;
  locale: string;
  accent_color: string | null;
  footer_blocks: unknown;
  default_intro_text: string | null;
  default_outro_text: string | null;
  created_at: Date;
  updated_at: Date;
};

/** Footer blocks as stored; anything that does not parse is dropped (layout, not law). */
function parseFooterBlocks(raw: unknown): FooterBlock[] {
  if (!Array.isArray(raw)) return [];
  const out: FooterBlock[] = [];
  for (const b of raw) {
    const parsed = footerBlockSchema.safeParse(b);
    if (parsed.success) out.push(parsed.data);
  }
  return out.slice(0, 4);
}

function mapTemplate(row: TemplateRow): DocumentTemplate {
  return {
    id: row.id,
    name: row.name,
    isDefault: row.is_default,
    locale: row.locale,
    accentColor: row.accent_color,
    footerBlocks: parseFooterBlocks(row.footer_blocks),
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
  accentColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'expected a colour such as #1a2b3c')
    .nullable(),
  footerBlocks: footerBlocksInput,
  defaultIntroText: optionalText,
  defaultOutroText: optionalText,
};

const createInput = z
  .object({
    name: fields.name,
    isDefault: fields.isDefault.optional(),
    locale: fields.locale.optional(),
    accentColor: fields.accentColor.optional(),
    footerBlocks: fields.footerBlocks.optional(),
    defaultIntroText: fields.defaultIntroText,
    defaultOutroText: fields.defaultOutroText,
  })
  .strict();
export type CreateTemplateInput = z.input<typeof createInput>;

const updateInput = z
  .object({
    name: fields.name.optional(),
    isDefault: fields.isDefault.optional(),
    locale: fields.locale.optional(),
    accentColor: fields.accentColor.optional(),
    footerBlocks: fields.footerBlocks.optional(),
    defaultIntroText: fields.defaultIntroText,
    defaultOutroText: fields.defaultOutroText,
  })
  .strict();
export type UpdateTemplateInput = z.input<typeof updateInput>;

function duplicateOrRethrow(err: unknown): never {
  if (sqlState(err) === '23505' && constraintName(err) === 'document_template_tenant_id_name_key') {
    throw new BooksError('DUPLICATE_TEMPLATE', 'DUPLICATE_TEMPLATE: a template with this name exists', {
      issues: [{ path: 'name', message: 'already used by another template' }],
    });
  }
  throw err;
}

export async function listTemplates(scope: BooksScope): Promise<DocumentTemplate[]> {
  const rows = await scope.db
    .selectFrom('document_template')
    .select(TEMPLATE_COLUMNS)
    .where('tenant_id', '=', scope.tenantId)
    .orderBy('is_default', 'desc')
    .orderBy('name')
    .execute();
  return rows.map(mapTemplate);
}

/** One template of the company, or TEMPLATE_NOT_FOUND. */
export async function getTemplate(scope: BooksScope, id: string): Promise<DocumentTemplate> {
  const row = await scope.db
    .selectFrom('document_template')
    .select(TEMPLATE_COLUMNS)
    .where('tenant_id', '=', scope.tenantId)
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) throw new BooksError('TEMPLATE_NOT_FOUND', 'TEMPLATE_NOT_FOUND', { templateId: id });
  return mapTemplate(row);
}

/** The company's default template id, or null when it has none. */
export async function defaultTemplateId(scope: BooksScope): Promise<string | null> {
  const row = await scope.db
    .selectFrom('document_template')
    .select('id')
    .where('tenant_id', '=', scope.tenantId)
    .where('is_default', '=', true)
    .executeTakeFirst();
  return row?.id ?? null;
}

export async function createTemplate(scope: BooksScope, input: CreateTemplateInput): Promise<DocumentTemplate> {
  const parsed = createInput.safeParse(input);
  if (!parsed.success) throw invalid('INVALID_INPUT', parsed.error.issues);
  const args = parsed.data;
  const id = randomUUID();
  try {
    return await withDbErrors(() =>
      scope.db
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (trx) => {
          // The first template of a company is its default, unless told otherwise.
          const existing = await trx
            .selectFrom('document_template')
            .select('id')
            .where('tenant_id', '=', scope.tenantId)
            .limit(1)
            .executeTakeFirst();
          const isDefault = args.isDefault ?? !existing;
          if (isDefault) {
            await trx
              .updateTable('document_template')
              .set({ is_default: false, updated_at: new Date() })
              .where('tenant_id', '=', scope.tenantId)
              .where('is_default', '=', true)
              .execute();
          }
          const row = await trx
            .insertInto('document_template')
            .values({
              id,
              tenant_id: scope.tenantId,
              name: args.name,
              is_default: isDefault,
              locale: args.locale ?? 'de-DE',
              accent_color: args.accentColor ?? null,
              footer_blocks: toJsonb(args.footerBlocks ?? []),
              default_intro_text: args.defaultIntroText ?? null,
              default_outro_text: args.defaultOutroText ?? null,
              updated_at: new Date(),
            })
            .returning(TEMPLATE_COLUMNS)
            .executeTakeFirstOrThrow();
          return mapTemplate(row);
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
): Promise<DocumentTemplate> {
  const parsed = updateInput.safeParse(input);
  if (!parsed.success) throw invalid('INVALID_INPUT', parsed.error.issues);
  const args = parsed.data;
  try {
    return await withDbErrors(() =>
      scope.db
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (trx) => {
          const current = await trx
            .selectFrom('document_template')
            .select('id')
            .where('tenant_id', '=', scope.tenantId)
            .where('id', '=', id)
            .forUpdate()
            .executeTakeFirst();
          if (!current) throw new BooksError('TEMPLATE_NOT_FOUND', 'TEMPLATE_NOT_FOUND', { templateId: id });
          if (args.isDefault === true) {
            await trx
              .updateTable('document_template')
              .set({ is_default: false, updated_at: new Date() })
              .where('tenant_id', '=', scope.tenantId)
              .where('is_default', '=', true)
              .where('id', '<>', id)
              .execute();
          }
          const row = await trx
            .updateTable('document_template')
            .set({
              ...(args.name !== undefined ? { name: args.name } : {}),
              ...(args.isDefault !== undefined ? { is_default: args.isDefault } : {}),
              ...(args.locale !== undefined ? { locale: args.locale } : {}),
              ...(args.accentColor !== undefined ? { accent_color: args.accentColor } : {}),
              ...(args.footerBlocks !== undefined ? { footer_blocks: toJsonb(args.footerBlocks) } : {}),
              ...(args.defaultIntroText !== undefined ? { default_intro_text: args.defaultIntroText } : {}),
              ...(args.defaultOutroText !== undefined ? { default_outro_text: args.defaultOutroText } : {}),
              updated_at: new Date(),
            })
            .where('tenant_id', '=', scope.tenantId)
            .where('id', '=', id)
            .returning(TEMPLATE_COLUMNS)
            .executeTakeFirstOrThrow();
          return mapTemplate(row);
        }),
    );
  } catch (err) {
    duplicateOrRethrow(err);
  }
}

/**
 * Delete a template no document points at. A template in use (by a draft or an
 * issued document) is TEMPLATE_IN_USE: an issued document's stored PDF already
 * carries its layout, but the reference stays as the record of what was used.
 */
export async function deleteTemplate(scope: BooksScope, id: string): Promise<void> {
  const used = await scope.db
    .selectFrom('sales_document')
    .select('id')
    .where('tenant_id', '=', scope.tenantId)
    .where('template_id', '=', id)
    .limit(1)
    .executeTakeFirst();
  if (used) throw new BooksError('TEMPLATE_IN_USE', 'TEMPLATE_IN_USE: documents use this template', { templateId: id });
  try {
    const res = await scope.db
      .deleteFrom('document_template')
      .where('tenant_id', '=', scope.tenantId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (Number(res.numDeletedRows) === 0) {
      throw new BooksError('TEMPLATE_NOT_FOUND', 'TEMPLATE_NOT_FOUND', { templateId: id });
    }
  } catch (err) {
    // A document created between the check and the delete: the foreign key refuses.
    if (sqlState(err) === '23503') {
      throw new BooksError('TEMPLATE_IN_USE', 'TEMPLATE_IN_USE: documents use this template', { templateId: id });
    }
    throw err;
  }
}

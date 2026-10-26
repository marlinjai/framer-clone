// src/server/commerce/provisioning/assignCompany.ts
//
// The operator step migration 020_catalogue_company leaves for a tenant group whose existing catalogue and
// order rows it could not assign (the schema knew no company, or several): name the company those rows
// belong to, and optionally validate the NOT VALID "names its company" constraints afterwards
// (docs/plans/2026-10-25-catalogue-design.md, slice 1). Owner role only; one transaction; idempotent (rows
// that already name a company are never touched, so it never moves a row from one company to another).
//
// Parents first, then each child from its parent, exactly as the migration's backfill: a child always ends
// up with its parent's company, and the composite foreign keys hold. Validation runs last and fails loudly
// when a row is still unassigned (for example a child whose parent belongs to nobody).
//
// The legacy products it assigns are also published: before 020 the storefront showed every live product
// whatever its status (and the old demo seed left them draft), and since 020 it shows only published ones.
// Publishing exactly the rows this step assigns keeps such a shop showing what it showed before; a product
// created after 020 always has its company and is never touched here.

import postgres from 'postgres';
import { assertTenantGroupId, tenantSchema } from '@marlinjai/tenant-db';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The tables migration 020 gave a company, parents first. */
const PARENTS = ['product', 'order'] as const;

/** [child, its parent, the child's column naming the parent], in dependency order. */
const CHILDREN = [
  ['product_option', 'product', 'product_id'],
  ['product_option_value', 'product_option', 'option_id'],
  ['product_variant', 'product', 'product_id'],
  ['product_variant_option', 'product_variant', 'variant_id'],
  ['price_set', 'product_variant', 'variant_id'],
  ['price', 'price_set', 'price_set_id'],
  ['order_line_item', 'order', 'order_id'],
] as const;

export interface AssignCompanyResult {
  /** Rows assigned per table. */
  assigned: Record<string, number>;
  /** Legacy draft products published with their assignment. */
  published: number;
  /** Whether the NOT VALID presence constraints were validated. */
  validated: boolean;
}

/**
 * Assign every unassigned catalogue and order row of one tenant group to `companyId`, then (with `validate`)
 * validate the presence constraints. Throws on a malformed id; a database refusal propagates and rolls back.
 */
export async function assignCatalogueCompany(opts: {
  connectionString: string;
  tenantGroupId: string;
  companyId: string;
  validate?: boolean;
}): Promise<AssignCompanyResult> {
  const schema = tenantSchema(assertTenantGroupId(opts.tenantGroupId));
  if (!UUID.test(opts.companyId)) {
    throw new Error(`assignCatalogueCompany: companyId must be a lowercase uuid, got ${opts.companyId}`);
  }
  const sql = postgres(opts.connectionString, { max: 1, prepare: false, onnotice: () => {} });
  try {
    return await sql.begin(async (tx) => {
      const assigned: Record<string, number> = {};
      // The legacy drafts that become visible again (see the header), published in the same statement that
      // assigns them: a row is only ever written with its company.
      const [drafts] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM ${tx(schema)}.${tx('product')}
         WHERE tenant_id IS NULL AND status = 'draft' AND deleted_at IS NULL`;
      const published = drafts?.n ?? 0;
      for (const table of PARENTS) {
        const result =
          table === 'product'
            ? await tx`
                UPDATE ${tx(schema)}.${tx(table)}
                   SET tenant_id = ${opts.companyId},
                       status = CASE WHEN status = 'draft' AND deleted_at IS NULL THEN 'published' ELSE status END
                 WHERE tenant_id IS NULL`
            : await tx`UPDATE ${tx(schema)}.${tx(table)} SET tenant_id = ${opts.companyId} WHERE tenant_id IS NULL`;
        assigned[table] = result.count;
      }
      for (const [table, parent, column] of CHILDREN) {
        const result = await tx`
          UPDATE ${tx(schema)}.${tx(table)} AS c
             SET tenant_id = p.tenant_id
            FROM ${tx(schema)}.${tx(parent)} AS p
           WHERE c.${tx(column)} = p.id AND c.tenant_id IS NULL AND p.tenant_id IS NOT NULL`;
        assigned[table] = result.count;
      }
      if (opts.validate) {
        for (const table of [...PARENTS, ...CHILDREN.map(([child]) => child)]) {
          await tx`ALTER TABLE ${tx(schema)}.${tx(table)} VALIDATE CONSTRAINT ${tx(`${table}_tenant_id_present`)}`;
        }
      }
      return { assigned, published, validated: Boolean(opts.validate) };
    });
  } finally {
    await sql.end();
  }
}

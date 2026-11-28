// src/server/commerce/provisioning/assignSites.ts
//
// The operator step of migration 033_catalogue_site: give every product and collection of a company the site it
// belongs to, so the shop catalogue is per project (docs/plans/2026-11-27-agent-catalogue-tools.md, decided by
// Marlin on 2026-11-28, "What the proposal changes and costs", point 5). Owner role, one transaction per run, a
// dry run by default (the same work, rolled back, with the same report). Driven by
// `pnpm catalogue:assign-sites` (scripts/catalogue-assign-sites.ts), which reads the sites from the public
// schema and passes them in: this module touches only the tenant schema.
//
// Per company, once (a company already in `catalogue_per_site` is skipped, so a second run changes nothing):
//
//   - The sites are the company's MAIN sites (a branch never owns a catalogue), oldest first.
//   - A product (not deleted, without a site yet) goes to the sites that show it today: the company's sites minus
//     those it is switched off for in `product_site_hidden`.
//       none   it stays a company item (no site): sold through the Books only, as a company without a site;
//       one    it moves there;
//       more   the row itself (its id, SKU, stock history, order and receipt references) moves to the site that
//              sold it most recently (an order line naming one of its variants, on one of those sites; the order
//              is not cancelled and its payment, if it has one, is paid), else to
//              the oldest published one of them, else the oldest; every further site gets a copy: new ids, the
//              same handle (handles are unique per site since 033), each SKU suffixed until it is free in the
//              tenant group (no barcode, which is unique there too), and an empty stock record per tracked SKU,
//              so the copy has its own stock, starting at zero. The report lists the copies, so the owner can
//              set their stock.
//   - A collection goes to the sites of its products (after the step above); one without products on any site
//     goes to the oldest site. The first of them keeps the row, every further site gets a copy; each lists, in
//     the original order, the product (or the copy) that is on its site. Memberships of products on no site
//     (deleted, or company items) are dropped and counted in the report.
//   - A deleted product stays as it is (no shop shows it). A company without a site keeps every item as a company
//     item. Either way the company is marked, so from then on a NULL site means "company item".
//   - The company is marked in `catalogue_per_site`, with the report. From that moment its shops read their own
//     products (src/server/commerce/repository/read.ts, visibleProductConditions).
//
// The catalogue tables are locked against writes for the run (SHARE ROW EXCLUSIVE), so a product created in the
// editor meanwhile cannot slip past the assignment; reads go on. A tenant group with a main site that names no
// company is refused when applying: its catalogue's sites are unknown (opening the site in the editor stamps it).

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { assertTenantGroupId, tenantSchema } from '@marlinjai/tenant-db';

import { DEFAULT_WORKSPACE_ID } from '../inventory/defaults';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A main site of the tenant group, as the public schema has it. */
export interface MainSite {
  id: string;
  /** NULL for a site nobody has opened since companies were stamped on sites (src/server/sites/siteCompany.ts). */
  companyId: string | null;
  createdAt: Date;
  /** Published (live): an unsold product's row, with its stock, prefers a live site over a draft. */
  published: boolean;
}

export interface CopiedRow {
  /** The row the copy was made from (it moved to another site). */
  from: string;
  /** The copy. */
  id: string;
  siteId: string;
}

export interface CopiedProduct extends CopiedRow {
  title: string;
  /** Each variant's SKU and its copy's SKU; the copy's stock starts at zero. */
  skus: Array<{ from: string; to: string }>;
}

export interface CompanyAssignment {
  companyId: string;
  /** Skipped: already assigned by an earlier run. */
  alreadyAssigned: boolean;
  /** The company's main sites, oldest first. */
  sites: string[];
  /** Products moved to a site, per site. */
  productsOnSite: Record<string, number>;
  productCopies: CopiedProduct[];
  /** Products left as company items (no site shows them, or the company has no site). */
  companyItems: number;
  collectionsOnSite: Record<string, number>;
  collectionCopies: CopiedRow[];
  collectionCompanyItems: number;
  /** Collection memberships dropped: the product is deleted or a company item, so on no site. */
  collectionMembersDropped: number;
  /**
   * Rows that could not keep their handle on their site, because a row already stamped with that site (made in the editor
   * after slice 2b, before this run) holds it: they get the next free `-2`, `-3`, ... handle there.
   */
  handlesRenamed: Array<{ table: 'product' | 'collection'; id: string; siteId: string; from: string; to: string }>;
  /**
   * Memberships of collections already stamped with a site that named a product without one: pointed at the product's row
   * (or copy) on the collection's site, or dropped when the product is not on that site.
   */
  stampedCollectionMembers: { remapped: number; dropped: number };
}

export interface AssignSitesReport {
  tenantGroupId: string;
  /** False for a dry run: everything above was computed and rolled back. */
  applied: boolean;
  /** Main sites of the group that name no company (a run that applies is refused while there are any). */
  unstampedSites: string[];
  companies: CompanyAssignment[];
}

export class AssignSitesRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssignSitesRefused';
  }
}

class DryRun extends Error {
  constructor(readonly report: AssignSitesReport) {
    super('dry run');
  }
}

type Sql = postgres.TransactionSql;
type Row = Record<string, unknown>;

/** Copy `table`'s row as it is, with `overrides` (every column comes along, so a column added later is copied too). */
async function copyRow(tx: Sql, schema: string, table: string, where: { column: string; value: string }, overrides: Row): Promise<void> {
  const result = await tx`
    INSERT INTO ${tx(schema)}.${tx(table)}
    SELECT (jsonb_populate_record(NULL::${tx(schema)}.${tx(table)}, to_jsonb(t) || ${tx.json(overrides as postgres.JSONValue)}::jsonb)).*
      FROM ${tx(schema)}.${tx(table)} AS t
     WHERE t.${tx(where.column)} = ${where.value}`;
  if (result.count !== 1) throw new Error(`assignSites: copying ${table} ${where.value} wrote ${result.count} rows`);
}

/** A SKU for a copy: the original's, suffixed `-2`, `-3`, ... until no live variant and no live stock item has it. */
async function freeSku(tx: Sql, schema: string, sku: string): Promise<string> {
  for (let n = 2; n < 1000; n++) {
    const suffix = `-${n}`;
    const candidate = `${sku.slice(0, 64 - suffix.length)}${suffix}`;
    const [taken] = await tx<{ taken: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM ${tx(schema)}."product_variant" WHERE "sku" = ${candidate} AND "deleted_at" IS NULL)
          OR EXISTS (SELECT 1 FROM ${tx(schema)}."inventory_item" WHERE "sku" = ${candidate} AND "deleted_at" IS NULL) AS taken`;
    if (!taken?.taken) return candidate;
  }
  throw new Error(`assignSites: no free SKU for a copy of ${sku}`);
}

/**
 * A handle for a row of `companyId` on `siteId`: the row's own when no other live row of the company on that site holds it,
 * else the next free `-2`, `-3`, ... (at most 120 characters, the handle check). Rows stamped with a site in the editor before
 * the run can hold a handle an unassigned row brings along.
 */
async function freeHandleOn(
  tx: Sql,
  schema: string,
  table: 'product' | 'collection',
  companyId: string,
  siteId: string,
  handle: string,
  exceptId: string,
): Promise<string> {
  const live = table === 'product' ? tx`"deleted_at" IS NULL` : tx`"archived_at" IS NULL`;
  for (let n = 1; n < 1000; n++) {
    const suffix = n === 1 ? '' : `-${n}`;
    const candidate = `${handle.slice(0, 120 - suffix.length).replace(/-+$/, '')}${suffix}`;
    const [taken] = await tx<{ taken: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM ${tx(schema)}.${tx(table)}
                      WHERE "tenant_id" = ${companyId} AND "site_id" = ${siteId} AND "handle" = ${candidate}
                        AND "id" <> ${exceptId} AND ${live}) AS taken`;
    if (!taken?.taken) return candidate;
  }
  throw new Error(`assignSites: no free handle on site ${siteId} for ${table} ${exceptId}`);
}

/** The tenant group's default stock location, created on first use (as the editor's stock setter does). */
async function defaultLocation(tx: Sql, schema: string, now: string): Promise<string> {
  const [existing] = await tx<{ location_id: string }[]>`
    SELECT "location_id" FROM ${tx(schema)}."fulfillment_location_default" WHERE "workspace_id" = ${DEFAULT_WORKSPACE_ID}`;
  if (existing) return existing.location_id;
  const id = randomUUID();
  await tx`INSERT INTO ${tx(schema)}."stock_location" ("id", "name", "updated_at") VALUES (${id}, 'Main stock', ${now})`;
  await tx`
    INSERT INTO ${tx(schema)}."fulfillment_location_default" ("workspace_id", "location_id", "updated_at")
    VALUES (${DEFAULT_WORKSPACE_ID}, ${id}, ${now})`;
  return id;
}

/**
 * The stock record of a copy's SKU, at zero: without one a tracked variant that allows backorders would show
 * "add to cart" and then fail at checkout, where before the run it sold.
 */
async function emptyStock(tx: Sql, schema: string, sku: string, title: string | null, now: string): Promise<void> {
  const item = randomUUID();
  await tx`
    INSERT INTO ${tx(schema)}."inventory_item" ("id", "sku", "title", "updated_at") VALUES (${item}, ${sku}, ${title}, ${now})`;
  await tx`
    INSERT INTO ${tx(schema)}."inventory_level" ("id", "inventory_item_id", "location_id", "updated_at")
    VALUES (${randomUUID()}, ${item}, ${await defaultLocation(tx, schema, now)}, ${now})`;
}

/**
 * New ids for copies of the rows `ids` (given in the database's `ORDER BY "id"`), sorting among themselves as the
 * originals do. Readers order child rows by id (the shop) or by `created_at` then id (the editor), and rows may
 * share a `created_at`: with random ids a copy would list them in another order than the original.
 */
function idsInSameOrder(ids: readonly string[]): Map<string, string> {
  const fresh = ids.map(() => randomUUID()).sort();
  return new Map(ids.map((old, i) => [old, fresh[i]]));
}

/**
 * Copy one product, with its options, values, variants, prices and images, onto `siteId`. The child rows keep
 * their original `created_at` and their order by id (idsInSameOrder), so every reader lists a copy's options,
 * values, variants and prices in the same order as the original's.
 */
async function copyProduct(
  tx: Sql,
  schema: string,
  productId: string,
  siteId: string,
  handle: string,
  now: string,
  id: string = randomUUID(),
): Promise<{ id: string; skus: CopiedProduct['skus'] }> {
  await copyRow(tx, schema, 'product', { column: 'id', value: productId }, {
    id, site_id: siteId, handle, books_product_id: null, created_at: now, updated_at: now,
  });

  const optionRows = await tx<{ id: string }[]>`
    SELECT "id" FROM ${tx(schema)}."product_option" WHERE "product_id" = ${productId} AND "deleted_at" IS NULL ORDER BY "id"`;
  const options = idsInSameOrder(optionRows.map((o) => o.id));
  for (const o of optionRows) {
    await copyRow(tx, schema, 'product_option', { column: 'id', value: o.id }, { id: options.get(o.id)!, product_id: id, updated_at: now });
  }
  const valueRows = await tx<{ id: string; option_id: string }[]>`
    SELECT "id", "option_id" FROM ${tx(schema)}."product_option_value"
     WHERE "option_id" IN ${tx([...options.keys(), ''])} AND "deleted_at" IS NULL ORDER BY "id"`;
  const values = idsInSameOrder(valueRows.map((v) => v.id));
  for (const v of valueRows) {
    await copyRow(tx, schema, 'product_option_value', { column: 'id', value: v.id }, {
      id: values.get(v.id)!, option_id: options.get(v.option_id)!, updated_at: now,
    });
  }

  const variantRows = await tx<{ id: string; sku: string | null; title: string | null; manage_inventory: boolean }[]>`
    SELECT "id", "sku", "title", "manage_inventory" FROM ${tx(schema)}."product_variant" WHERE "product_id" = ${productId} AND "deleted_at" IS NULL ORDER BY "id"`;
  const variants = idsInSameOrder(variantRows.map((v) => v.id));
  const skus: CopiedProduct['skus'] = [];
  const priceSets = await tx<{ id: string; variant_id: string }[]>`
    SELECT "id", "variant_id" FROM ${tx(schema)}."price_set" WHERE "variant_id" IN ${tx([...variants.keys(), ''])}`;
  const priceRows = await tx<{ id: string; price_set_id: string }[]>`
    SELECT "id", "price_set_id" FROM ${tx(schema)}."price" WHERE "price_set_id" IN ${tx([...priceSets.map((s) => s.id), ''])} ORDER BY "id"`;
  const prices = idsInSameOrder(priceRows.map((p) => p.id));
  for (const v of variantRows) {
    const sku = v.sku ? await freeSku(tx, schema, v.sku) : null;
    if (v.sku && sku) skus.push({ from: v.sku, to: sku });
    await copyRow(tx, schema, 'product_variant', { column: 'id', value: v.id }, {
      id: variants.get(v.id)!, product_id: id, sku, barcode: null, option_signature: null, updated_at: now,
    });
    if (sku && v.manage_inventory) await emptyStock(tx, schema, sku, v.title, now);
    await tx`
      INSERT INTO ${tx(schema)}."product_variant_option" ("variant_id", "option_id", "option_value_id", "tenant_id")
      SELECT ${variants.get(v.id)!}, m.new_option, n.new_value, pvo."tenant_id"
        FROM ${tx(schema)}."product_variant_option" pvo
        JOIN jsonb_each_text(${tx.json(Object.fromEntries(options))}::jsonb) AS m(old_option, new_option) ON m.old_option = pvo."option_id"
        JOIN jsonb_each_text(${tx.json(Object.fromEntries(values))}::jsonb) AS n(old_value, new_value) ON n.old_value = pvo."option_value_id"
       WHERE pvo."variant_id" = ${v.id}`;

    for (const ps of priceSets.filter((s) => s.variant_id === v.id)) {
      const priceSet = randomUUID();
      await copyRow(tx, schema, 'price_set', { column: 'id', value: ps.id }, { id: priceSet, variant_id: variants.get(v.id)!, updated_at: now });
      for (const p of priceRows.filter((row) => row.price_set_id === ps.id)) {
        const price = prices.get(p.id)!;
        await copyRow(tx, schema, 'price', { column: 'id', value: p.id }, { id: price, price_set_id: priceSet, updated_at: now });
        for (const r of await tx<{ id: string }[]>`SELECT "id" FROM ${tx(schema)}."price_rule" WHERE "price_id" = ${p.id}`) {
          await copyRow(tx, schema, 'price_rule', { column: 'id', value: r.id }, { id: randomUUID(), price_id: price, updated_at: now });
        }
      }
    }
  }

  for (const img of await tx<{ id: string; variant_id: string | null }[]>`
      SELECT "id", "variant_id" FROM ${tx(schema)}."product_image" WHERE "product_id" = ${productId}`) {
    await copyRow(tx, schema, 'product_image', { column: 'id', value: img.id }, {
      id: randomUUID(), product_id: id, variant_id: img.variant_id ? variants.get(img.variant_id) ?? null : null,
    });
  }
  return { id, skus };
}

async function assignCompany(tx: Sql, schema: string, companyId: string, sites: MainSite[]): Promise<CompanyAssignment> {
  const siteIds = sites.map((s) => s.id);
  const out: CompanyAssignment = {
    companyId, alreadyAssigned: false, sites: siteIds,
    productsOnSite: {}, productCopies: [], companyItems: 0,
    collectionsOnSite: {}, collectionCopies: [], collectionCompanyItems: 0, collectionMembersDropped: 0,
    handlesRenamed: [], stampedCollectionMembers: { remapped: 0, dropped: 0 },
  };
  /** The handle a row takes on a site, recorded in the report when it differs from its own. */
  const handleOn = async (table: 'product' | 'collection', id: string, siteId: string, own: string, exceptId: string) => {
    const to = await freeHandleOn(tx, schema, table, companyId, siteId, own, exceptId);
    if (to !== own) out.handlesRenamed.push({ table, id, siteId, from: own, to });
    return to;
  };
  const [done] = await tx`SELECT 1 FROM ${tx(schema)}."catalogue_per_site" WHERE "tenant_id" = ${companyId}`;
  if (done) return { ...out, alreadyAssigned: true };
  const now = new Date().toISOString();

  // Where each product is, per site: product id -> site id -> the product (or its copy) on that site.
  const placement = new Map<string, Map<string, string>>();
  const products = await tx<{ id: string; title: string; handle: string; hidden: string[] | null; last_site: string | null }[]>`
    SELECT p."id", p."title", p."handle",
           (SELECT array_agg(h."site_id") FROM ${tx(schema)}."product_site_hidden" h
             WHERE h."tenant_id" = p."tenant_id" AND h."product_id" = p."id") AS hidden,
           (SELECT o."site_id" FROM ${tx(schema)}."order_line_item" li
              JOIN ${tx(schema)}."order" o ON o."id" = li."order_id" AND o."tenant_id" = li."tenant_id"
              JOIN ${tx(schema)}."product_variant" v ON v."id" = li."variant_ref" AND v."tenant_id" = li."tenant_id"
             WHERE li."tenant_id" = p."tenant_id" AND v."product_id" = p."id"
               AND o."site_id" IN ${tx([...siteIds, ''])}
               AND o."status" <> 'cancelled'
               AND NOT EXISTS (SELECT 1 FROM ${tx(schema)}."order_payment" pay
                                WHERE pay."tenant_id" = o."tenant_id" AND pay."order_id" = o."id" AND pay."status" <> 'paid')
               AND NOT EXISTS (SELECT 1 FROM ${tx(schema)}."product_site_hidden" h2
                                WHERE h2."tenant_id" = p."tenant_id" AND h2."product_id" = p."id" AND h2."site_id" = o."site_id")
             ORDER BY o."created_at" DESC, o."id" DESC LIMIT 1) AS last_site
      FROM ${tx(schema)}."product" p
     WHERE p."tenant_id" = ${companyId} AND p."site_id" IS NULL AND p."deleted_at" IS NULL
     ORDER BY p."created_at", p."id"`;
  for (const p of products) {
    const hidden = new Set(p.hidden ?? []);
    const showing = siteIds.filter((s) => !hidden.has(s));
    if (showing.length === 0) {
      out.companyItems++;
      continue;
    }
    const live = new Set(sites.filter((s) => s.published).map((s) => s.id));
    const home = p.last_site && showing.includes(p.last_site) ? p.last_site : (showing.find((s) => live.has(s)) ?? showing[0]);
    const homeHandle = await handleOn('product', p.id, home, p.handle, p.id);
    await tx`UPDATE ${tx(schema)}."product" SET "site_id" = ${home}, "handle" = ${homeHandle} WHERE "tenant_id" = ${companyId} AND "id" = ${p.id}`;
    const where = new Map([[home, p.id]]);
    out.productsOnSite[home] = (out.productsOnSite[home] ?? 0) + 1;
    for (const site of showing.filter((s) => s !== home)) {
      const copyId = randomUUID();
      const copy = await copyProduct(tx, schema, p.id, site, await handleOn('product', copyId, site, p.handle, copyId), now, copyId);
      where.set(site, copy.id);
      out.productsOnSite[site] = (out.productsOnSite[site] ?? 0) + 1;
      out.productCopies.push({ from: p.id, id: copy.id, siteId: site, title: p.title, skus: copy.skus });
    }
    placement.set(p.id, where);
  }

  // Products the per-site editor already stamped (slice 2b, before this run) are where they are. While the company is not
  // assigned, a collection without a site may hold them (src/lib/catalog/siteRule.ts), so they place like any other: the
  // collection goes to their site too, and its copy there keeps them.
  const stampedProducts = await tx<{ id: string; site_id: string }[]>`
    SELECT "id", "site_id" FROM ${tx(schema)}."product"
     WHERE "tenant_id" = ${companyId} AND "site_id" IN ${tx([...siteIds, ''])} AND "deleted_at" IS NULL`;
  // The rows this run just placed are in `placement` already, with all their copies; only the earlier stamped ones are added.
  for (const sp of stampedProducts) if (!placement.has(sp.id)) placement.set(sp.id, new Map([[sp.site_id, sp.id]]));

  const collections = await tx<{ id: string; handle: string; archived: boolean; members: string[] | null }[]>`
    SELECT c."id", c."handle", c."archived_at" IS NOT NULL AS archived,
           (SELECT array_agg(cp."product_id" ORDER BY cp."position") FROM ${tx(schema)}."collection_product" cp
             WHERE cp."tenant_id" = c."tenant_id" AND cp."collection_id" = c."id") AS members
      FROM ${tx(schema)}."collection" c
     WHERE c."tenant_id" = ${companyId} AND c."site_id" IS NULL
     ORDER BY c."created_at", c."id"`;
  for (const c of collections) {
    const members = c.members ?? [];
    out.collectionMembersDropped += members.filter((m) => !placement.has(m)).length;
    if (siteIds.length === 0) {
      out.collectionCompanyItems++;
      continue;
    }
    const onSites = siteIds.filter((s) => members.some((m) => placement.get(m)?.has(s)));
    const targets = onSites.length > 0 ? onSites : [siteIds[0]];
    for (const [i, site] of targets.entries()) {
      const id = i === 0 ? c.id : randomUUID();
      // An archived collection holds no handle (the handle index covers live ones only), so it keeps its own.
      const handle = c.archived ? c.handle : await handleOn('collection', id, site, c.handle, id);
      if (i === 0) {
        await tx`UPDATE ${tx(schema)}."collection" SET "site_id" = ${site}, "handle" = ${handle} WHERE "tenant_id" = ${companyId} AND "id" = ${id}`;
        await tx`DELETE FROM ${tx(schema)}."collection_product" WHERE "tenant_id" = ${companyId} AND "collection_id" = ${id}`;
      } else {
        await copyRow(tx, schema, 'collection', { column: 'id', value: c.id }, { id, site_id: site, handle, created_at: now, updated_at: now });
        out.collectionCopies.push({ from: c.id, id, siteId: site });
      }
      const here = members.map((m) => placement.get(m)?.get(site)).filter((p): p is string => Boolean(p));
      for (const [position, productId] of here.entries()) {
        await tx`
          INSERT INTO ${tx(schema)}."collection_product" ("tenant_id", "collection_id", "product_id", "position")
          VALUES (${companyId}, ${id}, ${productId}, ${position + 1})`;
      }
      out.collectionsOnSite[site] = (out.collectionsOnSite[site] ?? 0) + 1;
    }
  }

  // Collections already stamped with a site (made in the editor after slice 2b) that hold a product which had no site: the
  // membership follows the product to its row on the collection's site, or goes when the product is not on that site. The
  // editor refuses such a membership since 2b; this covers any that exist anyway, so no collection reaches across sites.
  const unsited = new Set(products.map((p) => p.id));
  const stamped = await tx<{ collection_id: string; site_id: string; product_id: string; position: number }[]>`
    SELECT cp."collection_id", c."site_id", cp."product_id", cp."position"
      FROM ${tx(schema)}."collection_product" cp
      JOIN ${tx(schema)}."collection" c ON c."id" = cp."collection_id" AND c."tenant_id" = cp."tenant_id"
     WHERE cp."tenant_id" = ${companyId} AND c."site_id" IS NOT NULL
     ORDER BY cp."collection_id", cp."position"`;
  for (const m of stamped.filter((row) => unsited.has(row.product_id))) {
    const target = placement.get(m.product_id)?.get(m.site_id);
    if (target === m.product_id) continue; // its own row moved to this site
    const [already] = target
      ? await tx<{ n: number }[]>`
          SELECT 1 AS n FROM ${tx(schema)}."collection_product"
           WHERE "tenant_id" = ${companyId} AND "collection_id" = ${m.collection_id} AND "product_id" = ${target}`
      : [];
    if (target && !already) {
      await tx`
        UPDATE ${tx(schema)}."collection_product" SET "product_id" = ${target}
         WHERE "tenant_id" = ${companyId} AND "collection_id" = ${m.collection_id} AND "product_id" = ${m.product_id}`;
      out.stampedCollectionMembers.remapped++;
    } else {
      await tx`
        DELETE FROM ${tx(schema)}."collection_product"
         WHERE "tenant_id" = ${companyId} AND "collection_id" = ${m.collection_id} AND "product_id" = ${m.product_id}`;
      out.stampedCollectionMembers.dropped++;
    }
  }

  await tx`
    INSERT INTO ${tx(schema)}."catalogue_per_site" ("tenant_id", "report")
    VALUES (${companyId}, ${tx.json(out as unknown as postgres.JSONValue)}::jsonb)`;
  return out;
}

/**
 * Assign the catalogue of every company of one tenant group (or of `companyId` only) to its sites. Without
 * `apply` it is a dry run: the same work in a transaction that is rolled back, and the same report.
 */
export async function assignCatalogueSites(opts: {
  connectionString: string;
  tenantGroupId: string;
  /** The group's MAIN sites (no branches), from the public schema. */
  sites: readonly MainSite[];
  companyId?: string;
  apply?: boolean;
}): Promise<AssignSitesReport> {
  const tenantGroupId = assertTenantGroupId(opts.tenantGroupId);
  const schema = tenantSchema(tenantGroupId);
  if (opts.companyId !== undefined && !UUID.test(opts.companyId)) {
    throw new Error(`assignCatalogueSites: companyId must be a lowercase uuid, got ${opts.companyId}`);
  }
  const unstampedSites = opts.sites.filter((s) => !s.companyId).map((s) => s.id);
  const apply = Boolean(opts.apply);
  if (apply && unstampedSites.length > 0) {
    throw new AssignSitesRefused(
      `assignCatalogueSites: ${unstampedSites.length} main site(s) of the group name no company (${unstampedSites.join(', ')}); open each in the editor once (it stamps the company), then retry`,
    );
  }
  const byCompany = new Map<string, MainSite[]>();
  for (const s of [...opts.sites].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))) {
    if (!s.companyId) continue;
    byCompany.set(s.companyId, [...(byCompany.get(s.companyId) ?? []), s]);
  }

  const sql = postgres(opts.connectionString, { max: 1, prepare: false, onnotice: () => {} });
  try {
    return await sql.begin(async (tx) => {
      await tx`LOCK TABLE ${tx(schema)}."product", ${tx(schema)}."collection", ${tx(schema)}."collection_product" IN SHARE ROW EXCLUSIVE MODE`;
      const found = await tx<{ tenant_id: string }[]>`
        SELECT "tenant_id" FROM ${tx(schema)}."product" WHERE "tenant_id" IS NOT NULL
        UNION SELECT "tenant_id" FROM ${tx(schema)}."collection"`;
      const companies = [...new Set([...found.map((r) => r.tenant_id), ...byCompany.keys()])]
        .filter((c) => opts.companyId === undefined || c === opts.companyId)
        .sort();
      const report: AssignSitesReport = { tenantGroupId, applied: apply, unstampedSites, companies: [] };
      for (const companyId of companies) {
        report.companies.push(await assignCompany(tx, schema, companyId, byCompany.get(companyId) ?? []));
      }
      if (!apply) throw new DryRun(report);
      return report;
    });
  } catch (err) {
    if (err instanceof DryRun) return err.report;
    throw err;
  } finally {
    await sql.end();
  }
}

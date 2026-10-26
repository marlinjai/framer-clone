// src/server/catalog/repository/variants.ts
//
// A physical product's options and the variant matrix they generate, and the
// edits of one variant (catalogue design, "Options and variants").
//
// THE OPTIONS EDITOR (setOptions) takes the whole list of options as the panel
// shows it, with the ids of the options and values that exist already, and
// makes the stored matrix match it in one transaction:
//
//   - an option or value sent with its id keeps that id (a rename changes its
//     text only), so every variant that uses it keeps its id, price, stock and
//     SKU: the variant's option_signature (003) is made of value ids;
//   - an option or value left out is soft-deleted, and so is every variant
//     that used a removed value;
//   - a new option gives every kept variant its first value (the variants
//     stay, now with one more option), and the other combinations are new;
//   - a removed option collapses variants that differ only in it: the oldest of
//     each remaining combination stays, the others are soft-deleted;
//   - every combination nobody has yet becomes a new variant, priced like the
//     product's first kept variant, with a generated SKU and the same stock
//     tracking, so the table can set its stock at once.
//
// The order of the writes is what the database guarantees need: removed
// variants first, then the matrix rows of every kept variant are cleared, then
// removed values and options go, renames are written (through a temporary
// title, so swapping two names never trips the live-title unique index), new
// options and values are inserted (soft-deleting first keeps 020's "at most
// three options" guard counting only live ones), new variants are inserted, and
// finally the whole matrix is inserted in ONE statement, so the AFTER-row
// signature triggers of 003 see each variant's complete combination and never
// a half-written one that could collide with another variant's.
//
// Options and values have no position column: they keep the order they were
// created in (created_at, then id), and new ones are created with increasing
// timestamps so they follow the list as sent. Reordering existing values is
// not offered.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { MAX_OPTION_VALUES, MAX_OPTIONS, MAX_VARIANTS, type OptionInput, type ProductDetail } from '@/lib/catalog/types';

import { CatalogError, invalid, invalidField, notFound, withDbErrors } from '../errors';
import type { CatalogScope } from '../scope';
import { getProduct, MAX_CENTS } from './products';
import { generatedSku, insertVariant, liveVariant, lockProduct, setBasePrice, touchProduct, variantFigures } from './shared';

const optionsInput = z
  .array(
    z
      .object({
        id: z.string().min(1).optional(),
        title: z.string().trim().min(1, 'name the option').max(100),
        values: z
          .array(z.object({ id: z.string().min(1).optional(), value: z.string().trim().min(1, 'enter a value').max(100) }).strict())
          .min(1, 'give the option at least one value')
          .max(MAX_OPTION_VALUES, `at most ${MAX_OPTION_VALUES} values`),
      })
      .strict(),
  )
  .max(MAX_OPTIONS, `at most ${MAX_OPTIONS} options`)
  .superRefine((options, ctx) => {
    const titles = new Set<string>();
    options.forEach((o, i) => {
      const key = o.title.toLowerCase();
      if (titles.has(key)) ctx.addIssue({ code: 'custom', path: [i, 'title'], message: 'two options have this name' });
      titles.add(key);
      const values = new Set<string>();
      o.values.forEach((v, j) => {
        const vk = v.value.toLowerCase();
        if (values.has(vk)) ctx.addIssue({ code: 'custom', path: [i, 'values', j, 'value'], message: 'this value is listed twice' });
        values.add(vk);
      });
    });
    const combinations = options.reduce((n, o) => n * o.values.length, 1);
    if (combinations > MAX_VARIANTS) {
      ctx.addIssue({ code: 'custom', path: [], message: `these options make ${combinations} variants; at most ${MAX_VARIANTS}` });
    }
  });

/** Every combination of the options' value ids, the first option outermost. */
function combinations(valueIds: string[][]): string[][] {
  return valueIds.reduce<string[][]>((acc, ids) => acc.flatMap((combo) => ids.map((id) => [...combo, id])), [[]]);
}

/** Replace the product's options with these and regenerate its variant matrix (see the file header). */
export async function setOptions(scope: CatalogScope, productId: string, input: OptionInput[]): Promise<ProductDetail> {
  const parsed = optionsInput.safeParse(input);
  if (!parsed.success) throw invalid(parsed.error.issues.map((i) => ({ ...i, path: ['options', ...i.path] })));
  const wanted = parsed.data;

  await withDbErrors(() =>
    scope.db.transaction().execute(async (trx) => {
      const product = await lockProduct(trx, scope, productId);
      if (product.kind === 'service') {
        throw new CatalogError('SHAPE', 'a service has no options; make it a product first', { field: 'options' });
      }
      const t = scope.tenantId;
      const options = await trx
        .selectFrom('product_option')
        .select(['id', 'title'])
        .where('tenant_id', '=', t)
        .where('product_id', '=', productId)
        .where('deleted_at', 'is', null)
        .execute();
      const optionIds = new Set(options.map((o) => o.id));
      const values = options.length
        ? await trx
            .selectFrom('product_option_value')
            .select(['id', 'option_id', 'value'])
            .where('tenant_id', '=', t)
            .where('option_id', 'in', [...optionIds])
            .where('deleted_at', 'is', null)
            .execute()
        : [];
      const variants = await trx
        .selectFrom('product_variant')
        .select(['id', 'sku', 'manage_inventory', 'allow_backorder', 'created_at'])
        .where('tenant_id', '=', t)
        .where('product_id', '=', productId)
        .where('deleted_at', 'is', null)
        .orderBy('created_at')
        .orderBy('id')
        .execute();
      const matrix = variants.length
        ? await trx
            .selectFrom('product_variant_option')
            .select(['variant_id', 'option_id', 'option_value_id'])
            .where('tenant_id', '=', t)
            .where('variant_id', 'in', variants.map((v) => v.id))
            .execute()
        : [];

      // The ids sent must be this product's live options and values.
      wanted.forEach((o, i) => {
        if (o.id && !optionIds.has(o.id)) throw invalidField(`options.${i}.id`, 'not an option of this product (reload the product)');
        o.values.forEach((v, j) => {
          if (v.id && !values.some((x) => x.id === v.id && x.option_id === o.id)) {
            throw invalidField(`options.${i}.values.${j}.id`, 'not a value of this option (reload the product)');
          }
        });
      });

      const now = Date.now();
      let tick = 0;
      const stamp = () => new Date(now + (tick += 1));

      // The final option list with ids (new ones minted now).
      const finalOptions = wanted.map((o) => ({
        id: o.id ?? randomUUID(),
        isNew: !o.id,
        title: o.title,
        values: o.values.map((v) => ({ id: v.id ?? randomUUID(), isNew: !v.id, value: v.value })),
      }));
      const keptValueIds = new Set(finalOptions.flatMap((o) => o.values.map((v) => v.id)));
      const keptOptionIds = new Set(finalOptions.filter((o) => !o.isNew).map((o) => o.id));

      // Each existing variant projected onto the final options: a removed value drops it, a new option gives it the first value.
      const byVariant = new Map<string, Map<string, string>>();
      for (const m of matrix) {
        const map = byVariant.get(m.variant_id) ?? new Map<string, string>();
        map.set(m.option_id, m.option_value_id);
        byVariant.set(m.variant_id, map);
      }
      const keep = new Map<string, string[]>(); // variant id -> its final combination
      const taken = new Set<string>();
      for (const v of variants) {
        const current = byVariant.get(v.id) ?? new Map<string, string>();
        let combo: string[] | null = [];
        for (const o of finalOptions) {
          const valueId = o.isNew ? o.values[0].id : current.get(o.id);
          if (!valueId || !keptValueIds.has(valueId)) {
            combo = null;
            break;
          }
          combo.push(valueId);
        }
        if (!combo) continue;
        const key = combo.join(',');
        if (taken.has(key)) continue; // a collapse: the oldest of the combination stays
        taken.add(key);
        keep.set(v.id, combo);
      }
      // With no options at all, the product keeps exactly one variant (its oldest).
      if (finalOptions.length === 0 && keep.size === 0 && variants.length > 0) keep.set(variants[0].id, []);
      const removedVariants = variants.filter((v) => !keep.has(v.id)).map((v) => v.id);
      const template = variants.find((v) => keep.has(v.id)) ?? variants[0];
      const templatePrice = template ? ((await variantFigures(trx, scope, [template])).get(template.id)?.price ?? null) : null;

      // 1. Removed variants go (their image links are let go first).
      if (removedVariants.length > 0) {
        await trx
          .updateTable('product_image')
          .set({ variant_id: null })
          .where('tenant_id', '=', t)
          .where('variant_id', 'in', removedVariants)
          .execute();
        await trx
          .updateTable('product_variant')
          .set({ deleted_at: new Date(), updated_at: new Date() })
          .where('tenant_id', '=', t)
          .where('id', 'in', removedVariants)
          .execute();
      }
      // 2. The kept variants' matrix rows are cleared (their signatures become NULL, never colliding).
      if (keep.size > 0) {
        await trx.deleteFrom('product_variant_option').where('tenant_id', '=', t).where('variant_id', 'in', [...keep.keys()]).execute();
      }
      // 3. Removed values and options go.
      const removedValues = values.filter((v) => !keptValueIds.has(v.id)).map((v) => v.id);
      if (removedValues.length > 0) {
        await trx.updateTable('product_option_value').set({ deleted_at: new Date(), updated_at: new Date() }).where('tenant_id', '=', t).where('id', 'in', removedValues).execute();
      }
      const removedOptions = options.filter((o) => !keptOptionIds.has(o.id)).map((o) => o.id);
      if (removedOptions.length > 0) {
        await trx.updateTable('product_option').set({ deleted_at: new Date(), updated_at: new Date() }).where('tenant_id', '=', t).where('id', 'in', removedOptions).execute();
      }
      // 4. Renames, through a temporary text so a swap never meets the unique index half done.
      const renamedOptions = finalOptions.filter((o) => !o.isNew && options.find((x) => x.id === o.id)?.title !== o.title);
      const renamedValues = finalOptions.flatMap((o) => o.values.filter((v) => !v.isNew && values.find((x) => x.id === v.id)?.value !== v.value));
      for (const o of renamedOptions) {
        await trx.updateTable('product_option').set({ title: `~renaming~${o.id}` }).where('tenant_id', '=', t).where('id', '=', o.id).execute();
      }
      for (const v of renamedValues) {
        await trx.updateTable('product_option_value').set({ value: `~renaming~${v.id}` }).where('tenant_id', '=', t).where('id', '=', v.id).execute();
      }
      for (const o of renamedOptions) {
        await trx.updateTable('product_option').set({ title: o.title, updated_at: new Date() }).where('tenant_id', '=', t).where('id', '=', o.id).execute();
      }
      for (const v of renamedValues) {
        await trx.updateTable('product_option_value').set({ value: v.value, updated_at: new Date() }).where('tenant_id', '=', t).where('id', '=', v.id).execute();
      }
      // 5. New options and values, in the order sent.
      for (const o of finalOptions) {
        if (o.isNew) {
          await trx
            .insertInto('product_option')
            .values({ id: o.id, tenant_id: t, product_id: productId, title: o.title, created_at: stamp(), updated_at: new Date() })
            .execute();
        }
        const fresh = o.values.filter((v) => v.isNew);
        if (fresh.length > 0) {
          await trx
            .insertInto('product_option_value')
            .values(fresh.map((v) => ({ id: v.id, tenant_id: t, option_id: o.id, value: v.value, created_at: stamp(), updated_at: new Date() })))
            .execute();
        }
      }
      // 6. New variants for the combinations nobody has.
      const titleOf = (combo: string[]) =>
        combo.length === 0 ? null : combo.map((id) => finalOptions.flatMap((o) => o.values).find((v) => v.id === id)?.value ?? '').join(' / ');
      const finalMatrix: Array<{ variantId: string; combo: string[] }> = [...keep.entries()].map(([variantId, combo]) => ({ variantId, combo }));
      if (finalOptions.length > 0) {
        for (const combo of combinations(finalOptions.map((o) => o.values.map((v) => v.id)))) {
          if (taken.has(combo.join(','))) continue;
          const variantId = await insertVariant(trx, scope, {
            productId,
            title: titleOf(combo),
            sku: generatedSku(product.handle),
            manageInventory: template?.manage_inventory ?? true,
            allowBackorder: template?.allow_backorder ?? false,
            price: templatePrice,
            compareAt: null,
            createdAt: stamp(),
          });
          finalMatrix.push({ variantId, combo });
        }
      } else if (variants.length === 0) {
        // A product that somehow has no variant gets its one variant back.
        await insertVariant(trx, scope, {
          productId,
          title: null,
          sku: generatedSku(product.handle),
          manageInventory: true,
          allowBackorder: false,
          price: null,
          compareAt: null,
        });
      }
      // Kept variants carry their new title (a renamed value renames the variant).
      for (const [variantId, combo] of keep) {
        await trx.updateTable('product_variant').set({ title: titleOf(combo), updated_at: new Date() }).where('tenant_id', '=', t).where('id', '=', variantId).execute();
      }
      // 7. The whole matrix in one statement (see the file header).
      const rows = finalMatrix.flatMap(({ variantId, combo }) =>
        combo.map((valueId, i) => ({ tenant_id: t, variant_id: variantId, option_id: finalOptions[i].id, option_value_id: valueId })),
      );
      if (rows.length > 0) await trx.insertInto('product_variant_option').values(rows).execute();
      await touchProduct(trx, scope, productId);
    }),
  );
  return getProduct(scope, productId);
}

const SKU = z
  .string()
  .trim()
  .max(64, 'at most 64 characters')
  .regex(/^[A-Za-z0-9][A-Za-z0-9._\-/]*$/, 'letters, digits and . _ - / (starting with a letter or digit)');

const variantInput = z
  .object({
    sku: SKU.nullable()
      .optional()
      .transform((v) => (v === '' ? null : v)),
    barcode: z
      .string()
      .trim()
      .max(64)
      .nullable()
      .optional()
      .transform((v) => (v === '' ? null : v)),
    price: z.number().int().min(0).max(MAX_CENTS).nullable().optional(),
    compareAt: z.number().int().min(0).max(MAX_CENTS).nullable().optional(),
    manageInventory: z.boolean().optional(),
    allowBackorder: z.boolean().optional(),
    /** A product image (its link id) to show for this variant, or null for none. */
    imageId: z.string().min(1).nullable().optional(),
  })
  .strict();
export type VariantInput = z.input<typeof variantInput>;

/**
 * Change one variant: SKU, barcode, price, compare-at price, stock tracking,
 * backorder, its image. A service's variant never tracks stock. A variant's
 * image is one of the product's images; it becomes that variant's only image.
 */
export async function updateVariant(scope: CatalogScope, productId: string, variantId: string, input: VariantInput): Promise<ProductDetail> {
  const parsed = variantInput.safeParse(input);
  if (!parsed.success) throw invalid(parsed.error.issues);
  const args = parsed.data;
  await withDbErrors(() =>
    scope.db.transaction().execute(async (trx) => {
      const product = await lockProduct(trx, scope, productId);
      const variant = await liveVariant(trx, scope, productId, variantId);
      const t = scope.tenantId;
      if (product.kind === 'service' && (args.manageInventory || args.allowBackorder)) {
        throw invalidField('manageInventory', 'a service has no stock');
      }
      if (args.sku !== undefined || args.barcode !== undefined || args.manageInventory !== undefined || args.allowBackorder !== undefined) {
        await trx
          .updateTable('product_variant')
          .set({
            ...(args.sku !== undefined ? { sku: args.sku } : {}),
            ...(args.barcode !== undefined ? { barcode: args.barcode } : {}),
            ...(args.manageInventory !== undefined ? { manage_inventory: args.manageInventory } : {}),
            ...(args.allowBackorder !== undefined ? { allow_backorder: args.allowBackorder } : {}),
            updated_at: new Date(),
          })
          .where('tenant_id', '=', t)
          .where('id', '=', variantId)
          .execute();
      }
      if (args.price !== undefined || args.compareAt !== undefined) {
        const current = (await variantFigures(trx, scope, [variant])).get(variantId);
        const price = args.price !== undefined ? args.price : (current?.price ?? null);
        const compareAt = args.compareAt !== undefined ? args.compareAt : price === null ? null : (current?.compareAt ?? null);
        await setBasePrice(trx, scope, variantId, price, compareAt);
      }
      if (args.imageId !== undefined) {
        await trx.updateTable('product_image').set({ variant_id: null }).where('tenant_id', '=', t).where('variant_id', '=', variantId).execute();
        if (args.imageId !== null) {
          const r = await trx
            .updateTable('product_image')
            .set({ variant_id: variantId })
            .where('tenant_id', '=', t)
            .where('product_id', '=', productId)
            .where('id', '=', args.imageId)
            .executeTakeFirst();
          if (Number(r.numUpdatedRows) === 0) throw notFound('image', args.imageId);
        }
      }
      await touchProduct(trx, scope, productId);
    }),
  );
  return getProduct(scope, productId);
}

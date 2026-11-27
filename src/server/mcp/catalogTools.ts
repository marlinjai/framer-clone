import 'server-only';

// src/server/mcp/catalogTools.ts
//
// The catalogue tools of the Lumitra Sites MCP endpoint (plan docs/plans/2026-11-27-agent-catalogue-tools.md,
// slice 1: reads). Each tool is one catalogue operation (src/server/catalogOps), run as the verified key's
// caller, so the endpoint has no catalogue path of its own: the access checks, the site lookup and the
// company scope all come from the library.
//
// Every tool names a SITE: the catalogue an agent reads is the catalogue of that site, whichever way Marlin
// decides where the catalogue belongs (per company or per project). Prices are whole cents in EUR.
//
// Built by a factory that tools.ts calls with its own helpers (the read budget, the result shapes), so this
// file imports nothing from tools.ts and the two never form an import cycle.

import { z } from 'zod';

import { MAX_SEARCH_LENGTH } from '@/server/catalog/repository/products';
import { getSiteProduct, listSiteProducts, type CatalogOpsResult, type CatalogOpsDeps } from '@/server/catalogOps';
import type { ToolContext, ToolDef, ToolResult } from './tools';

/** What tools.ts lends these tools. */
export interface CatalogToolKit {
  /** Runs `run` under the key's read budget. */
  read: (ctx: ToolContext, run: () => Promise<ToolResult>) => Promise<ToolResult>;
  toolResult: (output: Record<string, unknown>, isError: boolean) => ToolResult;
  errorResult: (error: { code: string; message: string; [k: string]: unknown }) => ToolResult;
}

/** The catalogue operations' dependencies on the endpoint's own (the site lookup shares the branch deps). */
function catalogDeps(ctx: ToolContext): CatalogOpsDeps {
  return { branches: ctx.deps.branches ?? {} };
}

const siteId = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe("The site whose shop catalogue is meant, from list_sites. A branch id reads its site's catalogue.");
const productId = z.string().trim().min(1).max(200).describe('A product id, from list_products.');

const listArgs = z.strictObject({
  siteId,
  q: z
    .string()
    .max(MAX_SEARCH_LENGTH)
    .optional()
    .describe('Words that must all occur in the title, type, tags, description or a variant SKU.'),
  status: z
    .enum(['draft', 'published', 'archived', 'all'])
    .optional()
    .describe('Without it: draft and published products (not archived). `all` includes archived ones.'),
  type: z.string().trim().min(1).max(100).optional().describe('Only this product type (exact).'),
  stock: z
    .enum(['in_stock', 'out_of_stock', 'untracked'])
    .optional()
    .describe('in_stock: tracked with units available; out_of_stock: tracked with none; untracked: stock not tracked.'),
  sort: z.enum(['updated', 'title', 'created', 'price', 'stock']).optional().describe('Default: updated, newest first.'),
  dir: z.enum(['asc', 'desc']).optional(),
  cursor: z.string().min(1).max(2000).optional().describe('The nextCursor of the previous page (same sort and direction).'),
  limit: z.number().int().min(1).max(100).optional().describe('Products per page, default 50.'),
});

/** The catalogue tools, with tools.ts's helpers. */
export function catalogToolDefs(kit: CatalogToolKit): ToolDef[] {
  const answer = <T>(result: CatalogOpsResult<T>): ToolResult =>
    result.ok ? kit.toolResult(result.value as Record<string, unknown>, false) : kit.errorResult(result.error);

  const defs: Array<ToolDef<z.ZodType>> = [
    {
      name: 'list_products',
      title: 'List shop products',
      description:
        "The products in a site's shop catalogue, as the editor's Catalog table lists them: id, title, handle, kind (physical or service), status, product type, variant count, lowest and highest price in cents, available stock (null when not tracked), the single variant when there is just one, and the last change. Paged: pass nextCursor as cursor for the next page (null means the last). Every product and service the site's shop could sell is here, drafts included.",
      args: listArgs,
      annotations: { readOnlyHint: true, openWorldHint: false },
      run: (ctx, args) => kit.read(ctx, async () => answer(await listSiteProducts(ctx.caller, args as z.infer<typeof listArgs>, catalogDeps(ctx)))),
    },
    {
      name: 'get_product',
      title: 'Read a shop product',
      description:
        "One product of a site's shop catalogue: its fields (title, handle, kind, status, type, tags, description, tax class, price basis net or gross, unit label, SEO title and description), its options with their values, every variant (SKU, barcode, price and compare-at price in cents, stock tracking, backorder, available stock, its option values) and its images. A product of another company, or one this site does not show, is not_found.",
      args: z.strictObject({ siteId, productId }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      run: (ctx, args) =>
        kit.read(ctx, async () => {
          const a = args as { siteId: string; productId: string };
          return answer(await getSiteProduct(ctx.caller, a, catalogDeps(ctx)));
        }),
    },
  ];
  return defs as ToolDef[];
}

// src/app/api/commerce/__tests__/dto.test.ts
//
// Headless UNIT tests for the b7 commerce DTO mappers + zod response schemas.
// These run under the standard `pnpm test` gate (no Docker, no live Postgres):
// the mappers are PURE (commerce graph + a price map -> DTO), so what is exercised
// here is the projection logic, the integer-cents "from" price, the nullable-price
// honesty, and the advisory-only marker. This is one half of what makes the
// headless gate actually prove b7 (the other half is routes.test.ts): the
// `.itest.ts` Docker suite is EXCLUDED from `pnpm test`, so without these a green
// gate would prove nothing about the DTO surface (the b5/b6 hollow-gate lesson).

import { describe, expect, it } from 'vitest';

import {
  availabilityDTOSchema,
  productDTOSchema,
  toAvailabilityDTO,
  toProductDTO,
  type ProductGraph,
} from '@/lib/commerce/dto';

// Build a minimal product graph in the shape Prisma returns with productGraphInclude.
// Cast through unknown: the real payload type carries timestamps the mappers never
// read, so the fake populates only the fields under test.
function makeGraph(over: Partial<{
  id: string;
  handle: string;
  title: string;
  description: string | null;
  options: Array<{ id: string; title: string; values: Array<{ id: string; value: string }> }>;
  variants: Array<{
    id: string;
    title: string | null;
    sku: string | null;
    barcode: string | null;
    options: Array<{ optionId: string; optionValueId: string }>;
  }>;
}> = {}): ProductGraph {
  return {
    id: over.id ?? 'prod-1',
    handle: over.handle ?? 'tee',
    title: over.title ?? 'Tee',
    description: over.description ?? 'A nice tee',
    options: over.options ?? [
      { id: 'opt-color', title: 'Color', values: [{ id: 'val-red', value: 'Red' }] },
    ],
    variants: over.variants ?? [
      {
        id: 'var-1',
        title: 'Red',
        sku: 'TEE-RED',
        barcode: null,
        options: [{ optionId: 'opt-color', optionValueId: 'val-red' }],
      },
    ],
  } as unknown as ProductGraph;
}

describe('toProductDTO (commerce graph -> ProductDTO)', () => {
  it('projects the typed graph (options + values + variants + matrix), NOT a flat CMS row', () => {
    const graph = makeGraph({
      variants: [
        { id: 'var-1', title: 'Red', sku: 'TEE-RED', barcode: 'BC-1', options: [{ optionId: 'opt-color', optionValueId: 'val-red' }] },
        { id: 'var-2', title: 'Blue', sku: 'TEE-BLUE', barcode: null, options: [{ optionId: 'opt-color', optionValueId: 'val-blue' }] },
      ],
    });
    const dto = toProductDTO(
      graph,
      new Map([
        ['var-1', 1999],
        ['var-2', 2499],
      ]),
    );

    // The rich typed shape, not a flat { id, values: {col: val} } CMS Row.
    expect(dto.handle).toBe('tee');
    expect(dto.options[0]).toEqual({ id: 'opt-color', title: 'Color', values: [{ id: 'val-red', value: 'Red' }] });
    expect(dto.variants).toHaveLength(2);
    expect(dto.variants[0]).toEqual({
      id: 'var-1',
      title: 'Red',
      sku: 'TEE-RED',
      barcode: 'BC-1',
      resolvedPriceCents: 1999,
      options: [{ optionId: 'opt-color', optionValueId: 'val-red' }],
    });
    // The validator accepts the projection.
    expect(() => productDTOSchema.parse(dto)).not.toThrow();
  });

  it('product-level resolvedPriceCents is the LOWEST non-null variant price (a "from" price)', () => {
    const graph = makeGraph({
      variants: [
        { id: 'var-1', title: null, sku: null, barcode: null, options: [] },
        { id: 'var-2', title: null, sku: null, barcode: null, options: [] },
      ],
    });
    const dto = toProductDTO(graph, new Map([
      ['var-1', 2499],
      ['var-2', 1999],
    ]));
    expect(dto.resolvedPriceCents).toBe(1999);
  });

  it('surfaces a missing price honestly as null (never fabricated as 0)', () => {
    const graph = makeGraph({
      variants: [{ id: 'var-1', title: null, sku: null, barcode: null, options: [] }],
    });
    const dto = toProductDTO(graph, new Map([['var-1', null]]));
    expect(dto.variants[0].resolvedPriceCents).toBeNull();
    expect(dto.resolvedPriceCents).toBeNull();
    expect(() => productDTOSchema.parse(dto)).not.toThrow();
  });

  it('zod rejects a malformed product DTO (a float price is not integer cents)', () => {
    const graph = makeGraph();
    const dto = toProductDTO(graph, new Map([['var-1', 1999]]));
    const broken = { ...dto, resolvedPriceCents: 19.99 };
    expect(() => productDTOSchema.parse(broken)).toThrow();
  });
});

describe('toAvailabilityDTO (advisory-only marker)', () => {
  it('always stamps advisoryOnly: true', () => {
    const dto = toAvailabilityDTO({ variantId: 'var-1', locationId: 'loc-1', availableQuantity: 7 });
    expect(dto).toEqual({ variantId: 'var-1', locationId: 'loc-1', availableQuantity: 7, advisoryOnly: true });
    expect(() => availabilityDTOSchema.parse(dto)).not.toThrow();
  });

  it('zod rejects an availability DTO that is not marked advisory-only', () => {
    const notAdvisory = { variantId: 'var-1', locationId: 'loc-1', availableQuantity: 7, advisoryOnly: false };
    expect(() => availabilityDTOSchema.parse(notAdvisory)).toThrow();
  });

  it('zod rejects a non-integer available quantity', () => {
    const fractional = { variantId: 'var-1', locationId: 'loc-1', availableQuantity: 7.5, advisoryOnly: true };
    expect(() => availabilityDTOSchema.parse(fractional)).toThrow();
  });
});

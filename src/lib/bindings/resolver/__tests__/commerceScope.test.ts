// @vitest-environment node
//
// Track C commerce scope frames resolve through the SAME mustache parser +
// scope chain + lookup machinery as the CMS frames. These assertions exercise
// product / variant / variant.price (folded) / availability resolution and the
// never-throw-on-miss contract, under the Track A vitest node-env project.
import { describe, it, expect } from 'vitest';
import { parseExpression, evaluateExpression } from '../expression';
import {
  createScope,
  pushProductFrame,
  pushVariantFrame,
  pushAvailabilityFrame,
  pushRowFrame,
  lookup,
} from '../scope';
import type {
  AvailabilityDTO,
  PriceDTO,
  ProductDTO,
  ProductVariantDTO,
} from '@/lib/commerce/types';

const product: ProductDTO = {
  id: 'prod_1',
  handle: 'classic-tee',
  title: 'Classic Tee',
  description: 'A soft cotton tee.',
  taxClass: 'standard',
  options: [],
  variantIds: ['var_1'],
};

const variant: ProductVariantDTO = {
  id: 'var_1',
  productId: 'prod_1',
  title: 'Small',
  sku: 'TEE-S',
  optionValues: [],
};

const price: PriceDTO = {
  variantId: 'var_1',
  amountCents: 2500,
  currency: 'EUR',
};

const availability: AvailabilityDTO = {
  variantId: 'var_1',
  locationId: 'all',
  availableQuantity: 12,
  stale: false,
};

describe('commerce frame resolution via lookup', () => {
  it('resolves product.<field> against the innermost product frame', () => {
    const scope = pushProductFrame(createScope(), product);
    expect(lookup(scope, ['product', 'title'])).toBe('Classic Tee');
    expect(lookup(scope, ['product', 'handle'])).toBe('classic-tee');
    expect(lookup(scope, ['product', 'description'])).toBe('A soft cotton tee.');
  });

  it('resolves variant.<field> against the innermost variant frame', () => {
    const scope = pushVariantFrame(createScope(), variant);
    expect(lookup(scope, ['variant', 'sku'])).toBe('TEE-S');
    expect(lookup(scope, ['variant', 'title'])).toBe('Small');
    expect(lookup(scope, ['variant', 'id'])).toBe('var_1');
  });

  it('resolves variant.price.<field> against the folded price', () => {
    const scope = pushVariantFrame(createScope(), variant, price);
    expect(lookup(scope, ['variant', 'price', 'amountCents'])).toBe(2500);
    expect(lookup(scope, ['variant', 'price', 'currency'])).toBe('EUR');
    // The bare `variant.price` path yields the whole folded PriceDTO.
    expect(lookup(scope, ['variant', 'price'])).toEqual(price);
  });

  it('resolves availability.<field> against the advisory availability frame', () => {
    const scope = pushAvailabilityFrame(createScope(), availability);
    expect(lookup(scope, ['availability', 'availableQuantity'])).toBe(12);
    expect(lookup(scope, ['availability', 'stale'])).toBe(false);
    expect(lookup(scope, ['availability', 'locationId'])).toBe('all');
  });

  it('resolves the innermost matching frame when nested', () => {
    const outer: ProductDTO = { ...product, title: 'Outer Tee' };
    const inner: ProductDTO = { ...product, title: 'Inner Tee' };
    const scope = pushProductFrame(pushProductFrame(createScope(), outer), inner);
    expect(lookup(scope, ['product', 'title'])).toBe('Inner Tee');
  });

  it('composes commerce frames with one another and with CMS frames', () => {
    const row = { id: 'r1', values: { title: 'Row Title' } };
    const scope = pushAvailabilityFrame(
      pushVariantFrame(
        pushProductFrame(pushRowFrame(createScope(), row), product),
        variant,
        price,
      ),
      availability,
    );
    expect(lookup(scope, ['product', 'title'])).toBe('Classic Tee');
    expect(lookup(scope, ['variant', 'sku'])).toBe('TEE-S');
    expect(lookup(scope, ['variant', 'price', 'amountCents'])).toBe(2500);
    expect(lookup(scope, ['availability', 'availableQuantity'])).toBe(12);
    // Single-segment sugar still resolves against the row frame.
    expect(lookup(scope, ['title'])).toBe('Row Title');
  });
});

describe('commerce frame resolution never throws on a miss', () => {
  it('returns undefined for an unknown field on a present frame', () => {
    const scope = pushAvailabilityFrame(
      pushVariantFrame(pushProductFrame(createScope(), product), variant, price),
      availability,
    );
    expect(lookup(scope, ['product', 'nope'])).toBeUndefined();
    expect(lookup(scope, ['variant', 'nope'])).toBeUndefined();
    expect(lookup(scope, ['variant', 'price', 'nope'])).toBeUndefined();
    expect(lookup(scope, ['availability', 'nope'])).toBeUndefined();
  });

  it('returns undefined when the required frame is absent', () => {
    const scope = createScope();
    expect(lookup(scope, ['product', 'title'])).toBeUndefined();
    expect(lookup(scope, ['variant', 'sku'])).toBeUndefined();
    expect(lookup(scope, ['variant', 'price', 'amountCents'])).toBeUndefined();
    expect(lookup(scope, ['availability', 'availableQuantity'])).toBeUndefined();
  });

  it('returns undefined for variant.price.* when no price was folded in', () => {
    const scope = pushVariantFrame(createScope(), variant);
    expect(lookup(scope, ['variant', 'price', 'amountCents'])).toBeUndefined();
    expect(lookup(scope, ['variant', 'price'])).toBeUndefined();
  });

  it('returns undefined for a deep path that bottoms out early', () => {
    const scope = pushVariantFrame(createScope(), variant, price);
    expect(lookup(scope, ['variant', 'sku', 'length'])).toBeUndefined();
    expect(
      lookup(scope, ['variant', 'price', 'amountCents', 'toFixed']),
    ).toBeUndefined();
  });
});

describe('commerce frames resolve through evaluateExpression', () => {
  it('evaluates mustache expressions against the commerce scope chain', () => {
    const scope = pushAvailabilityFrame(
      pushVariantFrame(pushProductFrame(createScope(), product), variant, price),
      availability,
    );
    expect(evaluateExpression(parseExpression('{{product.title}}')!, scope)).toBe(
      'Classic Tee',
    );
    expect(evaluateExpression(parseExpression('{{variant.sku}}')!, scope)).toBe(
      'TEE-S',
    );
    expect(
      evaluateExpression(parseExpression('{{variant.price.amountCents}}')!, scope),
    ).toBe(2500);
    expect(
      evaluateExpression(
        parseExpression('{{availability.availableQuantity}}')!,
        scope,
      ),
    ).toBe(12);
  });

  it('returns undefined (never throws) for a missing commerce binding', () => {
    const scope = pushProductFrame(createScope(), product);
    expect(
      evaluateExpression(parseExpression('{{variant.sku}}')!, scope),
    ).toBeUndefined();
  });
});

// A placed reusable component inside a part a visitor presses (docs/plans/2026-11-02-designable-shop-controls.md,
// slice 3): the refusal reads its definition through the reader it is given, ends
// on a definition that places itself or a ring of definitions placing each other
// (refusing nothing such a ring does not hold), and misplacesShopPart reads it the
// same way shopPartRefusal does.
import { describe, it, expect } from 'vitest';
import { INTERACTIVE_SHOP_PART_MESSAGE, SHOP_PART_ATTR, misplacesShopPart, shopPartRefusal } from '../parts';
import { PLACEMENT_TYPE } from '@/lib/components/placement';

const placement = (component: string) => ({ type: PLACEMENT_TYPE, props: { component } });
/** The ancestors of a node dropped into a choice, nearest first. */
const inChoice = [
  { props: { [SHOP_PART_ATTR]: 'variant.value' } },
  { props: { [SHOP_PART_ATTR]: 'variant.option' } },
  { props: { [SHOP_PART_ATTR]: 'variant.options' } },
  { props: { 'data-component-kind': 'variant-selector' } },
];

describe('a placement whose definitions place themselves', () => {
  it('ends on a definition placing itself, and refuses nothing it does not hold', () => {
    const trees: Record<string, unknown> = {
      self: { type: 'div', props: {}, children: [{ type: 'span', props: {} }, placement('self')] },
    };
    const read = (id: string) => trees[id];
    expect(shopPartRefusal(placement('self'), inChoice, read)).toBeUndefined();
    expect(misplacesShopPart(placement('self'), inChoice, read)).toBe(false);
  });

  it('ends on two definitions placing each other, and refuses nothing they do not hold', () => {
    const trees: Record<string, unknown> = {
      a: { type: 'div', props: {}, children: [placement('b')] },
      b: { type: 'span', props: {}, children: [placement('a')] },
    };
    const read = (id: string) => trees[id];
    expect(shopPartRefusal(placement('a'), inChoice, read)).toBeUndefined();
    expect(shopPartRefusal(placement('b'), inChoice, read)).toBeUndefined();
  });

  it('still refuses a ring that holds a link somewhere in it', () => {
    const trees: Record<string, unknown> = {
      a: { type: 'div', props: {}, children: [placement('b')] },
      b: { type: 'div', props: {}, children: [placement('a'), { type: 'a', props: { href: '/terms' } }] },
    };
    expect(shopPartRefusal(placement('a'), inChoice, (id) => trees[id])).toBe(INTERACTIVE_SHOP_PART_MESSAGE);
  });
});

describe('misplacesShopPart', () => {
  it('reads a placed definition when given the reader, as shopPartRefusal does', () => {
    const trees: Record<string, unknown> = { withButton: { type: 'div', props: {}, children: [{ type: 'button', props: {} }] } };
    const read = (id: string) => trees[id];
    expect(misplacesShopPart(placement('withButton'), inChoice, read)).toBe(true);
    expect(shopPartRefusal(placement('withButton'), inChoice, read)).toBe(INTERACTIVE_SHOP_PART_MESSAGE);
    // Without a reader a placement holds nothing it can see.
    expect(misplacesShopPart(placement('withButton'), inChoice)).toBe(false);
  });
});

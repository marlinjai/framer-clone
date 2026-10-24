// Validation of the review's patch operations: unknown ids, disallowed keys,
// responsive writes, text rules, removals and the tells a patch may not add.

import { describe, expect, it } from 'vitest';
import { indexReviewTree, validateReviewOps } from '../ops';
import type { ReviewTreeNode } from '../protocol';

const PHOTO = 'https://images.unsplash.com/photo-1?w=1600';

const tree: ReviewTreeNode = {
  id: 'root',
  type: 'div',
  props: { style: { display: 'flex' } },
  children: [
    {
      id: 'hero',
      type: 'section',
      props: { style: { backgroundImage: { base: `linear-gradient(rgba(0, 0, 0, 0.3), rgba(0, 0, 0, 0.3)), url("${PHOTO}")` } } },
      children: [
        { id: 'h1', type: 'h1', props: { children: 'Ride further', style: { fontSize: '72px' } }, children: [] },
        {
          id: 'card',
          type: 'div',
          props: {},
          children: [{ id: 'cta', type: 'a', props: { children: 'Book a service', href: '#book' }, children: [] }],
        },
      ],
    },
  ],
};

const ctx = () => ({ breakpointKeys: ['desktop', 'tablet', 'phone'], nodes: indexReviewTree(tree) });
const style = (over: Record<string, unknown>) => ({ op: 'update_style', nodeId: 'h1', breakpoint: null, property: 'fontSize', value: '56px', reason: 'r', ...over });

describe('validateReviewOps', () => {
  it('accepts a base write and a phone override, normalizing the largest breakpoint to null', () => {
    const { ops, rejected } = validateReviewOps(
      [style({}), style({ breakpoint: 'PHONE', value: '40px' }), style({ breakpoint: 'desktop', value: '60px' })],
      ctx(),
    );
    expect(rejected).toEqual([]);
    expect(ops.map((o) => (o.op === 'update_style' ? o.breakpoint : 'x'))).toEqual([null, 'phone', null]);
  });

  it('converts kebab-case keys and keeps numbers and null (remove the value)', () => {
    const { ops } = validateReviewOps(
      [style({ property: 'line-height', value: 1.05 }), style({ property: 'maxWidth', value: null, breakpoint: 'tablet' })],
      ctx(),
    );
    expect(ops).toMatchObject([
      { property: 'lineHeight', value: 1.05 },
      { property: 'maxWidth', value: null, breakpoint: 'tablet' },
    ]);
  });

  it('refuses unknown nodes, unknown keys, unknown breakpoints and unknown operations', () => {
    const { ops, rejected } = validateReviewOps(
      [
        style({ nodeId: 'ghost' }),
        style({ property: 'onClick' }),
        style({ property: 'webkitTextStroke' }),
        style({ breakpoint: 'watch' }),
        { op: 'move_node', nodeId: 'h1', reason: 'r' },
        'not an object',
      ],
      ctx(),
    );
    expect(ops).toEqual([]);
    expect(rejected.map((r) => r.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(rejected[0].reason).toMatch(/unknown node id/);
    expect(rejected[1].reason).toMatch(/not supported/);
    expect(rejected[3].reason).toMatch(/unknown breakpoint/);
    expect(rejected[4].reason).toMatch(/unknown operation/);
  });

  it('refuses unsafe and breakout values with the generator rules', () => {
    const { rejected } = validateReviewOps(
      [
        style({ value: 'red;position:fixed' }),
        style({ property: 'background', value: 'url(javascript:alert(1))' }),
        style({ value: 'x'.repeat(800) }),
        style({ value: { nested: true } }),
      ],
      ctx(),
    );
    expect(rejected).toHaveLength(4);
  });

  it('allows a url() only when the node already holds that exact photo', () => {
    const scrim = `linear-gradient(rgba(0, 0, 0, 0.6), rgba(0, 0, 0, 0.6)), url("${PHOTO}")`;
    const ok = validateReviewOps([style({ nodeId: 'hero', property: 'backgroundImage', value: scrim })], ctx());
    expect(ok.rejected).toEqual([]);
    const swapped = validateReviewOps(
      [style({ nodeId: 'hero', property: 'backgroundImage', value: 'url("https://images.unsplash.com/other")' })],
      ctx(),
    );
    expect(swapped.rejected[0].reason).toMatch(/never adds pictures/);
    const elsewhere = validateReviewOps([style({ nodeId: 'card', property: 'backgroundImage', value: `url("${PHOTO}")` })], ctx());
    expect(elsewhere.rejected).toHaveLength(1);
  });

  it('refuses the tells a single value can introduce', () => {
    const { rejected } = validateReviewOps(
      [
        style({ property: 'fontFamily', value: '"Inter", sans-serif' }),
        style({ property: 'fontFamily', value: 'Space Grotesk' }),
        style({ nodeId: 'card', property: 'backdropFilter', value: 'blur(12px)' }),
        style({ nodeId: 'card', property: 'backgroundImage', value: 'radial-gradient(circle, #a855f7, transparent)' }),
      ],
      ctx(),
    );
    expect(rejected).toHaveLength(4);
    // Turning glass OFF is fine.
    expect(validateReviewOps([style({ nodeId: 'card', property: 'backdropFilter', value: 'none' })], ctx()).rejected).toEqual([]);
  });

  it('edits text only on plain-text nodes, without long dashes, emoji or markup', () => {
    const { ops, rejected } = validateReviewOps(
      [
        { op: 'update_text', nodeId: 'h1', text: '  Ride   further, longer ', reason: 'shorter' },
        { op: 'update_text', nodeId: 'card', text: 'x', reason: 'r' },
        { op: 'update_text', nodeId: 'h1', text: 'Ride \u2014 further', reason: 'r' },
        { op: 'update_text', nodeId: 'h1', text: 'Ride \u{1F6B2}', reason: 'r' },
        { op: 'update_text', nodeId: 'h1', text: '<b>Ride</b>', reason: 'r' },
        { op: 'update_text', nodeId: 'h1', text: '   ', reason: 'r' },
      ],
      ctx(),
    );
    expect(ops).toEqual([{ op: 'update_text', nodeId: 'h1', text: 'Ride further, longer', reason: 'shorter' }]);
    expect(rejected.map((r) => r.index)).toEqual([1, 2, 3, 4, 5]);
  });

  it('removes at most three nodes, never the root, and refuses later ops inside a removed node', () => {
    const { ops, rejected } = validateReviewOps(
      [
        { op: 'remove_node', nodeId: 'root', reason: 'r' },
        { op: 'remove_node', nodeId: 'card', reason: 'r' },
        style({ nodeId: 'cta', property: 'padding', value: '12px' }),
      ],
      ctx(),
    );
    expect(ops.map((o) => o.op)).toEqual(['remove_node']);
    expect(rejected.map((r) => r.reason)).toEqual(['the page root cannot be removed', 'the node was removed by an earlier operation']);
  });

  it('caps the number of operations and of removals', () => {
    const many = Array.from({ length: 45 }, () => style({}));
    expect(validateReviewOps(many, ctx()).ops).toHaveLength(40);
    const flat: ReviewTreeNode = {
      id: 'root',
      type: 'div',
      props: {},
      children: ['a', 'b', 'c', 'd'].map((id) => ({ id, type: 'div', props: {}, children: [] })),
    };
    const removals = validateReviewOps(
      ['a', 'b', 'c', 'd'].map((nodeId) => ({ op: 'remove_node', nodeId, reason: 'r' })),
      { breakpointKeys: ['desktop'], nodes: indexReviewTree(flat) },
    );
    expect(removals.ops).toHaveLength(3);
    expect(removals.rejected[0].reason).toMatch(/more than 3 removals/);
  });

  it('refuses a non-list', () => {
    expect(validateReviewOps({ op: 'update_text' }, ctx()).rejected[0].reason).toBe('ops must be a list');
  });
});

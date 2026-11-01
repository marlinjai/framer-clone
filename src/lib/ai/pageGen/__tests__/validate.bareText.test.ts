// Text the browser would move out of an element is dropped with a warning. No
// such tag is in the generator's list today (a table tag becomes a div), so the
// list is swapped here: this holds the rule for the day those tags are allowed.
import { describe, it, expect, vi } from 'vitest';
import { validateGeneration } from '../validate';

vi.mock('@/lib/renderer/textNode', async (original) => ({
  ...(await original<typeof import('@/lib/renderer/textNode')>()),
  refusesBareText: (type: string) => type === 'section',
}));

const breakpoints = [{ key: 'desktop', label: 'Desktop', minWidth: 1280 }];

describe('validateGeneration: bare text in an element that refuses it', () => {
  it('drops the text, keeps the elements, and says so', () => {
    let next = 0;
    const out = validateGeneration(
      {
        nodes: [
          {
            type: 'section',
            props: { children: 'stray lead' },
            children: [
              { type: '#text', props: { children: 'stray' } },
              { type: 'p', children: [{ type: '#text', props: { children: 'kept' } }, { type: 'strong', props: { children: 'b' } }] },
            ],
          },
        ],
      },
      { breakpoints, newId: () => `id${++next}` },
    );
    if (!out.ok) throw new Error(out.errors.join('; '));
    const section = out.result.nodes[0];
    expect(section.children.map((c) => c.type)).toEqual(['p']);
    expect(section.children[0].children[0].type).toBe('#text');
    expect(out.result.warnings.filter((w) => w.includes('cannot sit directly inside <section>'))).toHaveLength(2);
  });
});

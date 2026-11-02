import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractBreakpoints } from '@/lib/renderer/server/snapshotToComponentNode';
import { parseComponents } from '../definition';
import { COMPONENT_LIMITS, isComponentPlaceholderType, isMissingType, isPlacementType, serializedBytes } from '../placement';

const ID = '2f6c1a9e-0000-4000-8000-000000000001';

const stored = (extra: Record<string, unknown> = {}, id = ID) => ({
  id,
  name: 'Card',
  page: { appComponentTree: { id: 'c-root', type: 'div', props: {} } },
  inputs: [],
  states: [],
  ...extra,
});

const reasonFor = (definition: unknown, id = ID) => parseComponents({ [id]: definition }).refused[0]?.reason;

describe('parseComponents', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps a definition and gives it frames', () => {
    const { definitions, refused } = parseComponents({ [ID]: stored() });
    expect(refused).toEqual([]);
    expect(definitions[ID].name).toBe('Card');
    expect(extractBreakpoints(definitions[ID].page.canvasNodes)).toHaveLength(3);
  });

  it('gives the same frames on every read', () => {
    const read = () => extractBreakpoints(parseComponents({ [ID]: stored() }).definitions[ID].page.canvasNodes);
    expect(read()).toEqual(read());
  });

  it('survives a JSON round trip unchanged', () => {
    const definition = stored({
      description: 'A card',
      inputs: [{ id: 'title', name: 'Title', type: 'text', default: 'Hello' }],
      states: [{ id: 'hover', name: 'Hover', kind: 'hover' }],
    });
    const again = JSON.parse(JSON.stringify(definition)) as unknown;
    expect(parseComponents({ [ID]: again })).toEqual(parseComponents({ [ID]: definition }));
  });

  it('defaults absent inputs and states', () => {
    const bare = stored({ inputs: undefined, states: undefined });
    expect(parseComponents({ [ID]: bare }).definitions[ID]).toMatchObject({ inputs: [], states: [] });
  });

  it('takes anything that is not an object as no definitions', () => {
    for (const raw of [null, undefined, 3, 'x', []]) {
      expect(parseComponents(raw)).toEqual({ definitions: {}, refused: [] });
    }
  });

  it('skips a bad definition and keeps the others, and warns', () => {
    const good = '2f6c1a9e-0000-4000-8000-000000000002';
    const { definitions, refused } = parseComponents({ [ID]: null, [good]: stored({}, good) });
    expect(Object.keys(definitions)).toEqual([good]);
    expect(refused).toEqual([{ id: ID, reason: 'a definition is an object' }]);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  describe('ids', () => {
    it('refuses a definition id a selector could not carry', () => {
      for (const id of ['fc-abc', 'FC-abc', 'a b', 'a"b', 'a_b', '']) {
        expect(reasonFor(stored({}, id), id)).toMatch(/definition id/);
      }
    });

    it('refuses a definition stored under another key', () => {
      expect(reasonFor(stored({ id: 'other' }))).toMatch(/its own id/);
    });

    it('refuses a state id a selector could not carry', () => {
      for (const id of ['fc-x', 'fc_x', 'a"b', 'a b', '']) {
        expect(reasonFor(stored({ states: [{ id, name: 'S', kind: 'custom' }] }))).toMatch(/state id/);
      }
    });

    it('refuses listing primary, which is implied', () => {
      expect(reasonFor(stored({ states: [{ id: 'primary', name: 'P', kind: 'custom' }] }))).toMatch(/primary/);
    });

    it('refuses a repeated input or state id', () => {
      const input = { id: 'a', name: 'A', type: 'text' };
      expect(reasonFor(stored({ inputs: [input, input] }))).toMatch(/twice/);
      const state = { id: 's1', name: 'S', kind: 'custom' };
      expect(reasonFor(stored({ states: [state, state] }))).toMatch(/twice/);
    });
  });

  describe('structure', () => {
    const withRoot = (tree: unknown) => stored({ page: { appComponentTree: tree } });

    it('refuses a root with no element of its own', () => {
      expect(reasonFor(withRoot({ id: 'r', type: '#component', props: {} }))).toMatch(/element/);
      expect(reasonFor(withRoot({ id: 'r', type: '#text', props: {} }))).toMatch(/element/);
      expect(reasonFor(withRoot({ id: 'r', props: {} }))).toMatch(/type/);
      expect(reasonFor(withRoot(null))).toMatch(/tree/);
      expect(reasonFor(stored({ page: null }))).toMatch(/page/);
    });

    it('refuses a sticky bar anywhere in the tree', () => {
      const bar = { id: 'b', type: 'div', props: { 'data-sticky-cta': 'bar' } };
      expect(reasonFor(withRoot(bar))).toMatch(/sticky/);
      expect(reasonFor(withRoot({ id: 'r', type: 'div', children: [{ id: 'w', type: 'div', children: [bar] }] }))).toMatch(/sticky/);
    });

    it('refuses a noScriptState naming no state', () => {
      expect(reasonFor(stored({ noScriptState: 's1' }))).toMatch(/noScriptState/);
      expect(parseComponents({ [ID]: stored({
        noScriptState: 's1',
        states: [{ id: 's1', name: 'Open', kind: 'custom' }],
      }) }).refused).toEqual([]);
    });

    it('refuses a broken field', () => {
      expect(reasonFor(stored({ name: '' }))).toMatch(/name/);
      expect(reasonFor(stored({ description: 3 }))).toMatch(/description/);
      expect(reasonFor(stored({ inputs: 'x' }))).toMatch(/list/);
      expect(reasonFor(stored({ states: 'x' }))).toMatch(/list/);
      expect(reasonFor(stored({ inputs: [{ id: 'a', name: 'A', type: 'font' }] }))).toMatch(/unknown type/);
      expect(reasonFor(stored({ states: [{ id: 's', name: 'S', kind: 'visited' }] }))).toMatch(/unknown kind/);
      expect(reasonFor(stored({ states: [{ id: 's', name: '', kind: 'custom' }] }))).toMatch(/no name/);
      expect(reasonFor(stored({ states: [{ id: 's', name: 'S', kind: 'custom', implies: 'hover' }] }))).toMatch(/implies/);
      expect(reasonFor(stored({ states: [{ id: 's', name: 'S', kind: 'custom', x: '1' }] }))).toMatch(/numbers/);
      expect(reasonFor(stored({ states: [null] }))).toMatch(/object/);
    });
  });

  describe('limits', () => {
    it('refuses a definition over the size limit, in bytes', () => {
      const multibyte = 'ä'.repeat(COMPONENT_LIMITS.definitionBytes / 2 + 1);
      const huge = stored({ page: { appComponentTree: { id: 'r', type: 'div', props: { children: multibyte } } } });
      expect(reasonFor(huge)).toMatch(/bytes/);
    });

    it('refuses too many inputs or states', () => {
      const inputs = Array.from({ length: COMPONENT_LIMITS.inputsPerDefinition + 1 }, (_, i) => ({ id: `i${i}`, name: 'I', type: 'text' }));
      expect(reasonFor(stored({ inputs }))).toMatch(/inputs/);
      const states = Array.from({ length: COMPONENT_LIMITS.statesPerDefinition + 1 }, (_, i) => ({ id: `s${i}`, name: 'S', kind: 'custom' }));
      expect(reasonFor(stored({ states }))).toMatch(/states/);
    });

    it('ignores the definitions past the site limit', () => {
      const raw = Object.fromEntries(
        Array.from({ length: COMPONENT_LIMITS.definitionsPerSite + 2 }, (_, i) => [`d${i}`, stored({}, `d${i}`)]),
      );
      const { definitions, refused } = parseComponents(raw);
      expect(Object.keys(definitions)).toHaveLength(COMPONENT_LIMITS.definitionsPerSite);
      expect(refused).toHaveLength(2);
      expect(refused[0].reason).toMatch(/at most 200/);
    });
  });
});

describe('serializedBytes', () => {
  it('counts bytes, not characters', () => {
    expect(serializedBytes('ä')).toBe(4);
    expect(serializedBytes(undefined)).toBe(0);
  });
});

describe('placement types', () => {
  it('tells the two reserved types apart from a tag', () => {
    expect(isPlacementType('#component')).toBe(true);
    expect(isPlacementType('div')).toBe(false);
    expect(isMissingType('#missing')).toBe(true);
    expect(isMissingType('#component')).toBe(false);
    expect(isComponentPlaceholderType('#component')).toBe(true);
    expect(isComponentPlaceholderType('#missing')).toBe(true);
    expect(isComponentPlaceholderType('#text')).toBe(false);
    expect(isComponentPlaceholderType('div')).toBe(false);
  });
});

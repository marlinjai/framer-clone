// src/lib/ai/serializers/__tests__/registry.test.ts

import { describe, it, expect } from 'vitest';

import { serializeRegistry } from '../registry';
import { stableStringify } from '../normalize';
import { COMPONENT_REGISTRY } from '@/lib/componentRegistry';

describe('serializeRegistry', () => {
  it('produces stable output across consecutive calls', () => {
    const a = stableStringify(serializeRegistry());
    const b = stableStringify(serializeRegistry());
    expect(a).toBe(b);
  });

  it('emits one entry per registry item', () => {
    const out = serializeRegistry();
    expect(out.length).toBe(Object.keys(COMPONENT_REGISTRY).length);
  });

  it('sorts entries alphabetically by type', () => {
    const types = serializeRegistry().map((e) => e.type);
    const sorted = [...types].sort();
    expect(types).toEqual(sorted);
  });

  it('marks the image entry as void / does-not-accept-children', () => {
    const out = serializeRegistry();
    const image = out.find((e) => e.type === 'image');
    expect(image).toBeDefined();
    expect(image!.acceptsChildren).toBe(false);
  });

  it('marks container-like entries as accepting children', () => {
    const out = serializeRegistry();
    const container = out.find((e) => e.type === 'container');
    expect(container).toBeDefined();
    expect(container!.acceptsChildren).toBe(true);
  });

  it('uses the registry label as description', () => {
    const out = serializeRegistry();
    for (const e of out) {
      expect(e.description).toBe(COMPONENT_REGISTRY[e.type].label);
    }
  });

  it('object keys inside each entry are sorted', () => {
    const out = serializeRegistry();
    for (const entry of out) {
      expect(Object.keys(entry)).toEqual(
        ['acceptsChildren', 'defaults', 'description', 'type'],
      );
    }
  });
});

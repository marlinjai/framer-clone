// @vitest-environment node
// A source may not set what the code reads as an instruction, and a stored rule may not read
// it, so a `data-` name the code starts to read fails here until someone has judged it:
// refused in `isPlatformAttribute`, or listed below as an author's own.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSelector } from '@/lib/rules/rules';
import { isPlatformAttribute, isPlatformMarker } from '../platformAttributes';

const SOURCE = path.resolve(__dirname, '../../..');

/** Names the code reads that mean nothing to it as an instruction, each with its reason. */
const AUTHORS_OWN: Readonly<Record<string, string>> = {
  'data-testid': 'read by tests only, and every component library writes it',
  'data-x': 'the example in a comment',
};

/** `[data-x`, `getAttribute('data-x')` and their kin: the ways code here reads an attribute. */
const READS = /(?:\[|Attribute\(\s*['"`]|closest\(\s*['"`]\[?)(data-[a-z][a-z0-9-]*)/g;
const DATASET = /\bdataset\.([a-zA-Z]+)/g;

const kebab = (name: string) => `data-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;

/** Where the drop resolver names what it reads as constants, which no read above shows. */
const MARKERS = path.join(SOURCE, 'lib/drag/markers.ts');

function namesRead(): Set<string> {
  const names = new Set<string>();
  for (const [, name] of readFileSync(MARKERS, 'utf8').matchAll(/['"`](data-[a-z][a-z0-9-]*)['"`]/g)) names.add(name);
  for (const entry of readdirSync(SOURCE, { recursive: true, encoding: 'utf8' })) {
    if (!/\.tsx?$/.test(entry) || entry.includes('__tests__') || entry.startsWith('lib/reactImport')) continue;
    const text = readFileSync(path.join(SOURCE, entry), 'utf8');
    for (const [, name] of text.matchAll(READS)) names.add(name);
    for (const [, name] of text.matchAll(DATASET)) names.add(kebab(name));
  }
  return names;
}

describe('attributes the code reads', () => {
  const names = namesRead();

  it('finds them', () => {
    expect(names.size).toBeGreaterThan(30);
    expect(names).toContain('data-editor-ui');
    expect(names).toContain('data-text-node-row');
    expect(names).toContain('data-placement-root');
  });

  it('has a decision for every name', () => {
    expect([...names].filter((name) => !isPlatformAttribute(name) && !Object.hasOwn(AUTHORS_OWN, name)).sort()).toEqual([]);
  });

  it('refuses nothing it has called an author own', () => {
    expect(Object.keys(AUTHORS_OWN).filter(isPlatformAttribute)).toEqual([]);
  });

  it('keeps every one out of a stored rule, but the family rules are meant to read', () => {
    const readable = [...names].filter((name) => parseSelector(`&:is([${name}] *)`).ok);
    expect(readable.filter((name) => !Object.hasOwn(AUTHORS_OWN, name) && !/^data-u-[vc]-/.test(name)).sort()).toEqual([]);
    expect(readable.filter((name) => /^data-u-/.test(name)).every((name) => !isPlatformMarker(name))).toBe(true);
  });

  it('refuses the runtime marks a published page alone carries, and keeps the stored families', () => {
    for (const name of ['data-u-on', 'data-u-active', 'DATA-U-ON']) expect(isPlatformMarker(name)).toBe(true);
    for (const name of ['data-u-v-variant', 'data-u-c-1a2b3c4d']) expect(isPlatformMarker(name)).toBe(false);
  });

  it('reads any case', () => {
    expect(isPlatformAttribute('DATA-EDITOR-UI')).toBe(true);
    expect(isPlatformAttribute('Data-Shown')).toBe(true);
  });

  it('leaves what shadcn and Radix write', () => {
    for (const name of ['data-slot', 'data-state', 'data-side', 'data-orientation', 'data-disabled', 'data-size', 'data-variant']) {
      expect(isPlatformAttribute(name)).toBe(false);
    }
  });
});

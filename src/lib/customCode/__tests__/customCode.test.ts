// The stored shape of a custom code block and the two switches the application
// reads (src/lib/customCode/customCode.ts). Every malformed shape is refused, and
// the kill switch reads exactly as the box reads it.

import { describe, expect, it } from 'vitest';
import {
  boxFrameSource,
  customCodePreviewHref,
  customCodeTrace,
  hasCustomCode,
  isCustomCodeServing,
  parseCustomCode,
  sandboxOriginFrom,
  sandboxOriginProblem,
  withoutCustomCodeProp,
} from '../customCode';
import { isKillSwitchOn } from '../../../../services/box/src/config';

const HASH = 'a'.repeat(64);

describe('parseCustomCode', () => {
  it('reads a block and a proposal', () => {
    expect(parseCustomCode({ sha256: HASH, title: 'Truck wash' })).toEqual({ ok: true, value: { kind: 'block', sha256: HASH, title: 'Truck wash' } });
    expect(parseCustomCode({ proposal: '0b9e2f4a-1c2d-4e5f-8a9b-0c1d2e3f4a5b', title: 'From import' })).toEqual({
      ok: true,
      value: { kind: 'proposal', proposal: '0b9e2f4a-1c2d-4e5f-8a9b-0c1d2e3f4a5b', title: 'From import' },
    });
  });

  it('folds white space in a title and keeps it otherwise as written', () => {
    const parsed = parseCustomCode({ sha256: HASH, title: '  A   scene\n behind <the> text ' });
    expect(parsed).toEqual({ ok: true, value: { kind: 'block', sha256: HASH, title: 'A scene behind <the> text' } });
  });

  const malformed: [string, unknown][] = [
    ['undefined', undefined],
    ['null', null],
    ['a string', HASH],
    ['a number', 1],
    ['an array', [HASH, 'title']],
    ['an empty object', {}],
    ['a hash alone', { sha256: HASH }],
    ['a title alone', { title: 'x' }],
    ['a hash in upper case', { sha256: 'A'.repeat(64), title: 'x' }],
    ['a hash of 63 characters', { sha256: 'a'.repeat(63), title: 'x' }],
    ['a hash of 65 characters', { sha256: 'a'.repeat(65), title: 'x' }],
    ['a hash with a non hex character', { sha256: `${'a'.repeat(63)}g`, title: 'x' }],
    ['a hash with white space around it', { sha256: ` ${HASH}`, title: 'x' }],
    ['a hash as a number', { sha256: 1234, title: 'x' }],
    ['a hash as an array', { sha256: [HASH], title: 'x' }],
    ['a hash that is a path', { sha256: `../box/${HASH}`, title: 'x' }],
    ['a block and a proposal', { sha256: HASH, proposal: 'p1', title: 'x' }],
    ['a block with src', { sha256: HASH, title: 'x', src: 'https://evil.example/' }],
    ['a block with srcdoc', { sha256: HASH, title: 'x', srcdoc: '<script>alert(1)</script>' }],
    ['a block whose second key is src', { sha256: HASH, src: 'https://evil.example/' }],
    ['a srcdoc and a title', { srcdoc: '<script>alert(1)</script>', title: 'x' }],
    ['a block without a title but with a declaration', { sha256: HASH, declaration: { sizing: 'fixed' } }],
    ['an empty title', { sha256: HASH, title: '' }],
    ['a title of spaces', { sha256: HASH, title: '   ' }],
    ['a title as a number', { sha256: HASH, title: 7 }],
    ['a title with a control character', { sha256: HASH, title: 'a\u0000b' }],
    ['a title with a line separator', { sha256: HASH, title: 'a b' }],
    ['a title too long', { sha256: HASH, title: 'x'.repeat(201) }],
    ['a proposal id with a slash', { proposal: 'a/b', title: 'x' }],
    ['a proposal id with markup', { proposal: '<b>', title: 'x' }],
    ['a proposal id too long', { proposal: 'p'.repeat(65), title: 'x' }],
    ['an empty proposal id', { proposal: '', title: 'x' }],
    ['a proposal id as a number', { proposal: 42, title: 'x' }],
    ['a proposal without a title', { proposal: 'p1', note: 'x' }],
    ['an object of another class', Object.assign(Object.create({ inherited: true }), { sha256: HASH, title: 'x' })],
    ['a date', new Date()],
  ];
  it.each(malformed)('refuses %s', (_name, value) => {
    const parsed = parseCustomCode(value);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBeTruthy();
  });

  it('accepts an object without a prototype, and reads each field once', () => {
    const bare = Object.assign(Object.create(null), { sha256: HASH, title: 'x' });
    expect(parseCustomCode(bare).ok).toBe(true);
    let reads = 0;
    const sly = {
      get sha256() {
        reads += 1;
        return reads === 1 ? HASH : 'not a hash';
      },
      title: 'x',
    };
    expect(parseCustomCode(sly)).toEqual({ ok: true, value: { kind: 'block', sha256: HASH, title: 'x' } });
    expect(reads).toBe(1);
  });
});

describe('the prop', () => {
  it('is found only as an own key of an object', () => {
    expect(hasCustomCode({ customCode: undefined })).toBe(true);
    expect(hasCustomCode({ customCode: 'x' })).toBe(true);
    expect(hasCustomCode({})).toBe(false);
    expect(hasCustomCode(Object.create({ customCode: {} }))).toBe(false);
    expect(hasCustomCode(null)).toBe(false);
    expect(hasCustomCode([])).toBe(false);
    expect(hasCustomCode('customCode')).toBe(false);
  });

  it('is taken off without changing the input', () => {
    const props = { id: 'a', customCode: { sha256: HASH, title: 'x' } };
    expect(withoutCustomCodeProp(props)).toEqual({ id: 'a' });
    expect(props.customCode).toBeDefined();
    const plain = { id: 'b' };
    expect(withoutCustomCodeProp(plain)).toBe(plain);
  });

  it('traces a block by the first 12 characters of its hash', () => {
    expect(customCodeTrace(`0123456789ab${'c'.repeat(52)}`)).toBe('0123456789ab');
  });

  it('links the tile to the page of the standalone preview', () => {
    expect(customCodePreviewHref('site 1', 'page/2')).toBe('/projects/site%201/preview?page=page%2F2');
    expect(customCodePreviewHref('s', null)).toBe('/projects/s/preview');
  });
});

describe('the kill switch, read as the box reads it (decision D16)', () => {
  const values = [undefined, '', '0', '1', 'false', 'true', ' 0', '0 ', '00', 'no', 'off', 'O'];
  it.each(values.map((v) => [String(v), v]))('agrees with the box for %s', (_name, value) => {
    expect(isCustomCodeServing(value)).toBe(!isKillSwitchOn({ CUSTOM_CODE_DISABLED: value }));
  });

  it('serves only for exactly 0', () => {
    expect(values.filter((v) => isCustomCodeServing(v))).toEqual(['0']);
  });
});

describe('the box origin (decision D37)', () => {
  it('is https and an exact host name, nothing else', () => {
    expect(sandboxOriginFrom('https://run.example.com')).toBe('https://run.example.com');
    for (const bad of [
      undefined,
      '',
      'run.example.com',
      'http://run.example.com',
      'https://run.example.com/',
      'https://run.example.com/box/',
      'https://run.example.com:8443',
      'https://*.example.com',
      'https://RUN.example.com',
      'https://run.example.com; script-src *',
      'https://run.example.com https://evil.example',
      'https://127.0.0.1',
      'https://localhost',
      ' https://run.example.com',
      'https://user@run.example.com',
    ]) {
      expect(sandboxOriginFrom(bad)).toBeNull();
    }
  });

  it('becomes the box path only when the kill switch is off and the origin is valid', () => {
    expect(boxFrameSource({ CUSTOM_CODE_DISABLED: '0', SANDBOX_ORIGIN: 'https://run.example.com' })).toBe('https://run.example.com/box/');
    expect(boxFrameSource({ CUSTOM_CODE_DISABLED: '1', SANDBOX_ORIGIN: 'https://run.example.com' })).toBeNull();
    expect(boxFrameSource({ SANDBOX_ORIGIN: 'https://run.example.com' })).toBeNull();
    expect(boxFrameSource({ CUSTOM_CODE_DISABLED: '0' })).toBeNull();
    expect(boxFrameSource({ CUSTOM_CODE_DISABLED: '0', SANDBOX_ORIGIN: 'https://run.example.com/x' })).toBeNull();
  });

  it('is reported at start when set but unusable, and not when unset', () => {
    expect(sandboxOriginProblem(undefined)).toBeNull();
    expect(sandboxOriginProblem('')).toBeNull();
    expect(sandboxOriginProblem('https://run.example.com')).toBeNull();
    expect(sandboxOriginProblem('run.example.com')).toMatch(/SANDBOX_ORIGIN/);
  });
});

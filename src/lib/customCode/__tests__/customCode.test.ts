// The stored shape of a custom code block and the two switches the application
// reads (src/lib/customCode/customCode.ts). Every malformed shape is refused, and
// the kill switch reads exactly as the box reads it.

import { describe, expect, it, vi } from 'vitest';
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
  withoutCustomCodeTree,
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
    ['a title with a line separator', { sha256: HASH, title: 'a\u2028b' }],
    ['a title with a right-to-left override', { sha256: HASH, title: 'scene\u202egpj.exe' }],
    ['a title with a first strong isolate', { sha256: HASH, title: 'a\u2068b\u2069' }],
    ['a title with a left-to-right mark', { sha256: HASH, title: 'a\u200eb' }],
    ['a title with a zero-width space', { sha256: HASH, title: 'a\u200bb' }],
    ['a title with a zero-width joiner', { sha256: HASH, title: 'a\u200db' }],
    ['a title with a word joiner', { sha256: HASH, title: 'a\u2060b' }],
    ['a title with a byte order mark', { sha256: HASH, title: '\ufeffscene' }],
    ['a title with an Arabic letter mark', { sha256: HASH, title: 'a\u061cb' }],
    ['a title with a lone high surrogate', { sha256: HASH, title: 'a\ud83db' }],
    ['a title ending in a lone high surrogate', { sha256: HASH, title: 'scene\ud83d' }],
    ['a title with a lone low surrogate', { sha256: HASH, title: 'a\ude00b' }],
    ['a title with a soft hyphen', { sha256: HASH, title: 'sce\u00adne' }],
    ['a title with an inhibit symmetric swapping mark', { sha256: HASH, title: 'a\u206ab' }],
    ['a title with a nominal digit shape mark', { sha256: HASH, title: 'a\u206fb' }],
    ['a title with an interlinear annotation anchor', { sha256: HASH, title: 'a\ufff9b\ufffac\ufffb' }],
    ['a title with a Mongolian vowel separator', { sha256: HASH, title: 'a\u180eb' }],
    ['a title with a combining grapheme joiner', { sha256: HASH, title: 'a\u034fb' }],
    ['a title with hidden tag characters', { sha256: HASH, title: `Scene${String.fromCodePoint(0xe0001, 0xe0069, 0xe0067, 0xe006e, 0xe007f)}` }],
    ['a title only of Hangul fillers', { sha256: HASH, title: '\u3164\u115f\u1160\uffa0' }],
    ['a title only of blank braille', { sha256: HASH, title: '\u2800\u2800' }],
    ['a title only of soft hyphens', { sha256: HASH, title: '\u00ad' }],
    ['a title with a Hangul filler beside letters', { sha256: HASH, title: 'scene\u3164' }],
    ['a title only of combining marks', { sha256: HASH, title: '\u0301\u0308' }],
    ['a title only of spaces of every width', { sha256: HASH, title: '\u2003\u3000\u00a0 ' }],
    ['a title hiding bytes in variation selectors', { sha256: HASH, title: `Map${String.fromCodePoint(0xfe00, 0xfe0a, 0xe0100, 0xe0142, 0xe01ef)}` }],
    ['a title with a variation selector after a letter', { sha256: HASH, title: 'Map\ufe00' }],
    ['a title with a supplementary variation selector', { sha256: HASH, title: `Map${String.fromCodePoint(0xe0100)}` }],
    ['a title with Mongolian free variation selectors', { sha256: HASH, title: 'a\u180b\u180c\u180db' }],
    ['a title with the fourth Mongolian selector', { sha256: HASH, title: 'a\u180fb' }],
    ['a title with an emoji presentation selector after a letter', { sha256: HASH, title: 'Map\ufe0f' }],
    ['a title with a text presentation selector after a letter', { sha256: HASH, title: 'Map\ufe0e' }],
    ['a title with two presentation selectors after a pictograph', { sha256: HASH, title: '\u2764\ufe0f\ufe0f' }],
    ['a title only of an object replacement character', { sha256: HASH, title: '\ufffc' }],
    ['a title with an object replacement character', { sha256: HASH, title: 'Scene \ufffc' }],
    ['a title with one more code point in a character than the cap', { sha256: HASH, title: `H${'\u0301'.repeat(10)}` }],
    ['a title with Khmer inherent vowels between letters', { sha256: HASH, title: 'M\u17b4a\u17b5p' }],
    ['a title with an unassigned default-ignorable code point', { sha256: HASH, title: `Map${String.fromCodePoint(0xe0080)}` }],
    ['a title with the last default-ignorable code point', { sha256: HASH, title: `Map${String.fromCodePoint(0xe0fff)}` }],
    ['a title with a Hangul filler', { sha256: HASH, title: 'Map\uffa0' }],
    ['a title with a zero-width joiner after a pictograph', { sha256: HASH, title: '\u2764\u200d' }],
    ['a title with 150 combining marks on one letter', { sha256: HASH, title: `H${'\u0301'.repeat(150)}` }],
    ['a proposal title with an override', { proposal: 'p1', title: '\u202dx' }],
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

  it('keeps a title in another script, a right-to-left one and a whole emoji', () => {
    for (const title of ['Waschanlage für LKW', 'מכונת שטיפה', 'غسيل الشاحنات', 'Scene \ud83d\ude9a', '\ud83d\ude9a', '\u2764\ufe0f', '한국어 장면', '+', 'Café\u0301']) {
      expect(parseCustomCode({ sha256: HASH, title })).toEqual({ ok: true, value: { kind: 'block', sha256: HASH, title } });
    }
  });

  it('keeps an emoji with its presentation selector, a keycap, and the marks real scripts stack', () => {
    const titles = [
      '\u2764\ufe0f Love',
      '\u2764\ufe0e',
      '\u260e\ufe0f Call us',
      '1\ufe0f\u20e3 First step',
      // Hebrew with points: shin, dagesh, shin dot, qamats on one letter.
      'שָּׁלוֹם',
      // Vietnamese written with combining marks: dot below and circumflex.
      'Vie\u0323\u0302t Nam',
      // Tibetan with subjoined letters and a vowel sign.
      'བསྒྲུབས',
      'ที่นี่',
      // Burmese: "hope" and "discount sale", four code points in a character.
      'မျှော်လင့်ချက်',
      'လျှော့ဈေး',
      // Pointed Hebrew with an accent and a meteg: five marks on the shin.
      '\u05e9\u05c1\u05bc\u05b8\u05a5\u05bdלוֹם',
      // Ten code points in one character: the most a title may hold.
      `H${'\u0301'.repeat(9)}`,
    ];
    for (const title of titles) expect(parseCustomCode({ sha256: HASH, title }), title).toEqual({ ok: true, value: { kind: 'block', sha256: HASH, title } });
  });

  it('caps a character by its marks where the runtime has no grapheme splitter', async () => {
    vi.resetModules();
    vi.stubGlobal('Intl', { ...Intl, Segmenter: undefined });
    try {
      const fresh = await import('../customCode');
      expect(fresh.parseCustomCode({ sha256: HASH, title: 'မျှော်လင့်ချက်' }).ok).toBe(true);
      expect(fresh.parseCustomCode({ sha256: HASH, title: `H${'\u0301'.repeat(9)}` }).ok).toBe(true);
      expect(fresh.parseCustomCode({ sha256: HASH, title: `H${'\u0301'.repeat(10)}` }).ok).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
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

describe('withoutCustomCodeTree', () => {
  it('drops the value from a node and every descendant, and leaves the input untouched', () => {
    const tree = {
      type: 'div',
      props: { id: 'a', customCode: { sha256: 'x', title: 't' } },
      children: [{ type: 'p', props: { children: 'keep' } }, { type: 'div', props: { customCode: 1 }, children: [{ type: 'span', props: { customCode: 2 } }] }],
    };
    const out = withoutCustomCodeTree(tree);
    expect(JSON.stringify(out)).not.toContain('customCode');
    expect(out.children[0]).toBe(tree.children[0]);
    expect(out.props).toEqual({ id: 'a' });
    expect(JSON.stringify(tree)).toContain('customCode');
  });

  it('returns a tree without the value as it is', () => {
    const tree = { type: 'div', props: { id: 'a' }, children: [{ type: 'p', props: { children: 'x' } }] };
    expect(withoutCustomCodeTree(tree)).toBe(tree);
  });
});

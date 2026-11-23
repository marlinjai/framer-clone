// The pure rules of writing a custom code block (src/lib/customCode/authoring.ts): the switch,
// the input checks with their reasons, the declaration against the states in reach, and the
// sentence the panel shows. Plan docs/plans/2026-11-02-sandboxed-custom-code.md, slice C4.
import { describe, expect, it } from 'vitest';
import {
  checkCustomCodeInput,
  declarationStateRefusal,
  describeDeclaration,
  isCustomCodeAvailable,
  REFUSAL_STATUS,
  sizeInWords,
} from '../authoring';
import { BOX_LIMITS, customCodeHash, type CustomCodeDeclaration } from '../contract';

const DECLARATION: CustomCodeDeclaration = { reads: ['open'], writes: ['step'], emits: ['custom:done'], sizing: 'fixed', interactive: true };

describe('isCustomCodeAvailable (D99)', () => {
  it('is on for exactly 1 and off for everything else', () => {
    expect(isCustomCodeAvailable('1')).toBe(true);
    for (const value of [undefined, null, '', '0', 'true', 'TRUE', 'yes', ' 1', '1 ', '01', 1, true]) {
      expect(isCustomCodeAvailable(value)).toBe(false);
    }
  });
});

describe('checkCustomCodeInput', () => {
  const ok = { title: '  A   clock ', document: '<p>tick</p>', declaration: DECLARATION };

  it('returns the folded title, the code as typed and the canonical declaration', () => {
    const result = checkCustomCodeInput({ ...ok, declaration: { ...DECLARATION, reads: ['open', 'open'] } });
    expect(result).toEqual({
      ok: true,
      value: { title: 'A clock', document: '<p>tick</p>', declaration: DECLARATION, bytes: expect.any(Number) },
    });
  });

  it.each([
    ['title_invalid', { ...ok, title: '' }],
    ['title_invalid', { ...ok, title: 'x'.repeat(201) }],
    ['title_invalid', { ...ok, title: 'a​b' }],
    ['title_invalid', { ...ok, title: 7 }],
    ['document_empty', { ...ok, document: '' }],
    ['document_empty', { ...ok, document: '   \t\n' }],
    ['document_empty', { ...ok, document: null }],
    ['document_nul', { ...ok, document: '<p>\u0000</p>' }],
    ['document_not_well_formed', { ...ok, document: '\udc00' }],
    ['declaration_invalid', { ...ok, declaration: null }],
    ['declaration_invalid', { ...ok, declaration: { ...DECLARATION, sizing: 'auto' } }],
    ['declaration_invalid', { ...ok, declaration: { ...DECLARATION, emits: ['done'] } }],
  ] as const)('refuses with %s and a sentence', (code, input) => {
    const result = checkCustomCodeInput(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe(code);
    expect(result.refusal.status).toBe(REFUSAL_STATUS[code]);
    expect(result.refusal.message.length).toBeGreaterThan(20);
  });

  it('counts code and declaration together in UTF-8 bytes against 256 KB', () => {
    const declarationBytes = JSON.stringify({ emits: [], interactive: true, reads: [], sizing: 'fixed', writes: [] }).length;
    const plain = { title: 'Big', declaration: { sizing: 'fixed', interactive: true } };
    const fits = checkCustomCodeInput({ ...plain, document: 'x'.repeat(BOX_LIMITS.documentBytes - declarationBytes) });
    expect(fits.ok && fits.value.bytes).toBe(BOX_LIMITS.documentBytes);
    const over = checkCustomCodeInput({ ...plain, document: 'x'.repeat(BOX_LIMITS.documentBytes - declarationBytes + 1) });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.refusal).toMatchObject({ code: 'too_large', status: 413 });
    // A two-byte character counts twice.
    const umlauts = checkCustomCodeInput({ ...plain, document: 'ä'.repeat(BOX_LIMITS.documentBytes / 2) });
    expect(umlauts.ok).toBe(false);
  });
});

describe('the hash covers the declaration', () => {
  it('a changed declaration is a new hash; the same one in another order is not', async () => {
    const base = await customCodeHash('<p>x</p>', DECLARATION);
    expect(await customCodeHash('<p>x</p>', { ...DECLARATION, interactive: false })).not.toBe(base);
    expect(await customCodeHash('<p>x</p>', { ...DECLARATION, sizing: 'content' })).not.toBe(base);
    expect(await customCodeHash('<p>x</p>', { ...DECLARATION, reads: [] })).not.toBe(base);
    expect(await customCodeHash('<p>x</p>', { ...DECLARATION, writes: ['open', 'step'] })).not.toBe(base);
    expect(await customCodeHash('<p>x</p>', { ...DECLARATION, emits: [] })).not.toBe(base);
    expect(await customCodeHash('<p>x</p>', { emits: ['custom:done'], writes: ['step'], reads: ['open'], interactive: true, sizing: 'fixed' })).toBe(base);
  });
});

describe('declarationStateRefusal', () => {
  const reach = [
    { id: 'open', name: 'Open', type: 'boolean' as const },
    { id: 'step', name: 'Step', type: 'number' as const },
    { id: 'tab', name: 'Tab', type: 'choice' as const },
    { id: 'label', name: 'Label', type: 'text' as const },
  ];

  it('takes reads and writes of boolean, number and choice values in reach', () => {
    expect(declarationStateRefusal({ ...DECLARATION, reads: ['open', 'tab'], writes: ['step'] }, reach)).toBeNull();
  });

  it('refuses a value out of reach and a text value, naming each', () => {
    const gone = declarationStateRefusal({ ...DECLARATION, reads: ['gone'] }, reach);
    expect(gone).toMatchObject({ code: 'declaration_state', status: 422 });
    expect(gone?.message).toContain('gone');
    const text = declarationStateRefusal({ ...DECLARATION, writes: ['label'] }, reach);
    expect(text?.message).toContain('"Label"');
    expect(text?.message).toContain('writes');
  });

  it('reads the nearest declaration of an id, as the runtime does', () => {
    const shadowed = [{ id: 'x', name: 'Outer', type: 'boolean' as const }, { id: 'x', name: 'Inner', type: 'text' as const }];
    expect(declarationStateRefusal({ ...DECLARATION, reads: ['x'], writes: [] }, shadowed)?.message).toContain('Inner');
    expect(declarationStateRefusal({ ...DECLARATION, reads: ['x'], writes: [] }, [...shadowed].reverse())).toBeNull();
  });
});

describe('describeDeclaration and sizeInWords', () => {
  it('says what the code may do in one plain paragraph', () => {
    const names: Record<string, string> = { open: 'Menu open', step: 'Step' };
    const text = describeDeclaration(DECLARATION, (id) => names[id] ?? id);
    expect(text).toContain('It can read "Menu open"');
    expect(text).toContain('it can change "Step"');
    expect(text).toContain('it can fire "done"');
    expect(text).toContain('Visitors can click into it');
    expect(describeDeclaration({ reads: [], writes: [], emits: [], sizing: 'content', interactive: false }, (id) => id))
      .toBe('It reads no value of the page, it changes none, and it fires no event. Its height follows its content, up to 10,000 pixels. Clicks and the keyboard pass through it to the page. It never reaches the page itself, cookies or the network.');
  });

  it('writes sizes a person reads', () => {
    expect(sizeInWords(512)).toBe('512 bytes');
    expect(sizeInWords(256 * 1024)).toBe('256 KB');
    expect(sizeInWords(1024 * 1024)).toBe('1 MB');
  });
});

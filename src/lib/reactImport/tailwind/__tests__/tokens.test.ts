// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { createImportBudget } from '../../budget';
import { reachedTokens, readStylesheet } from '../tokens';
import { GLOBALS_CSS } from './button';

const read = (text: string) => readStylesheet(text, 'n', createImportBudget());
const details = (text: string) => read(text).lines.map((line) => line.detail);

describe('readStylesheet', () => {
  it('reads a shadcn sheet: tokens, the dark class variant and the base', () => {
    const sheet = read(GLOBALS_CSS);
    expect(sheet.root.get('--border')).toBe('oklch(0.92 0.004 286.32)');
    expect(sheet.dark.get('--border')).toBe('oklch(1 0 0 / 10%)');
    expect(sheet.theme.get('--color-primary')).toBe('var(--primary)');
    expect(sheet.darkClass).toBe(true);
    expect(sheet.baseCandidates).toEqual(['border-border', 'outline-ring/50', 'bg-background', 'text-foreground']);
    expect(sheet.hasBorderBase).toBe(true);
  });

  it('refuses token names that would reset the theme', () => {
    const sheet = read('@theme { --*: initial; --color-*: initial; --Color-x: red; --ok: 1px; }');
    expect([...sheet.theme.keys()]).toEqual(['--ok']);
    expect(sheet.lines.map((line) => [line.kind, line.disposition, line.detail])).toEqual(Array(3).fill(['token', 'left', 'tokenName']));
  });

  it('refuses token values the rule parser refuses', () => {
    const sheet = read(':root { --a: url(https://evil.test/x.png); --b: expression(alert(1)); --c: red !important; --d: 1px; }');
    expect([...sheet.root.keys()]).toEqual(['--d']);
    expect(sheet.lines.filter((line) => line.detail === 'tokenValue')).toHaveLength(3);
  });

  it('never follows an import, a plugin, a config or a source, and says so', () => {
    expect(details('@import "https://evil.test/x.css"; @import "./local.css"; @import "tailwindcss";')).toEqual(['sheetImport', 'sheetImport']);
    expect(details('@plugin "evil"; @config "./tailwind.config.js"; @source "../"; @utility x { color: red; } @layer components { .a {} }')).toEqual(Array(5).fill('sheetAtRule'));
  });

  it('leaves plain rules to the stylesheet layer, blocking until they are read', () => {
    expect(read('.card { color: red; }').lines).toEqual([{ kind: 'css-rule', disposition: 'left', detail: 'sheetRule', next: ['accept', 'rewrite'], nodeKey: 'n', line: 1 }]);
  });

  it('reads only *, html and body from the base, as data', () => {
    const sheet = read('@layer base { * { border-color: var(--line); } h1 { color: red; } }');
    expect(sheet.hasBorderBase).toBe(true);
    expect([...sheet.baseTokens]).toEqual(['--line']);
    expect(sheet.lines.map((line) => line.detail)).toEqual(['sheetRule']);
  });

  it('says once that base styles stay with the page, and not for border and outline colours the tokens reproduce', () => {
    expect(read(GLOBALS_CSS).lines.filter((line) => line.detail === 'basePage')).toHaveLength(1);
    expect(details('@layer base { * { @apply border-border outline-ring/50; } }')).toEqual([]);
    expect(details('@layer base { * { @apply border-border antialiased; } }')).toEqual(['basePage']);
  });

  it('turns a sheet that does not parse into a line', () => {
    expect(details(':root { --a: 1px;')).toEqual(['sheetSyntax']);
  });

  it('reads a large hostile sheet in linear time, paying the budget', () => {
    const started = Date.now();
    const sheet = read(`:root { ${Array.from({ length: 20_000 }, (_, i) => `--t${i}: ${i}px;`).join(' ')} }`);
    expect(sheet.root.size).toBe(20_000);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(() => read('.a{}'.repeat(200_000))).toThrow(/budget/);
  });
});

describe('reachedTokens', () => {
  it('follows tokens through each other once, and skips the renamed Tailwind ones', () => {
    const values = new Map([['--a', 'var(--b)'], ['--b', 'var(--a) var(--tw-x)'], ['--c', '1px']]);
    expect([...reachedTokens(['--a'], values, createImportBudget())].sort()).toEqual(['--a', '--b']);
  });
});

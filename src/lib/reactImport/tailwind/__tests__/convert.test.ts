// @vitest-environment node
// Layer 2 end to end, on the real compiler, the real `tailwind-merge` and the real rule parser.

import { describe, expect, it } from 'vitest';
import { MAX_RULES_PER_NODE, isDefinitionRule, parseRule, readRules, type SelectorRule, type StoredRule } from '@/lib/rules/rules';
import { HOVER_GATE } from '@/lib/rules/states';
import { IMPORT_LIMITS, createImportBudget } from '../../budget';
import { convertClasses, type ElementClasses, type TailwindInput, type TailwindResult, type VariantTable } from '..';
import { BUTTON_TABLE, GLOBALS_CSS } from './button';

const words = (text: string) => text.split(/\s+/).filter(Boolean);

function convert(elements: ElementClasses[], options: Partial<TailwindInput> = {}): Promise<TailwindResult> {
  return convertClasses({ elements, rootKey: elements[0]?.key ?? 'n', budget: createImportBudget(), ...options });
}

const one = async (classes: string, options: Partial<TailwindInput> = {}) => {
  const result = await convert([{ key: 'n', classes: words(classes) }], options);
  return { result, node: result.nodes.get('n') ?? {} };
};

const selectorRules = (rules: readonly StoredRule[] = []): SelectorRule[] => rules.filter((rule): rule is SelectorRule => !isDefinitionRule(rule));
const details = (result: TailwindResult) => result.lines.map((line) => line.detail);
const linesFor = (result: TailwindResult, detail: string) => result.lines.filter((line) => line.detail === detail);

describe('the repo button, as the contract probed it', () => {
  const button = () => convert([{ key: 'b', table: BUTTON_TABLE, merged: true }], { stylesheet: GLOBALS_CSS });

  it('fits the cap with every rule and definition through the real parser', async () => {
    const result = await button();
    const node = result.nodes.get('b') ?? {};
    const rules = node.rules ?? [];
    expect(selectorRules(rules)).toHaveLength(42);
    expect(rules.filter(isDefinitionRule)).toHaveLength(11);
    expect(rules.length).toBeLessThanOrEqual(MAX_RULES_PER_NODE);
    expect(rules.every((rule) => parseRule(rule).ok)).toBe(true);
    expect(readRules({ rules }).refused).toEqual([]);
    expect(linesFor(result, 'refusedRule')).toEqual([]);
    expect(linesFor(result, 'classNoOutput')).toEqual([]);
  });

  it('writes the base-reached tokens no utility names', async () => {
    const style = (await button()).nodes.get('b')?.style ?? {};
    expect(style['--border']).toBe('oklch(0.92 0.004 286.32)');
    expect(style['--ring']).toBe('oklch(0.543 0.179 276.7)');
  });

  it('lets the destructive focus ring beat the base one, which tailwind-merge removes in the original', async () => {
    const rules = selectorRules((await button()).nodes.get('b')?.rules);
    const base = rules.findIndex((rule) => rule.selector === '&:focus-visible');
    const destructive = rules.findIndex((rule) => rule.selector === '&:where([data-u-v-variant="destructive"]):focus-visible');
    expect(rules[base].style['--u-tw-ring-color']).toBe('color-mix(in oklab, var(--ring) 50%, transparent)');
    expect(destructive).toBeGreaterThan(base);
  });

  it('keeps Tailwind order when no cn wraps the table, where the destructive ring sorts first', async () => {
    const result = await convert([{ key: 'b', table: BUTTON_TABLE }], { stylesheet: GLOBALS_CSS });
    const rules = selectorRules(result.nodes.get('b')?.rules);
    const ringOf = (selector: string) => rules.findIndex((rule) => rule.selector === selector && '--u-tw-ring-color' in rule.style);
    expect(ringOf('&:where([data-u-v-variant="destructive"]):focus-visible')).toBeLessThan(ringOf('&:focus-visible'));
  });
});

describe('order', () => {
  it('follows Tailwind output, not the class string, with no cn', async () => {
    const { node } = await one('px-4 px-2');
    expect(node.style?.paddingInline).toBe('calc(var(--spacing) * 4)');
  });

  it('runs the real tailwind-merge first under cn, and says what it removed', async () => {
    const result = await convert([{ key: 'n', classes: ['px-4', 'px-2'], merged: true }]);
    expect(result.nodes.get('n')?.style?.paddingInline).toBe('calc(var(--spacing) * 2)');
    expect(linesFor(result, 'classMerged')).toMatchObject([{ disposition: 'converted', source: 'px-4' }]);
  });

  it('guards a displaced entry that order cannot beat, because the selectors differ', async () => {
    const table = { base: ['focus:hover:bg-red-500'], keys: [{ key: 'tone', values: { cool: ['hover:focus:bg-blue-500'] } }] };
    const rules = selectorRules((await convert([{ key: 'n', table, merged: true }])).nodes.get('n')?.rules);
    expect(rules.map((rule) => rule.selector)).toEqual([
      '&:where(:not([data-u-v-tone="cool"])):focus:hover',
      '&:where([data-u-v-tone="cool"]):hover:focus',
    ]);
  });

  it('adds no guard where a later layer shares the selector and wins by order', async () => {
    const table = { base: ['px-4'], keys: [{ key: 'size', values: { sm: ['px-2'] } }] };
    const node = (await convert([{ key: 'n', table, merged: true }])).nodes.get('n') ?? {};
    expect(node.style?.paddingInline).toBe('calc(var(--spacing) * 4)');
    expect(selectorRules(node.rules)).toMatchObject([{ selector: '&:where([data-u-v-size="sm"])', style: { paddingInline: 'calc(var(--spacing) * 2)' } }]);
  });

  it('lets two keys that conflict follow call order', async () => {
    const table: VariantTable = { base: [], keys: [{ key: 'size', values: { sm: ['px-2'] } }, { key: 'density', values: { loose: ['px-8'] } }] };
    const rules = selectorRules((await convert([{ key: 'n', table, merged: true }])).nodes.get('n')?.rules);
    expect(rules.map((rule) => rule.selector)).toEqual(['&:where([data-u-v-size="sm"])', '&:where([data-u-v-density="loose"])']);
  });

  it('puts compound variants last, on both attributes', async () => {
    const table: VariantTable = {
      base: [],
      keys: [{ key: 'variant', values: { outline: ['px-2'] } }, { key: 'size', values: { lg: ['px-4'] } }],
      compound: [{ when: { variant: 'outline', size: 'lg' }, classes: ['px-6'] }],
    };
    const rules = selectorRules((await convert([{ key: 'n', table, merged: true }])).nodes.get('n')?.rules);
    expect(rules.at(-1)?.selector).toBe('&:where([data-u-v-variant="outline"][data-u-v-size="lg"])');
  });

  it('refuses a key or value no attribute can hold', async () => {
    const table = { base: [], keys: [{ key: 'tone', values: { 'a"b': ['p-1'] } }] };
    const result = await convert([{ key: 'n', table, merged: true }]);
    expect(linesFor(result, 'classTable')).toMatchObject([{ disposition: 'left', nodeKey: 'n' }]);
  });

  it('merges a rule back across others that set nothing it sets', async () => {
    const { node } = await one('hover:bg-red-500 focus:p-1 hover:text-white');
    expect(selectorRules(node.rules).map((rule) => rule.selector)).toEqual(['&:hover', '&:focus']);
  });
});

describe('the rewrite table', () => {
  it('drops the color-mix wrapper and keeps the inner value', async () => {
    const { node } = await one('hover:bg-red-500/90');
    expect(selectorRules(node.rules)).toEqual([
      { id: 'r1', selector: '&:hover', at: [HOVER_GATE], style: { backgroundColor: 'color-mix(in oklab, var(--color-red-500) 90%, transparent)' } },
    ]);
  });

  it('puts hover: behind the Hover state gate, with a line', async () => {
    const { node, result } = await one('hover:p-2');
    expect(selectorRules(node.rules)[0]).toMatchObject({ selector: '&:hover', at: [HOVER_GATE] });
    expect(linesFor(result, 'hoverGate')).toMatchObject([{ disposition: 'adapted' }]);
  });

  it('keeps focus-visible, active and focus as they are', async () => {
    const { node } = await one('focus-visible:p-1 active:p-2 focus:p-3');
    expect(selectorRules(node.rules).map((rule) => rule.selector)).toEqual(['&:focus', '&:focus-visible', '&:active']);
  });

  it('steps space-y and *: out to forms the parser takes', async () => {
    const { node } = await one('space-y-4 *:p-2 **:m-1');
    const selectors = selectorRules(node.rules).map((rule) => rule.selector);
    expect(selectors).toContain('& > :where(:not(:last-child))');
    expect(selectors).toContain('& > *');
    expect(selectors).toContain('& *');
  });

  it('says so only where a child really sets the margin space-y now outweighs', async () => {
    const result = await convert([
      { key: 'p', classes: ['space-y-4'] },
      { key: 'a', parent: 'p', classes: ['mb-8'] },
      { key: 'b', parent: 'p', classes: ['p-2'] },
    ]);
    expect(linesFor(result, 'raisedWeight')).toMatchObject([{ nodeKey: 'a' }]);
  });

  it('renames --tw- in keys, values and definitions', async () => {
    const { node } = await one('shadow-xs');
    expect(node.style?.['--u-tw-shadow']).toBeDefined();
    expect(JSON.stringify(node)).not.toContain('--tw-');
    expect((node.rules ?? []).filter(isDefinitionRule).map((rule) => rule.define)).toContain('@property --u-tw-shadow');
  });

  it('stores keyframes under u- names and rewrites what plays them', async () => {
    const { node } = await one('animate-spin');
    expect(node.style?.animation).toBe('var(--animate-spin)');
    expect(node.style?.['--animate-spin']).toBe('u-spin 1s linear infinite');
    expect((node.rules ?? []).filter(isDefinitionRule).map((rule) => rule.define)).toEqual(['@keyframes u-spin']);
  });

  it('plays the tw-animate keyframes under u-tw- names', async () => {
    const { node } = await one('animate-in fade-in-0');
    expect(String(node.style?.animation)).toMatch(/^u-tw-enter /);
    expect((node.rules ?? []).filter(isDefinitionRule).map((rule) => rule.define)).toContain('@keyframes u-tw-enter');
  });

  it('stores a max- breakpoint alone as written, and the parser swaps it', async () => {
    const { node } = await one('max-sm:p-3');
    expect(selectorRules(node.rules)[0]).toMatchObject({ selector: '&', at: ['@media (width < 40rem)'] });
    expect(parseRule(selectorRules(node.rules)[0]).ok).toBe(true);
  });

  it('refuses what the parser refuses, with its reason, and keeps the rest', async () => {
    const { node, result } = await one('in-[.x]:p-1 p-2');
    expect(node.style?.padding).toBe('calc(var(--spacing) * 2)');
    expect(linesFor(result, 'refusedRule')).toMatchObject([{ disposition: 'left', source: 'in-[.x]:p-1', reason: 'every part of a selector starts with &' }]);
  });

  it('refuses !important, which the canvas would write twice', async () => {
    const { node, result } = await one('!p-1 p-2!');
    expect(node.style).toBeUndefined();
    expect(linesFor(result, 'refusedRule')).toHaveLength(2);
  });
});

describe('classes that selectors read', () => {
  it('rewrites named groups and peers in class and selector', async () => {
    const result = await convert([
      { key: 'g', classes: ['group/item'] },
      { key: 'c', parent: 'g', classes: ['group-hover/item:p-1', 'peer-checked/label:p-2'] },
      { key: 'l', parent: 'g', classes: ['peer/label'] },
    ]);
    expect(result.nodes.get('g')?.className).toBe('u-c-group_sitem');
    expect(result.nodes.get('l')?.className).toBe('u-c-peer_slabel');
    const rules = selectorRules(result.nodes.get('c')?.rules);
    expect(rules.map((rule) => rule.selector)).toEqual(['&:is(:where(.u-c-group_sitem):hover *)', '&:is(:where(.u-c-peer_slabel):checked ~ *)']);
    expect(rules.every((rule) => parseRule(rule).ok)).toBe(true);
  });

  it('keeps a child class a substring selector reads, under the prefix', async () => {
    const result = await convert([
      { key: 'b', classes: ["[&_svg:not([class*='size-'])]:size-4"] },
      { key: 'i', parent: 'b', classes: ['size-6'] },
    ]);
    expect(result.nodes.get('i')?.className).toBe('u-c-size-6');
    expect(result.nodes.get('i')?.style).toMatchObject({ width: 'calc(var(--spacing) * 6)' });
    expect(selectorRules(result.nodes.get('b')?.rules)[0].selector).toBe('& svg:not([class*="size-"])');
  });

  it('prefixes the operand of a ^= reader', async () => {
    const result = await convert([{ key: 'b', classes: ["[&_[class^='icon-']]:p-1"] }, { key: 'i', parent: 'b', classes: ['icon-x'] }]);
    expect(selectorRules(result.nodes.get('b')?.rules)[0].selector).toBe('& [class^="u-c-icon-"]');
    expect(result.nodes.get('i')?.className).toBe('u-c-icon-x');
  });

  it('refuses a reader of the whole attribute, or of the platform classes', async () => {
    for (const reader of ["[&_[class$='-x']]:p-1", "[&_[class='a']]:p-1", "[&_[class*='fc-']]:p-1", "[&_[class*='u-c']]:p-1"]) {
      const { result, node } = await one(reader);
      expect(node.rules).toBeUndefined();
      expect(linesFor(result, 'refusedRule')).toHaveLength(1);
    }
  });

  it('prefixes any class a selector names, so the editor own utilities stay out of reach', async () => {
    const result = await convert([{ key: 'p', classes: ['[&_.fixed]:p-1'] }, { key: 'c', parent: 'p', classes: ['fixed'] }]);
    expect(selectorRules(result.nodes.get('p')?.rules)[0].selector).toBe('& .u-c-fixed');
    expect(result.nodes.get('c')?.className).toBe('u-c-fixed');
  });

  it('keeps a named group and a class of the same spelling apart', async () => {
    const result = await convert([
      { key: 'g', classes: ['group/item'] },
      { key: 'h', classes: ['group-item'] },
      { key: 'c', parent: 'g', classes: ['group-hover/item:p-1', '[.group-item_&]:p-2', '[&_.group-item]:m-1'] },
    ]);
    expect(result.nodes.get('g')?.className).toBe('u-c-group_sitem');
    expect(result.nodes.get('h')?.className).toBe('u-c-group-item');
    expect(selectorRules(result.nodes.get('c')?.rules).map((rule) => rule.selector).sort()).toEqual(['& .u-c-group-item', '&:is(:where(.u-c-group_sitem):hover *)']);
  });

  it('encodes a reader operand as the class it reads is encoded', async () => {
    const result = await convert([{ key: 'b', classes: ["[&_[class*='a/b']]:p-1"] }, { key: 'i', parent: 'b', classes: ['xa/b'] }]);
    expect(selectorRules(result.nodes.get('b')?.rules)[0].selector).toBe('& [class*="a_sb"]');
    expect(result.nodes.get('i')?.className).toBe('u-c-xa_sb');
  });

  it('drops a marker nothing reads, with no line', async () => {
    const result = await convert([{ key: 'g', classes: ['group', 'p-1'] }]);
    expect(result.nodes.get('g')?.className).toBeUndefined();
    expect(linesFor(result, 'classNoOutput')).toEqual([]);
  });
});

describe('tokens', () => {
  const sheet = (root: string, more = '') => `@import "tailwindcss";\n@custom-variant dark (&:is(.dark *));\n@theme inline { --color-primary: var(--primary); --color-border: var(--border); }\n:root { ${root} }\n${more}`;

  it('writes a foreign theme onto the root, reached and base-reached alike', async () => {
    const { node } = await one('bg-primary', { stylesheet: sheet('--primary: oklch(0.5 0.2 300); --border: oklch(0.6 0.2 30); --ring: oklch(0.6 0.2 140); --unused: 1px;') });
    expect(node.style).toMatchObject({ '--primary': 'oklch(0.5 0.2 300)', '--border': 'oklch(0.6 0.2 30)', '--ring': 'oklch(0.6 0.2 140)', backgroundColor: 'var(--primary)' });
    expect(node.style).not.toHaveProperty('--unused');
  });

  it('follows tokens through each other, and stops at a cycle', async () => {
    const { node } = await one('bg-primary', { stylesheet: sheet('--primary: var(--brand); --brand: var(--primary);') });
    expect(node.style).toMatchObject({ '--primary': 'var(--brand)', '--brand': 'var(--primary)' });
  });

  it('writes .dark values as one rule on the root, and says the page never sets dark', async () => {
    const { node, result } = await one('bg-primary', { stylesheet: sheet('--primary: red;', '.dark { --primary: blue; }') });
    expect(selectorRules(node.rules)).toContainEqual({ id: 'dark', selector: '&:is(.dark *)', style: { '--primary': 'blue' } });
    expect(linesFor(result, 'darkClass')).toMatchObject([{ disposition: 'adapted', next: ['use-system-dark', 'accept'] }]);
  });

  it('says nothing of dark when no dark value or class reaches the import', async () => {
    const { result } = await one('p-1', { stylesheet: sheet('--primary: red;', '.dark { --primary: blue; }') });
    expect(linesFor(result, 'darkClass')).toEqual([]);
  });

  it('writes dark as the media query when the person chooses the system setting', async () => {
    const { node, result } = await one('dark:bg-primary', { stylesheet: sheet('--primary: red;', '.dark { --primary: blue; }'), systemDark: true });
    const rules = selectorRules(node.rules);
    expect(rules).toContainEqual({ id: 'r1', selector: '&', at: ['@media (prefers-color-scheme: dark)'], style: { backgroundColor: 'var(--primary)' } });
    expect(rules).toContainEqual({ id: 'dark', selector: '&', at: ['@media (prefers-color-scheme: dark)'], style: { '--primary': 'blue' } });
    expect(linesFor(result, 'darkClass')).toEqual([]);
  });

  it('gives dark: the media form, with no line, when the source has no class variant', async () => {
    const { node, result } = await one('dark:p-1');
    expect(selectorRules(node.rules)[0]).toMatchObject({ selector: '&', at: ['@media (prefers-color-scheme: dark)'] });
    expect(linesFor(result, 'darkClass')).toEqual([]);
  });

  it('refuses a token name that would reset the theme, and never compiles it', async () => {
    const { node, result } = await one('bg-red-500', { stylesheet: '@theme { --*: initial; --color-*: initial; }' });
    expect(node.style?.backgroundColor).toBe('var(--color-red-500)');
    expect(linesFor(result, 'tokenName')).toHaveLength(2);
  });

  it('refuses a token value with an external address, and never compiles it', async () => {
    const { result } = await one('bg-brand', { stylesheet: '@theme { --color-brand: url(https://evil.test/x.png); }' });
    expect(linesFor(result, 'tokenValue')).toMatchObject([{ disposition: 'left' }]);
    expect(linesFor(result, 'classNoOutput')).toMatchObject([{ source: 'bg-brand' }]);
  });

  it('says to add tokens when a class needs some and there are none', async () => {
    const { result } = await one('bg-primary');
    expect(linesFor(result, 'classNoOutput')).toMatchObject([{ disposition: 'left', next: ['add-tokens', 'accept', 'rewrite'], source: 'bg-primary' }]);
  });

  it('gives a bare border currentcolor when the source has no base rule for it', async () => {
    expect((await one('border')).node.style).toMatchObject({ borderColor: 'currentcolor', borderWidth: '1px' });
    expect((await one('border border-red-500')).node.style?.borderColor).toBe('var(--color-red-500)');
    expect((await one('border', { stylesheet: GLOBALS_CSS })).node.style?.borderColor).toBeUndefined();
  });

  it('reads the source base as data: body colours stay on the page, with a line', async () => {
    const { result } = await one('p-1', { stylesheet: sheet('--foreground: red;', '@layer base { body { @apply bg-background text-foreground; } }') });
    expect(linesFor(result, 'basePage')).toMatchObject([{ disposition: 'adapted' }]);
  });
});

describe('breakpoints', () => {
  it('maps a property only when the map is exact', async () => {
    expect((await one('p-2 md:p-4')).node.style?.padding).toEqual({ base: 'calc(var(--spacing) * 4)', mobile: 'calc(var(--spacing) * 2)' });
    const alone = await one('md:grid-cols-2');
    expect(alone.node.style).toBeUndefined();
    expect(selectorRules(alone.node.rules)[0]).toMatchObject({ selector: '&', at: ['@media (width >= 48rem)'] });
  });

  it('writes maps under the project frame ids it is given', async () => {
    const { node } = await one('p-2 md:p-4 xl:p-8', { breakpoints: { tablet: 'f-768', mobile: 'f-320' } });
    expect(node.style?.padding).toEqual({ base: 'calc(var(--spacing) * 8)', 'f-768': 'calc(var(--spacing) * 4)', 'f-320': 'calc(var(--spacing) * 2)' });
  });

  it('says what a map cannot follow, once per import', async () => {
    const { result } = await one('p-2 md:p-4 lg:m-1');
    expect(linesFor(result, 'breakpointRem')).toHaveLength(1);
    expect(linesFor(result, 'breakpointFrames')).toHaveLength(1);
  });
});

describe('what the class string costs and holds', () => {
  it('reports a class Tailwind makes nothing of', async () => {
    const { result } = await one('not-a-class p-1');
    expect(linesFor(result, 'classNoOutput')).toMatchObject([{ disposition: 'left', nodeKey: 'n', source: 'not-a-class' }]);
  });

  it('reports a class string only known when the component runs', async () => {
    const result = await convert([{ key: 'n', classes: ['p-1'], dynamic: true }]);
    expect(linesFor(result, 'classDynamic')).toMatchObject([{ kind: 'class-unknown', disposition: 'left' }]);
  });

  it('keeps an external address in Normal for a person to accept, and refuses it in a rule', async () => {
    const plain = await one('bg-[url(https://evil.test/x.png)]');
    expect(plain.node.style?.backgroundImage).toBe('url(https://evil.test/x.png)');
    expect(linesFor(plain.result, 'styleExternal')).toMatchObject([{ kind: 'external-address', disposition: 'adapted', next: ['accept'] }]);
    const hovered = await one('hover:bg-[url(https://evil.test/x.png)]');
    expect(hovered.node.rules).toBeUndefined();
    expect(linesFor(hovered.result, 'refusedRule')).toHaveLength(1);
  });

  it('refuses addresses spelled to hide, rather than keeping them', async () => {
    for (const candidate of ['bg-[url(\\68ttp://evil.test/a.png)]', 'bg-[image-set("http://evil.test/b.png"_1x)]', '[--u:url(https://evil.test/c.png)]']) {
      const { node, result } = await one(candidate);
      const values = Object.values(node.style ?? {}).map(String);
      const kept = values.some((value) => value.includes('evil.test'));
      expect(kept ? linesFor(result, 'styleExternal').length : linesFor(result, 'refusedRule').length + linesFor(result, 'classNoOutput').length).toBeGreaterThan(0);
      expect(values.filter((value) => value.includes('\\'))).toEqual([]);
    }
  });

  it('gives hostile candidates no output or a refused rule', async () => {
    const { node } = await one('[color:red;}@import"https://evil.test/x.css"] [--x:1}body{display:none] [@import_"https://evil.test/x.css"]:p-1');
    expect(JSON.stringify(node)).not.toMatch(/@import|body\{/);
  });

  it('refuses stacked negations before the compile, where they exhaust memory', async () => {
    // The first three are the review's: each passes the negation count on its own, and the variant count too.
    const payloads = ['not-hover:'.repeat(24) + 'p-1', 'not-has-hover:'.repeat(20) + 'p-1', 'not-group-hover:'.repeat(16) + 'p-1', 'not-hover:not-hover:not-hover:p-1', `${'hover:'.repeat(9)}p-1`];
    const started = Date.now();
    const result = await convert([{ key: 'n', classes: [...payloads, 'p-2'] }]);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.nodes.get('n')?.style).toEqual({ '--spacing': '0.25rem', padding: 'calc(var(--spacing) * 2)' });
    expect(result.lines.filter((line) => line.kind === 'cap').map((line) => [line.detail, line.source])).toEqual([
      ['overVariants', payloads[0]], ['overVariants', payloads[1]], ['overVariants', payloads[2]], ['overNegations', payloads[3]], ['overVariants', payloads[4]],
    ]);
  });

  it('refuses three negations in few variants, and compiles two', async () => {
    expect(linesFor((await one('not-hover:has-[a]:not-focus:p-1')).result, 'overNegations')).toHaveLength(1);
    const two = await one('not-has-hover:p-1');
    expect(linesFor(two.result, 'overNegations')).toEqual([]);
    expect(two.node.rules?.length).toBeGreaterThan(0);
  });

  it('still compiles what real classes stack', async () => {
    const { node, result } = await one('not-hover:not-focus:p-1 dark:md:hover:focus-visible:aria-invalid:p-2 group-has-[>svg]:p-3');
    expect(result.lines.filter((line) => line.kind === 'cap')).toEqual([]);
    // `not-hover:` writes two: the selector, and the query for a device with no hover.
    expect(selectorRules(node.rules)).toHaveLength(4);
  });

  it('refuses behavior and -moz-binding, which the sheet refuses by name', async () => {
    const { node, result } = await one('[behavior:url(x.htc)] [-moz-binding:url(x.xml#b)] p-1');
    expect(node.style).toEqual({ '--spacing': '0.25rem', padding: 'calc(var(--spacing) * 1)' });
    expect(linesFor(result, 'refusedRule')).toHaveLength(2);
  });

  it('stores no rules on a node over the cap, and says so', async () => {
    const classes = Array.from({ length: MAX_RULES_PER_NODE + 1 }, (_, i) => `data-[k${i}]:p-1`);
    const result = await convert([{ key: 'n', classes }]);
    expect(result.nodes.get('n')?.rules).toBeUndefined();
    expect(linesFor(result, 'overRules')).toMatchObject([{ kind: 'cap', disposition: 'left', nodeKey: 'n' }]);
  });

  it('stops over the candidate cap before compiling', async () => {
    const classes = Array.from({ length: IMPORT_LIMITS.candidates + 1 }, (_, i) => `p-[${i}px]`);
    const result = await convert([{ key: 'n', classes }]);
    expect(result.nodes.size).toBe(0);
    expect(details(result)).toEqual(['overCandidates']);
  });

  it('compiles the cap of long arbitrary candidates in bounded time', async () => {
    const classes = Array.from({ length: IMPORT_LIMITS.candidates }, (_, i) => `[--k${i}:${'a'.repeat(200)}]`);
    const started = Date.now();
    const result = await convert([{ key: 'n', classes }]);
    expect(Date.now() - started).toBeLessThan(15_000);
    // 800 kilobytes of values is inside the evaluated budget, so they land, one custom property each.
    expect(Object.keys(result.nodes.get('n')?.style ?? {})).toHaveLength(IMPORT_LIMITS.candidates);
  }, 30_000);

  it('charges the budget per class written, so many elements cannot repeat a class for free', async () => {
    const elements = Array.from({ length: 5_000 }, (_, i) => ({ key: `n${i}`, classes: Array.from({ length: 30 }, () => 'p-1') }));
    await expect(convert(elements)).rejects.toMatchObject({ name: 'BudgetExceeded' });
  });
});

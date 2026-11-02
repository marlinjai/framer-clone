// A rule on `:root`: the one rule that is not about a node. Only the page root holds
// one, and what it can do stays narrow, because the document also holds the consent
// banner. On an editor surface it must never reach the editor's own document.
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { getSnapshot } from 'mobx-state-tree';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { applyBehaviour } from '@/lib/renderer/server/applyBehaviour';
import { applyResponsiveStyles } from '@/lib/renderer/server/applyResponsiveStyles';
import { renderComponentNode } from '@/lib/renderer/server/renderComponentNode';
import { FIELD_SIZING_GUARD } from '@/lib/responsive/responsiveCss';
import ComponentModel, { ComponentTypeEnum, type ComponentInstance } from '@/models/ComponentModel';
import { ComponentDefinitionModel } from '@/models/ComponentDefinitionModel';
import PageModel from '@/models/PageModel';
import { MAX_RULES_PER_NODE, parseCssText, parseRule, readRules, ROOT_PROPERTIES, ROOT_SELECTOR } from '../rules';
import { surfaceSheet, type SurfaceNode, type SurfaceProblem } from '../surfaceSheet';

afterEach(() => {
  vi.restoreAllMocks();
});

const BPS = [
  { id: 'desktop', minWidth: 1280 },
  { id: 'tablet', minWidth: 768 },
  { id: 'mobile', minWidth: 320 },
];
const FRAME = { breakpointId: 'desktop', width: 1280, height: 800 };

const onRoot = (style: Record<string, unknown>, more: Record<string, unknown> = {}) => ({ id: 'doc', selector: ROOT_SELECTOR, style, ...more });
const page = (rules: unknown[], style?: Record<string, unknown>, ...children: ComponentNode[]): ComponentNode => ({
  id: 'root',
  type: 'div',
  props: { rules: rules as never, ...(style ? { style } : {}) },
  children,
});
const sheetOf = (root: ComponentNode): string => applyResponsiveStyles(root, BPS).css;
const reason = (rule: unknown): string | undefined => {
  const parsed = parseRule(rule, { pageRoot: true });
  return parsed.ok ? undefined : parsed.reason;
};

describe('the parser', () => {
  it('reads a rule on the document as its own kind', () => {
    expect(parseRule(onRoot({ scrollBehavior: 'smooth' }, { at: ['@media (min-width: 600px)'] }), { pageRoot: true })).toEqual({
      ok: true,
      value: { kind: 'root', id: 'doc', at: ['@media (min-width: 600px)'], style: { scrollBehavior: 'smooth' } },
    });
  });

  it('refuses it anywhere but on the page root', () => {
    expect(parseRule(onRoot({ color: 'red' }))).toEqual({ ok: false, reason: 'only the root of a page can hold a rule on :root' });
  });

  it.each([':root *', ':root [data-fc-consent]', ':root,html', ':root:has(a)', 'html', 'body', ':ROOT', ' :root', ':root '])('takes only the exact selector, not %j', (selector) => {
    expect(parseRule({ id: 'doc', selector, style: { color: 'red' } }, { pageRoot: true }).ok).toBe(false);
  });

  it('holds no condition, because the document has no state', () => {
    expect(reason(onRoot({ color: 'red' }, { gate: 'off' }))).toMatch(/no condition/);
    expect(reason(onRoot({ color: 'red' }, { when: { state: 's', eq: true } }))).toMatch(/no condition/);
    expect(reason(onRoot({ color: 'red' }, { componentState: 'on' }))).toMatch(/no condition/);
  });

  it.each(['@container (min-width: 1px)', '@scope (html)', '@starting-style', '@layer x', '@media (min-width: 1px){}'])('refuses the wrapper %j', (wrapper) => {
    expect(reason(onRoot({ color: 'red' }, { at: [wrapper] }))).toBeDefined();
  });

  it.each(['display', 'visibility', 'pointerEvents', 'opacity', 'filter', 'transform', 'position', 'zoom', 'contain', 'background', 'content', 'fieldSizing', 'animation'])(
    'refuses %s on the document, which would reach the consent banner or load something',
    (property) => {
      expect(ROOT_PROPERTIES.has(property)).toBe(false);
      expect(reason(onRoot({ [property]: 'none' }))).toBeDefined();
    },
  );

  it.each([
    ['--x', 'url(https://evil.example/a.png)'],
    ['--x', 'red;display:none'],
    ['--x', 'red}body{display:none'],
    ['--x', '</style><script>alert(1)</script>'],
    ['--x', '\\75rl(https://evil.example)'],
    ['--x', '/* hide */ red'],
    ['color', 'red;display:none'],
    ['fontFamily', 'a}*{display:none'],
    ['backgroundColor', 'url(https://evil.example/a.png)'],
    ['--x;display:none', 'red'],
  ])('refuses %s: %s, as any rule does', (property, value) => {
    expect(reason(onRoot({ [property]: value }))).toBeDefined();
  });

  it.each(['--fc-sticky-cta-h', '--fc-', '--fc-anything'])('refuses %s, which is the platform\'s', (property) => {
    expect(reason(onRoot({ [property]: '9999px !important' }))).toBe(`${property} cannot be set on the document`);
    expect(reason(onRoot({ [property]: '-9999px !important' }))).toBeDefined();
    expect(reason(onRoot({ [property]: '!important' }))).toBeDefined();
  });

  it.each(['--FC-x', '--Fc-x', '--fcx', '--brand'])('keeps %s: a custom property name is case-sensitive, and these are other names', (property) => {
    expect(reason(onRoot({ [property]: '1' }))).toBeUndefined();
  });

  it('keeps a whole list to the cap of a node', () => {
    const rules = Array.from({ length: MAX_RULES_PER_NODE + 1 }, (_, i) => onRoot({ color: 'red' }, { id: `r${i}` }));
    const read = readRules({ rules }, { pageRoot: true });
    expect(read.rules).toHaveLength(MAX_RULES_PER_NODE);
    expect(read.refused).toHaveLength(1);
  });
});

describe('the published page', () => {
  it('writes the constant selector, breakpoints included', () => {
    const css = sheetOf(page([onRoot({ scrollBehavior: 'smooth', fontSize: { base: '20px', mobile: '16px' } })]));
    expect(css).toContain(':root{scroll-behavior:smooth;font-size:20px}');
    expect(css).toContain('@media (max-width:767.98px){\n:root{font-size:16px}\n}');
  });

  it('keeps a wrapper and the empty custom property', () => {
    const css = sheetOf(page([onRoot({ '--gap': ' ' }, { at: ['@media (prefers-reduced-motion: reduce)'] })]));
    expect(css).toContain('@media (prefers-reduced-motion: reduce){\n:root{--gap: }\n}');
  });

  it('hands back what body sets itself, under the same conditions, in constant text', () => {
    const css = sheetOf(page([onRoot({ color: '#123456', backgroundColor: '#654321', fontFamily: 'Georgia' })]));
    expect(css).toContain(':root{color:#123456;background-color:#654321;font-family:Georgia}\nbody{color:inherit;background-color:transparent;font-family:inherit}');
    const wrapped = sheetOf(page([onRoot({ color: 'red' }, { at: ['@media (prefers-color-scheme: dark)'] })]));
    expect(wrapped).toContain('@media (prefers-color-scheme: dark){\n:root{color:red}\nbody{color:inherit}\n}');
    const narrow = sheetOf(page([onRoot({ color: { mobile: 'red' } })]));
    expect(narrow).toContain('@media (max-width:767.98px){\n:root{color:red}\nbody{color:inherit}\n}');
    expect(narrow.startsWith('body')).toBe(false);
  });

  it('leaves body alone for anything else, and for a value that writes nothing', () => {
    expect(sheetOf(page([onRoot({ scrollBehavior: 'smooth', fontSize: '20px' })]))).not.toContain('body');
    expect(sheetOf(page([onRoot({ scrollBehavior: 'smooth', color: ' ' })]))).not.toContain('body');
  });

  it.each([
    ['display', 'none'],
    ['pointerEvents', 'none'],
    ['--fc-sticky-cta-h', '9999px'],
  ])('the emitter refuses %s even when a parsed rule hands it over', (property, value) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const forged = { kind: 'root' as const, id: 'forged', at: [], style: { [property]: value } };
    const css = applyResponsiveStyles({ ...page([]), compiledRules: [forged] }, BPS).css;
    expect(css).not.toContain(':root');
    expect(JSON.stringify(warn.mock.calls)).toContain('cannot be set on the document');
  });

  it('takes no parsed document rule from a node that is not the root', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const forged = { kind: 'root' as const, id: 'forged', at: [], style: { color: 'red' } };
    const css = sheetOf({ id: 'root', type: 'div', props: {}, children: [{ id: 'kid', type: 'div', props: {}, compiledRules: [forged] }] });
    expect(css).not.toContain(':root');
    expect(JSON.stringify(warn.mock.calls)).toContain('only the root of a page');
  });

  it('does not take the root node for its subject: no class, and its Normal stays inline', () => {
    const { root, css } = applyResponsiveStyles(page([onRoot({ color: 'red' })], { padding: '8px' }), BPS);
    expect(root.props?.className).toBeUndefined();
    expect(root.props?.style).toEqual({ padding: '8px' });
    expect(css).not.toContain('.fc');
    expect(renderToStaticMarkup(<>{renderComponentNode(root)}</>)).not.toContain('rules');
  });

  it('counts as a rule, so a custom property holding an address goes and the sheet ends with the guard', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const child: ComponentNode = { id: 'kid', type: 'div', props: { style: { '--x': 'url(https://evil.example/a.png)' } } };
    const { root, css } = applyResponsiveStyles(page([onRoot({ color: 'red' })], undefined, child), BPS);
    expect(root.children?.[0].props?.style).toBeUndefined();
    expect(css.endsWith(FIELD_SIZING_GUARD)).toBe(true);
  });

  it('refuses it on a child, and reports why', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const css = sheetOf({ id: 'root', type: 'div', props: {}, children: [{ id: 'kid', type: 'div', props: { rules: [onRoot({ color: 'red' })] as never } }] });
    expect(css).not.toContain(':root');
    expect(JSON.stringify(warn.mock.calls)).toContain('only the root of a page');
  });

  it('never lends the root a reading to a child with the same list', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rules = [onRoot({ color: 'red' })];
    const css = sheetOf(page(rules, undefined, { id: 'kid', type: 'div', props: { rules: rules as never } }));
    expect(css.match(/:root\{/g)).toHaveLength(1);
  });

  it('refuses it on a placement that happens to be the root: a definition does not own the document', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(sheetOf({ ...page([onRoot({ color: 'red' })]), placementRoot: true })).not.toContain(':root');
    expect(JSON.stringify(warn.mock.calls)).toContain('only the root of a page');
  });

  it('survives the behaviour pass on a root whose list holds a condition', () => {
    const conditional = { id: 'on', selector: '&', when: { state: 'open', eq: true }, style: { color: 'blue' } };
    const root: ComponentNode = {
      ...page([conditional, onRoot({ scrollBehavior: 'smooth' })]),
      props: {
        rules: [conditional, onRoot({ scrollBehavior: 'smooth' })] as never,
        behaviour: { state: [{ id: 'open', name: 'open', type: 'boolean', initial: false }] } as never,
      },
    };
    const compiled = applyBehaviour(root);
    expect(applyResponsiveStyles(compiled.root, BPS, { gated: compiled.hasGate }).css).toContain(':root{scroll-behavior:smooth}');
  });
});

describe('the editor surfaces', () => {
  const surface = (tree: SurfaceNode, kind: 'canvas' | 'preview' = 'canvas', onProblem?: (p: SurfaceProblem) => void) =>
    surfaceSheet({ kind, tree, frames: [FRAME], breakpoints: BPS, onProblem });

  it.each(['canvas', 'preview'] as const)('never writes the document on the %s, which is the editor', (kind) => {
    const css = surface(page([onRoot({ '--accent': 'red', color: 'blue', scrollBehavior: 'smooth', overflowX: 'hidden' })]) as SurfaceNode, kind);
    expect(css).not.toMatch(/(^|[\s}]):root|(^|[\s}])html\b/);
    expect(css).toContain('--accent:red!important');
    expect(css).toContain('color:blue!important');
  });

  it('leaves out what only a document does, and what the root sets itself', () => {
    const css = surface(page([onRoot({ scrollBehavior: 'smooth', overflowX: 'hidden', maxWidth: '100vw', '--a': '1', '--b': '2' })], { '--b': '3' }) as SurfaceNode);
    expect(css).toContain('--a:1!important');
    for (const gone of ['scroll-behavior', 'overflow-x', 'max-width', '--b']) expect(css).not.toContain(gone);
  });

  it('shows nothing of it on a definition, which owns no document', () => {
    const problems: SurfaceProblem[] = [];
    const css = surfaceSheet({ kind: 'canvas', tree: page([onRoot({ color: 'red' })]) as SurfaceNode, definitionTree: true, frames: [FRAME], breakpoints: BPS, onProblem: (p) => problems.push(p) });
    expect(css).not.toContain('red');
    expect(problems.map((p) => p.reason)).toContain('only the root of a page can hold a rule on :root');
  });

  it('reports it on a child, and on a floating element', () => {
    const problems: SurfaceProblem[] = [];
    const tree = { id: 'root', type: 'div', props: {}, children: [{ id: 'kid', type: 'div', props: { rules: [onRoot({ color: 'red' })] } }] } as SurfaceNode;
    const float = { id: 'float', type: 'div', props: { rules: [onRoot({ color: 'blue' })] } } as SurfaceNode;
    const css = surfaceSheet({ kind: 'canvas', tree, floating: [float], frames: [FRAME], breakpoints: BPS, onProblem: (p) => problems.push(p) });
    expect(css).not.toContain('red');
    expect(css).not.toContain('blue');
    expect(problems.map((p) => p.reason)).toContain('only the root of a page can hold a rule on :root');
  });
});

describe('typed text', () => {
  it('keeps :root as a real rule on the page root', () => {
    const { rules, refused } = parseCssText(':root { scroll-behavior: smooth; }', { pageRoot: true });
    expect(refused).toEqual([]);
    expect(rules).toEqual([{ selector: ':root', style: { scrollBehavior: 'smooth' } }]);
  });

  it('keeps a wrapper around it', () => {
    const { rules } = parseCssText('@media (prefers-reduced-motion: reduce) { :root { scroll-behavior: auto; } }', { pageRoot: true });
    expect(rules).toEqual([{ selector: ':root', at: ['@media (prefers-reduced-motion: reduce)'], style: { scrollBehavior: 'auto' } }]);
  });

  it('gives the reason on any other node, rather than a rule that never matches', () => {
    expect(parseCssText(':root { color: red; }')).toEqual({ rules: [], refused: [{ text: ':root', reason: 'only the root of a page can hold a rule on :root' }] });
  });

  it('gives the reason for a property the document does not take', () => {
    const { rules, refused } = parseCssText(':root { display: none; color: red; }', { pageRoot: true });
    expect(rules).toEqual([]);
    expect(refused[0].reason).toBe('display cannot be set on the document');
  });

  it('refuses it inside a list, where the browser would drop the whole list', () => {
    const { rules, refused } = parseCssText(':root, .x { color: red; }', { pageRoot: true });
    expect(rules).toEqual([]);
    expect(refused[0].reason).toBe('every part of a selector starts with &');
  });
});

describe('typed text that only looks like :root', () => {
  it.each([':ROOT', ':Root', ':root :root', ':root > div', ':root:hover', ':root.x'])('gives the reason for %s, rather than a rule that never matches', (selector) => {
    const { rules, refused } = parseCssText(`${selector} { color: red; }`, { pageRoot: true });
    expect(rules).toEqual([]);
    expect(refused).toHaveLength(1);
  });

  it.each(['&:root', '&:ROOT', '& :root', '&:root :root'])('refuses %s as a stored selector', (selector) => {
    expect(parseRule({ id: 'r', selector, style: { color: 'red' } }, { pageRoot: true }).ok).toBe(false);
  });

  it('leaves names that only start alike', () => {
    expect(parseCssText(':rooted { color: red; }').refused[0]?.text).not.toBe(':rooted-kept');
    expect(parseRule({ id: 'r', selector: '&:root-like', style: { color: 'red' } }).ok).toBe(true);
  });

  it('takes an empty rule on :root as a reason, not a stored nothing', () => {
    const { rules, refused } = parseCssText(':root { }', { pageRoot: true });
    expect(rules).toEqual([]);
    expect(refused[0].reason).toBe('a rule on :root needs a declaration');
  });

  it('reads the empty value from text, as pasted from Tailwind', () => {
    expect(parseCssText(':root { --tw-blur: ; --e:; color: red; }', { pageRoot: true }).rules).toEqual([
      { selector: ':root', style: { '--tw-blur': ' ', '--e': ' ', color: 'red' } },
    ]);
    expect(parseCssText('&:hover { --tw-blur: ; }').rules).toEqual([{ selector: '&:hover', style: { '--tw-blur': ' ' } }]);
    expect(parseCssText('&:hover { color: ; }').refused[0].reason).toBe('color has no value');
  });
});

describe('the model', () => {
  const pageModel = () =>
    PageModel.create({
      id: 'p',
      metadata: { title: 'T' },
      appComponentTree: { id: 'root', type: 'div', componentType: ComponentTypeEnum.HOST, props: {}, children: [{ id: 'kid', type: 'div', componentType: ComponentTypeEnum.HOST, props: {} }] },
    });

  it('takes it on the page root, and it survives the snapshot', () => {
    const model = pageModel();
    const root = model.appComponentTree as ComponentInstance;
    expect(root.addRule({ selector: ROOT_SELECTOR, style: { scrollBehavior: 'smooth' } })).toEqual({ ok: true });
    const again = PageModel.create(getSnapshot(model));
    const read = readRules((again.appComponentTree as ComponentInstance).props, { pageRoot: true });
    expect(read.rules.map((rule) => rule.kind)).toEqual(['root']);
  });

  it.each(['display', 'pointerEvents', '--fc-sticky-cta-h'])('refuses a write of %s to a rule on the document, and keeps what the rule holds', (property) => {
    const root = pageModel().appComponentTree as ComponentInstance;
    root.addRule({ id: 'doc', selector: ROOT_SELECTOR, style: { color: 'red' } });
    expect(root.setRuleStyle('doc', property, 'none')).toEqual({ ok: false, reason: `${property} cannot be set on the document` });
    expect(readRules(root.props, { pageRoot: true }).rules).toHaveLength(1);
    expect(root.setRuleStyle('doc', 'scrollBehavior', 'smooth')).toEqual({ ok: true });
    expect(root.setRuleStyle('doc', 'color', undefined)).toEqual({ ok: true });
  });

  it('refuses it on a child, on a definition root and on a node with no page, with a reason the panel can show', () => {
    const child = (pageModel().appComponentTree as ComponentInstance).children[0] as ComponentInstance;
    const refused = { ok: false, reason: 'only the root of a page can hold a rule on :root' };
    expect(child.addRule({ selector: ROOT_SELECTOR, style: { color: 'red' } })).toEqual(refused);
    const definition = ComponentDefinitionModel.create({ id: 'd', name: 'Card', page: getSnapshot(pageModel()) });
    expect((definition.page.appComponentTree as ComponentInstance).addRule({ selector: ROOT_SELECTOR, style: { color: 'red' } })).toEqual(refused);
    expect(definition.page.isDefinitionPage).toBe(true);
    const alone = ComponentModel.create({ id: 'x', type: 'div', componentType: ComponentTypeEnum.HOST, props: {} }) as ComponentInstance;
    expect(alone.addRule({ selector: ROOT_SELECTOR, style: { color: 'red' } })).toEqual(refused);
  });
});

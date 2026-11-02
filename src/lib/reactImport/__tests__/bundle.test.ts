// @vitest-environment node
// The one door: a worker's result and a forged file through the same reader. Each forged
// case is a bundle no importer would write, and each must come out as what it is.

import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { IMPORT_LIMITS } from '../budget';
import { BUNDLE_LIMITS, createBundle, readBundle, sourceHashOf, type ImportBundle } from '../bundle';
import { DETAILS, type ImportLine } from '../report';
import { importSource, type SourceInput } from '../source';

const PROJECT = { ids: new Set(['page-root', 'imp-x-1']) };
const fakeKey = () => `${['sk', 'live'].join('_')}_${randomBytes(16).toString('hex')}`;

const forged = (nodes: unknown, lines: Partial<ImportLine>[] = [], extra: Record<string, unknown> = {}) => JSON.stringify({
  format: 1,
  sourceHash: 'ab'.repeat(32),
  nodes,
  report: {
    lines: lines.map((line) => ({ file: 'a.tsx', line: 1, column: 1, endLine: 1, atoms: [], kind: 'element', disposition: 'converted', detail: DETAILS.element, next: [], ...line })),
    counts: { converted: lines.length, adapted: 0, rebuilt: 0, left: 0 },
    verdict: 'imported',
  },
  ...extra,
});

const found = (raw: unknown) => readBundle(raw, PROJECT).found.map((line) => line.detail);

describe('a bundle from the importer', () => {
  const files: SourceInput[] = [{ name: 'a.tsx', text: '<section id="s" aria-labelledby="t"><h2 id="t" className="group px-4"><span className="group-hover:underline">Title</span></h2></section>' }];

  it('reads back what was written, with ids of its own', async () => {
    const bundle = await createBundle(files, await importSource(files));
    const read = readBundle(JSON.stringify(bundle), PROJECT);
    expect(read.found).toEqual([]);
    expect(read.verdict).toBe(bundle.report.verdict);
    expect(read.nodes?.type).toBe('section');
    expect(read.nodes?.id).not.toBe(bundle.nodes?.id);
    expect(PROJECT.ids.has(read.nodes?.id as string)).toBe(false);
    expect(read.nodes?.children?.[0]).toMatchObject({ type: 'h2', props: { className: 'u-c-group', style: { paddingInline: 'calc(var(--spacing) * 4)' } } });
    // The heading's id moved under the bundle's prefix, and the label reference followed it.
    const heading = read.nodes?.children?.[0]?.props?.id as string;
    expect(heading).toMatch(/^imp-[0-9a-f]+-t$/);
    expect(read.nodes?.props).toMatchObject({ 'aria-labelledby': heading });
    // A line names the node by its new id.
    const classLine = read.stated.lines.find((line) => line.detail === DETAILS.classConverted);
    expect(classLine?.nodeKey).toBe(read.ids.get('n-0-0'));
  });

  it('leaves excerpts out when asked, and the hash follows every input', async () => {
    const outcome = await importSource(files);
    expect(outcome.report.lines.some((line) => line.excerpt !== undefined)).toBe(true);
    const bundle = await createBundle(files, outcome, { excerpts: false });
    expect(bundle.report.lines.some((line) => line.excerpt !== undefined)).toBe(false);
    expect(await sourceHashOf(files)).toBe(await sourceHashOf([...files]));
    expect(await sourceHashOf(files)).not.toBe(await sourceHashOf([{ ...files[0], text: `${files[0].text} ` }]));
    expect(await sourceHashOf(files)).not.toBe(await sourceHashOf(files, { systemDark: true }));
    expect(await sourceHashOf(files)).not.toBe(await sourceHashOf(files, { breakpoints: { tablet: 'a', mobile: 'b' } }));
  });

  it('never carries the atom table', async () => {
    const outcome = await importSource(files, { atomTable: true });
    expect(outcome.atoms?.length).toBeGreaterThan(0);
    expect(JSON.stringify(await createBundle(files, outcome))).not.toContain('syntaxKind');
  });
});

describe('a forged bundle', () => {
  it('cannot claim "imported" over a rule the parser refuses', () => {
    const read = readBundle(forged({ id: 'a', type: 'div', props: { rules: [{ id: 'r', selector: 'body', style: { color: 'red' } }] } }), PROJECT);
    expect(read.stated.verdict).toBe('imported');
    expect(read.verdict).toBe('not-imported');
    expect(read.nodes?.props ?? {}).not.toHaveProperty('rules');
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['a script address', { href: 'javascript:alert(1)' }, DETAILS.refusedAttribute],
    ['an inline handler', { onClick: 'alert(1)' }, DETAILS.refusedAttribute],
    ['raw markup', { dangerouslySetInnerHTML: { __html: '<img src=x onerror=alert(1)>' } }, DETAILS.refusedAttribute],
    ['a platform marker', { 'data-fc-island': 'form' }, DETAILS.platformAttribute],
    ['an island setting', { effects: [{ kind: 'x' }] }, DETAILS.refusedAttribute],
    ['a query for site data', { query: { collection: 'users' } }, DETAILS.refusedAttribute],
    ['a name in another case', { ID: 'x' }, DETAILS.refusedAttribute],
    ['the HTML class spelling', { class: 'fixed' }, DETAILS.refusedAttribute],
    ['a form action on a button', { formAction: 'https://evil.test/steal' }, DETAILS.form],
    ['the editor utilities', { className: 'fixed inset-0 z-50' }, DETAILS.bundleClass],
    ['a style that declares twice', { style: { color: 'red;background:url(x)' } }, DETAILS.refusedStyle],
    ['a style that is no object', { style: 'color:red' }, DETAILS.refusedStyle],
    ['bindings', { bindings: { children: { mode: 'read', expression: '{{row.secret}}' } } }, DETAILS.bundleBindings],
    ['behaviour', { behaviour: { on: [] } }, DETAILS.bundleBehaviour],
    ['a reference into the page', { 'aria-labelledby': 'page-heading' }, DETAILS.bundleReference],
    ['a fragment link into the page', { href: '#checkout' }, DETAILS.bundleReference],
  ])('refuses %s, and the verdict says so', (_name, props, detail) => {
    const read = readBundle(forged({ id: 'a', type: 'button', props }), PROJECT);
    expect(found(forged({ id: 'a', type: 'button', props }))).toContain(detail);
    expect(read.verdict).toBe('not-imported');
    for (const name of Object.keys(props)) expect(read.nodes?.props ?? {}).not.toHaveProperty(name);
  });

  it('keeps the classes the import writes, and drops every other', () => {
    const read = readBundle(forged({ id: 'a', type: 'div', props: { className: 'u-c-group fixed u-c-size-6' } }), PROJECT);
    expect(read.nodes?.props?.className).toBe('u-c-group u-c-size-6');
    expect(read.verdict).toBe('not-imported');
  });

  it.each<[string, unknown, string]>([
    ['a refused tag', { id: 'a', type: 'div', children: [{ id: 'b', type: 'script', props: { children: 'alert(1)' } }] }, DETAILS.refusedTag],
    ['an iframe', { id: 'a', type: 'div', children: [{ id: 'b', type: 'iframe', props: { src: 'https://evil.test' } }] }, DETAILS.refusedTag],
    ['a document title', { id: 'a', type: 'div', children: [{ id: 'b', type: 'title', props: { children: 'x' } }] }, DETAILS.refusedTag],
    ['a placement of a project component', { id: 'a', type: 'div', children: [{ id: 'b', type: '#component', props: { component: 'header' } }] }, DETAILS.bundleComponent],
    ['a node that is no object', { id: 'a', type: 'div', children: ['text'] }, DETAILS.bundleNode],
    ['children on text', { id: 'a', type: '#text', props: { children: 'x' }, children: [] }, DETAILS.bundleNode],
    ['an attribute on text', { id: 'a', type: '#text', props: { children: 'x', title: 'y' } }, DETAILS.bundleField],
    ['an editor field', { id: 'a', type: 'div', canvasX: 10 }, DETAILS.bundleField],
  ])('removes %s', (_name, nodes, detail) => {
    const read = readBundle(forged(nodes), PROJECT);
    expect(read.found.map((line) => line.detail)).toContain(detail);
    expect(read.verdict).toBe('not-imported');
    expect(JSON.stringify(read.nodes ?? null)).not.toMatch(/script|iframe|#component|canvasX|evil/);
  });

  it('keeps a reference that points inside the import, and both move to ids of the import', () => {
    const read = readBundle(forged({ id: 'a', type: 'div', children: [
      { id: 'b', type: 'p', props: { id: 'p1', children: 'x' } },
      { id: 'c', type: 'button', props: { 'aria-describedby': 'p1', children: 'y' } },
      { id: 'd', type: 'a', props: { href: '#p1', children: 'z' } },
      { id: 'e', type: 'svg', children: [{ id: 'f', type: 'clipPath', props: { id: 'clip' } }, { id: 'g', type: 'rect', props: { clipPath: 'url(#clip)', style: { filter: 'url("#clip")' } } }] },
    ] }), PROJECT);
    expect(read.found).toEqual([]);
    const [p, button, link, svg] = read.nodes?.children ?? [];
    const moved = p?.props?.id as string;
    expect(moved).toMatch(/^imp-[0-9a-f]+-p1$/);
    expect(button?.props).toMatchObject({ 'aria-describedby': moved });
    expect(link?.props).toMatchObject({ href: `#${moved}` });
    const clip = svg?.children?.[0]?.props?.id as string;
    expect(svg?.children?.[1]?.props).toMatchObject({ clipPath: `url(#${clip})`, style: { filter: `url(#${clip})` } });
  });

  // Review of slice 4, U4: each of these named an element of the page, and stayed.
  it.each<[string, Record<string, unknown>]>([
    ['a link with a leading space', { href: ' #contact' }],
    ['a link with a leading tab', { href: '\t#contact' }],
    ['a paint server of the page', { fill: 'url(#page-gradient)' }],
    ['a clip path of the page', { clipPath: 'url(#page-clip)' }],
    ['a mask of the page', { mask: 'url(#m)' }],
    ['a filter of the page', { filter: 'url(#f)' }],
    ['microdata items of the page', { itemref: 'page-a' }],
    ['an anchor of the page', { anchor: 'page-b' }],
    ['a command target of the page', { commandfor: 'page-dialog' }],
  ])('removes %s', (_name, props) => {
    const read = readBundle(forged({ id: 's', type: 'svg', children: [{ id: 'r', type: 'rect', props }] }), PROJECT);
    expect(read.found.map((line) => line.detail)).toContain(DETAILS.bundleReference);
    for (const name of Object.keys(props)) expect(read.nodes?.children?.[0]?.props ?? {}).not.toHaveProperty(name);
  });

  it('removes an escaped fragment, which a browser decodes to one', () => {
    const read = readBundle(forged({ id: 's', type: 'svg', children: [{ id: 'r', type: 'rect', props: { fill: 'url(\\23 page)' } }] }), PROJECT);
    expect(read.found.length).toBeGreaterThan(0);
    expect(read.nodes?.children?.[0]?.props ?? {}).not.toHaveProperty('fill');
  });

  it('removes a style reference into the page, and does not call it an external address', () => {
    const read = readBundle(forged({ id: 'a', type: 'div', props: { style: { clipPath: 'url(#page-clip)', color: 'red' } } }), PROJECT);
    expect(read.nodes?.props?.style).toEqual({ color: 'red' });
    expect(read.found.map((line) => line.detail)).toEqual([DETAILS.bundleReference]);
  });

  it('renames an imported id, so it cannot capture the page\'s own label or link', () => {
    const read = readBundle(forged({ id: 'a', type: 'input', props: { id: 'email' } }), PROJECT);
    expect(read.nodes?.props?.id).not.toBe('email');
    expect(String(read.nodes?.props?.id)).toMatch(/-email$/);
  });

  // Review of slice 4, U2. #268 closed the attribute routes in the rule parser; a class or an id of the page stays
  // open to an author's rule there, so the door refuses it for a stranger's.
  it.each([
    '&:is(.ground-wrapper *)', '&:is([class*="ground-wrap"] *)', '&:is([id^="ground-wrapper"] *)', '&:is(#page-header *)',
    '&:has(.fc-n1)', '&:is(:root:has(.ground-wrapper) *)',
  ])('refuses a rule reading the page, %s', (selector) => {
    const read = readBundle(forged({ id: 'a', type: 'div', props: { rules: [{ id: 'r', selector, style: { display: 'none' } }] } }), PROJECT);
    expect(read.found.map((line) => line.detail)).toContain(DETAILS.refusedRule);
    expect(read.nodes?.props ?? {}).not.toHaveProperty('rules');
    expect(read.verdict).toBe('not-imported');
  });

  it('keeps a rule reading the import\'s own kept class', () => {
    const read = readBundle(forged({ id: 'a', type: 'div', props: { rules: [{ id: 'r', selector: '&:is(:where(.u-c-group):hover *)', style: { color: 'red' } }] } }), PROJECT);
    expect(read.found).toEqual([]);
    expect(read.nodes?.props?.rules).toHaveLength(1);
  });

  it('keeps the stated verdict apart from what it found (review of slice 4, U3)', () => {
    const honest = readBundle(forged({ id: 'a', type: 'div', props: { title: 'x' } }, [{ disposition: 'left', detail: DETAILS.left, nodeKey: 'a' }]), PROJECT);
    expect(honest.stated.verdict).toBe('not-imported');
    expect(honest.foundVerdict).toBe('imported');
    // Leaving the line out raises what the file states, and what was found says only what was found.
    const silent = readBundle(forged({ id: 'a', type: 'div', props: { title: 'x' } }), PROJECT);
    expect(silent.stated.verdict).toBe('imported');
    const refused = readBundle(forged({ id: 'a', type: 'div', props: { onclick: 'x' } }), PROJECT);
    expect(refused.stated.verdict).toBe('imported');
    expect(refused.foundVerdict).toBe('not-imported');
  });

  it('gives ids that collide with the project new ones', () => {
    const read = readBundle(forged({ id: 'page-root', type: 'div', children: [{ id: 'imp-x-1', type: 'p', props: { children: 'x' } }] }), { ids: new Set(['page-root', 'imp-x-1', 'imp-abababab-1']) });
    const ids = [read.nodes?.id, read.nodes?.children?.[0]?.id];
    expect(ids.every((id) => typeof id === 'string' && !['page-root', 'imp-x-1', 'imp-abababab-1'].includes(id))).toBe(true);
    expect(new Set(ids).size).toBe(2);
  });

  it('removes a secret wherever it sits, and blocks placing', () => {
    const key = fakeKey();
    for (const nodes of [
      { id: 'a', type: 'a', props: { href: `https://api.example.test/?key=${key}`, children: 'x' } },
      { id: 'a', type: 'p', props: { children: `token ${key}` } },
      { id: 'a', type: 'div', props: { style: { backgroundImage: `url(https://x.test/${key}.png)` } } },
      { id: 'a', type: 'div', props: { rules: [{ id: 'r', selector: '&::after', style: { content: `"${key}"` } }] } },
      { id: 'a', type: 'div', children: [{ id: 'b', type: '#text', props: { children: key } }] },
    ]) {
      const read = readBundle(forged(nodes), PROJECT);
      expect(read.found.map((line) => line.kind)).toContain('secret');
      expect(read.verdict).toBe('not-imported');
      expect(JSON.stringify(read.nodes ?? null)).not.toContain(key);
    }
  });

  // Review of slice 4, U1: each of these reached a page as "imported".
  it.each<[string, (key: string) => Record<string, unknown>]>([
    ['a key after a word', (key) => ({ title: `token-${key}` })],
    ['a key after an underscore', (key) => ({ title: `api_${key}` })],
    ['a key after a letter', (key) => ({ title: `K${key}` })],
    ['a key kept as a class', (key) => ({ className: `u-c-${key.replace(/_/g, '__')}` })],
    ['a key as an attribute name', (key) => ({ [`data-${key}`]: 'x' })],
  ])('removes %s', (_name, props) => {
    const key = fakeKey();
    const read = readBundle(forged({ id: 'a', type: 'p', props: { ...props(key), children: 'x' } }), PROJECT);
    expect(read.found.map((line) => line.kind)).toContain('secret');
    expect(read.verdict).toBe('not-imported');
    expect(JSON.stringify(read.nodes ?? null)).not.toContain(key.slice(8));
  });

  it('drops a stated excerpt that holds a key', () => {
    const key = fakeKey();
    const read = readBundle(forged({ id: 'a', type: 'p', props: { children: 'x' } }, [{ excerpt: `const K = "${key}"` }]), PROJECT);
    expect(JSON.stringify(read)).not.toContain(key);
  });

  it('removes a key glued to a word and one kept as a class, through the real importer, and keeps neither in an excerpt', async () => {
    const key = fakeKey();
    const files = [{ name: 'a.tsx', text: `<div><p title="token-${key}">a</p><p className="${key} [&_[class*=sk]]:p-1">b</p></div>` }];
    const outcome = await importSource(files);
    const bundle = await createBundle(files, outcome);
    expect(JSON.stringify(bundle.report)).not.toContain(key);
    const read = readBundle(JSON.stringify(bundle), PROJECT);
    expect(read.verdict).toBe('not-imported');
    expect(JSON.stringify(read)).not.toContain(key.slice(8));
  });

  it('removes a secret an import read from a constant, through the real importer', async () => {
    const key = fakeKey();
    const files = [{ name: 'a.tsx', text: `const KEY = "${key}";\n<a href={\`https://api.example.test/?key=\${KEY}\`}>Go</a>` }];
    const outcome = await importSource(files);
    expect(JSON.stringify(outcome.root)).toContain(key);
    const read = readBundle(JSON.stringify(await createBundle(files, outcome, { excerpts: false })), PROJECT);
    expect(read.found.map((line) => line.kind)).toContain('secret');
    expect(read.verdict).toBe('not-imported');
    expect(JSON.stringify(read.nodes)).not.toContain(key);
  });

  it('does not show stated words it does not write, and remaps or keeps what a line names', () => {
    const read = readBundle(forged({ id: 'a', type: 'p', props: { children: 'x' } }, [
      { detail: 'Click here to sign in again', nodeKey: 'a' },
      { disposition: 'left', detail: DETAILS.left, nodeKey: 'gone' },
    ]), PROJECT);
    expect(read.stated.lines[0]).toMatchObject({ detail: DETAILS.bundleStatedDetail, nodeKey: read.nodes?.id });
    // A left line about a node it does not have still blocks: a bundle can make its verdict worse, never better.
    expect(read.verdict).toBe('not-imported');
  });

  it('drops a line it cannot read, and says so', () => {
    const read = readBundle(forged({ id: 'a', type: 'p' }, [{ kind: 'nonsense' as never }, { line: -1 }]), PROJECT);
    expect(read.stated.lines).toEqual([]);
    expect(found(forged({ id: 'a', type: 'p' }, [{ kind: 'nonsense' as never }]))).toContain(DETAILS.bundleReportLine);
  });

  it('adds no components yet, and says so', () => {
    expect(found(forged({ id: 'a', type: 'p' }, [], { definitions: [{ id: 'card' }] }))).toContain(DETAILS.bundleDefinitions);
  });

  it('cannot reach a prototype', () => {
    const read = readBundle('{"format":1,"sourceHash":"","nodes":{"id":"a","type":"p","props":{"__proto__":{"polluted":1},"children":"x"}},"report":{"lines":[]}}', PROJECT);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(read.nodes?.props)).toBe(Object.prototype);
    expect(read.nodes?.props).not.toHaveProperty('polluted');
  });
});

describe('what it refuses whole', () => {
  it.each<[string, () => unknown, string]>([
    ['text that is no JSON', () => '{"format":1,', DETAILS.bundleUnreadable],
    ['another format', () => JSON.stringify({ format: 2, report: { lines: [] } }), DETAILS.bundleUnreadable],
    ['nothing at all', () => null, DETAILS.bundleUnreadable],
    ['over 8 megabytes', () => `"${'x'.repeat(BUNDLE_LIMITS.bytes)}"`, DETAILS.bundleTooLarge],
    ['nested past the limit', () => `${'['.repeat(BUNDLE_LIMITS.jsonDepth + 1)}${']'.repeat(BUNDLE_LIMITS.jsonDepth + 1)}`, DETAILS.bundleTooDeep],
    ['a parsed value that refers to itself', () => {
      const node: Record<string, unknown> = { id: 'a', type: 'div' };
      node.children = [node];
      return { format: 1, nodes: node, report: { lines: [] } };
    }, DETAILS.bundleTooDeep],
    ['more nodes than a page holds', () => forged({ id: 'a', type: 'div', children: Array.from({ length: IMPORT_LIMITS.outputNodes }, (_, i) => ({ id: `c${i}`, type: 'i' })) }), DETAILS.overNodes],
    ['nodes nested past the output depth', () => {
      let node: Record<string, unknown> = { id: 'leaf', type: 'i' };
      for (let i = 0; i < IMPORT_LIMITS.outputDepth + 1; i += 1) node = { type: 'div', children: [node] };
      return forged(node);
    }, DETAILS.overDepth],
  ])('%s', (_name, make, detail) => {
    const read = readBundle(make(), PROJECT);
    expect(read.nodes).toBeUndefined();
    expect(read.verdict).toBe('not-imported');
    expect(read.found.map((line) => line.detail)).toContain(detail);
  });

  it('reads the largest bundle it accepts quickly', () => {
    const nodes = { id: 'a', type: 'div', children: Array.from({ length: IMPORT_LIMITS.outputNodes - 1 }, (_, i) => ({ id: `c${i}`, type: 'p', props: { children: 'x'.repeat(1_000), title: 'y'.repeat(400) } })) };
    const raw = forged(nodes);
    expect(raw.length).toBeLessThan(BUNDLE_LIMITS.bytes);
    const started = performance.now();
    const read = readBundle(raw, PROJECT);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(read.nodes?.children).toHaveLength(IMPORT_LIMITS.outputNodes - 1);
  });

  it('never throws, whatever it is given', () => {
    for (const raw of [undefined, 1, 'x', [], { format: 1 }, { format: 1, report: [] }, { format: 1, report: { lines: 'x' } }, { format: 1, nodes: 5, report: { lines: [] } }] as unknown[]) {
      expect(() => readBundle(raw as ImportBundle, PROJECT)).not.toThrow();
    }
  });
});

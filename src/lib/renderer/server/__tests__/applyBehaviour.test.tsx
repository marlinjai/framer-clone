// The behaviour pass through the real published path: hydration, the pass, the sheet
// and the markup. See docs/plans/2026-11-02-behaviour-model.md. What only a browser
// can say, the gate and no-JavaScript, is in test/score/behaviourCompile.score.ts.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CommerceServerRepository, ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { hydrateBindings } from '@/lib/renderer/publish/hydrateBindings';
import type { CmsReadRepository } from '@/server/cms';
import type { BreakpointRef } from '@/lib/responsive/cascade';
import { MAX_TRIGGERS_PER_PAGE, type StateValue, type Trigger } from '@/lib/behaviour/format';
import { parseComponents } from '@/lib/components/definition';
import { expandPlacements } from '@/lib/components/expand';
import { applyBehaviour } from '../applyBehaviour';
import { applyResponsiveStyles } from '../applyResponsiveStyles';
import { renderPublishedPage } from '../renderPublishedPage';

const BPS: BreakpointRef[] = [{ id: 'desktop', minWidth: 1280 }, { id: 'phone', minWidth: 320 }];

const bool = (id: string, initial = false): StateValue => ({ id, name: id, type: 'boolean', initial });
const num = (id: string, initial = 0): StateValue => ({ id, name: id, type: 'number', initial });
const choice = (id: string, options: string[]): StateValue => ({ id, name: id, type: 'choice', initial: options[0], options });
const text = (id: string, initial = ''): StateValue => ({ id, name: id, type: 'text', initial });
const click = (...actions: unknown[]): Trigger => ({ id: 't', on: 'click', do: actions }) as Trigger;

const node = (id: string, type: string, props: Record<string, unknown> = {}, ...children: ComponentNode[]): ComponentNode =>
  ({ id, type, props, children }) as ComponentNode;
const behaviour = (value: object) => ({ behaviour: value });
const propsOf = (n: ComponentNode | undefined) => (n?.props ?? {}) as Record<string, unknown>;

/** A Collection of `rows` rows over `template`. */
const collection = (rows: number, template: ComponentNode): { root: ComponentNode; cmsRepo: CmsReadRepository } => ({
  root: { id: 'list', type: 'ul', props: { 'data-component-kind': 'collection' }, bindings: { collection: { mode: 'read', expression: 'c1' } }, children: [template] } as ComponentNode,
  cmsRepo: {
    listRows: async () => ({ rows: Array.from({ length: rows }, (_, index) => ({ id: `r${index}`, values: { title: `Row ${index}` } })), total: rows }),
    getRow: async () => null,
  } as unknown as CmsReadRepository,
});

const noCms = { listRows: async () => ({ rows: [], total: 0 }), getRow: async () => null } as unknown as CmsReadRepository;
const commerceRepo = {
  listProducts: async () => ({ products: [{ id: 'p1', title: 'One', handle: 'one' }, { id: 'p2', title: 'Two', handle: 'two' }], total: 2 }),
} as unknown as CommerceServerRepository;

async function published(root: ComponentNode, cmsRepo: CmsReadRepository = noCms) {
  const { body, behaviour: program } = await renderPublishedPage({ root, pageParams: {}, cmsRepo, commerceRepo, breakpoints: BPS });
  const html = renderToStaticMarkup(<>{body}</>);
  return { html, program, dom: new DOMParser().parseFromString(html, 'text/html') };
}

let warn: MockInstance;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** Every problem with the `id`s of a document: repeats, and references to nothing. */
function idProblems(dom: Document): string[] {
  const ids = [...dom.querySelectorAll('[id]')].map((el) => el.id);
  const known = new Set(ids);
  const problems = ids.filter((id, index) => ids.indexOf(id) !== index).map((id) => `repeated ${id}`);
  for (const attr of ['for', 'aria-controls', 'aria-labelledby', 'aria-describedby', 'aria-owns', 'aria-activedescendant', 'popovertarget', 'commandfor']) {
    for (const el of dom.querySelectorAll(`[${attr}]`)) {
      for (const id of (el.getAttribute(attr) ?? '').split(/\s+/)) if (!known.has(id)) problems.push(`${attr} points at ${id}`);
    }
  }
  for (const el of dom.querySelectorAll('a[href^="#"]')) {
    const id = (el.getAttribute('href') ?? '').slice(1);
    if (id && !known.has(id)) problems.push(`href points at ${id}`);
  }
  return problems;
}

describe('a page with no behaviour', () => {
  it('gets the same tree back', () => {
    const root = node('a', 'div', { style: { color: 'red' } }, node('b', 'p', { children: 'x' }));
    const result = applyBehaviour(root);
    expect(result.root).toBe(root);
    expect(result.program).toBeNull();
    expect(result.hasGate).toBe(false);
  });

  it('keeps a stored data-fc attribute, since nothing honours it there', () => {
    const root = node('a', 'div', { 'data-fc-n': 'x' });
    expect(applyBehaviour(root).root).toBe(root);
  });

  it('writes no gate, no mark and no script', async () => {
    const { html, program } = await published(node('a', 'div', {}, node('b', 'p', { children: 'x' })));
    expect(program).toBeNull();
    expect(html).not.toMatch(/data-fc-(?:b|n|i|scope|behaviour)|data-fcs-/);
  });

  it('drops a rule that reads state, since no state exists', async () => {
    const { html } = await published(node('a', 'div', { rules: [{ id: 'r', selector: '&', when: { state: 's', eq: true }, style: { color: 'red' } }] }));
    expect(html).not.toContain('color:red');
    expect(warn).toHaveBeenCalledOnce();
  });

  it('drops a rule for where the gate is down, which would otherwise hold forever', async () => {
    const { html } = await published(node('a', 'div', { rules: [{ id: 'r', selector: '&', gate: 'off', style: { color: 'red' } }] }));
    expect(html).not.toContain('color:red');
  });

  it('still fixes an id a Collection repeats, the one exception', async () => {
    const { root, cmsRepo } = collection(3, node('tpl', 'li', {}, node('l', 'label', { htmlFor: 'field', children: 'Name' }), node('i', 'input', { id: 'field' })));
    const { dom } = await published(root, cmsRepo);
    expect(idProblems(dom)).toEqual([]);
    expect([...dom.querySelectorAll('input')].map((el) => el.id)).toEqual(['field', 'field-r1', 'field-r2']);
    expect([...dom.querySelectorAll('label')].map((el) => el.getAttribute('for'))).toEqual(['field', 'field-r1', 'field-r2']);
  });

  it('never hands a row index to an island', async () => {
    const hydrated = await hydrateBindings(collection(2, node('buy', 'div', { 'data-component-kind': 'add-to-cart' })).root, {}, collection(2, node('x', 'div')));
    expect(hydrated.children?.[1].cloneIndex).toBe(1);
    const { root } = applyResponsiveStyles(applyBehaviour(hydrated).root, BPS);
    expect(root.children?.[1]).not.toHaveProperty('cloneIndex');
  });
});

describe('a page with state and no trigger', () => {
  const page = () =>
    node('page', 'main', behaviour({ state: [bool('open', true), text('typed', 'x')] }),
      node('panel', 'div', {
        ...behaviour({ showWhen: { state: 'open', eq: false }, noScript: 'hide', bind: [{ attr: 'aria-expanded', from: { get: 'open' } }] }),
        rules: [
          { id: 'w', selector: '&', when: { state: 'open', eq: true }, style: { color: 'green' } },
          { id: 'g', selector: '&', gate: 'off', style: { color: 'blue' } },
        ],
      }));

  it('reads what the server wrote, with no gate', async () => {
    const { html, program } = await published(page());
    expect(program).toBeNull();
    expect(html).not.toContain('data-fc-behaviour-boot');
    expect(html).toContain('.fc_r-panel.fc_r-panel:where([data-fcs-open="true"] *, [data-fcs-open="true"]){color:green}');
    expect(html).not.toContain('html[data-fc-b]');
    expect(html).toMatch(/<main data-fcs-open="true"/);
  });

  it('keeps no mark for a runtime that never comes', async () => {
    const { html } = await published(page());
    expect(html).not.toMatch(/data-fc-(?:n|i|scope|v)=/);
    expect(html).toContain('aria-expanded="true"');
  });

  it('drops what waits for a script', async () => {
    const { html } = await published(page());
    expect(html).not.toContain('color:blue');
    expect(html).not.toContain('html:not([data-fc-b])');
  });

  it('never writes text state', async () => {
    const { html } = await published(page());
    expect(html).not.toContain('data-fcs-typed');
  });

  it('applies a showWhen from the first value, behind no gate', async () => {
    const { html } = await published(page());
    expect(html).toMatch(/\.fc_r-panel\.fc_r-panel:where\(:not\(:where\(\[data-fcs-open="false"\] \*, \[data-fcs-open="false"\]\)\)\)\{display:none !important\}/);
  });
});

describe('a page with a trigger', () => {
  const accordion = () =>
    node('item', 'div', behaviour({ state: [bool('s1')] }),
      node('btn', 'button', { children: 'Open', ...behaviour({ on: [click({ toggle: 's1' })], bind: [{ attr: 'aria-expanded', from: { get: 's1' } }] }) }),
      node('panel', 'div', { children: 'Body', ...behaviour({ showWhen: { state: 's1', eq: true } }) }));

  it('compiles the accordion of the contract', async () => {
    const { html, dom, program } = await published(accordion());
    expect(html).toContain('data-fc-behaviour-boot');
    const item = dom.querySelector('[data-fc-n="item"]');
    expect(item?.getAttribute('data-fcs-s1')).toBe('false');
    expect(item?.hasAttribute('data-fc-scope')).toBe(true);
    expect(dom.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
    expect(dom.querySelector('button')?.getAttribute('data-fc-n')).toBe('btn');
    expect(Object.keys(program?.nodes ?? {}).sort()).toEqual(['btn', 'item']);
    expect(program?.nodes.btn[0].on?.[0].do).toEqual([{ toggle: 's1' }]);
    expect(html).toContain(':where(html[data-fc-b]) .fc_r-panel.fc_r-panel:where(:not(:where([data-fcs-s1="true"] *, [data-fcs-s1="true"]))){display:none !important}');
  });

  it('hides a button that needs the script, where the gate is down', async () => {
    const { html } = await published(accordion());
    expect(html).toContain('.fc_r-btn.fc_r-btn:where(html:not([data-fc-b]) *){display:none !important}');
  });

  describe('the default for what a script runs', () => {
    const bound = { on: [click({ toggle: 's1' })], bind: [{ attr: 'aria-expanded', from: { get: 's1' } }] };
    const page = (...children: ComponentNode[]) => published(node('p', 'div', behaviour({ state: [bool('s1')] }), ...children));
    const link = node('l', 'a', { href: '/x', children: 'Go' });

    it('keeps everything that may hold content or has a job of its own', async () => {
      const { html } = await page(
        node('nav1', 'nav', behaviour(bound), link),
        node('around', 'div', behaviour(bound), node('l2', 'a', { href: '/y' })),
        node('words', 'span', { children: 'Plain', ...behaviour(bound) }),
        node('link', 'a', { href: '/x', ...behaviour(bound) }),
        node('rolelink', 'a', { href: '/x', role: 'button', ...behaviour(bound) }),
        node('pop', 'button', { popoverTarget: 'm', ...behaviour(bound) }),
        node('cmd', 'button', { commandfor: 'm', ...behaviour(bound) }),
        node('sub', 'button', { type: 'submit', ...behaviour(bound) }),
        node('res', 'button', { type: 'reset', ...behaviour(bound) }),
        node('fa', 'button', { type: 'button', formAction: '/x', ...behaviour(bound) }),
        node('ft', 'button', { type: 'button', form: 'm', ...behaviour(bound) }),
        node('shown', 'button', behaviour({ ...bound, noScript: 'show' })),
        node('holds', 'button', { type: 'button', ...behaviour(bound) }, link),
        node('m', 'div', { id: 'm' }),
      );
      expect(html).not.toContain('html:not([data-fc-b])');
    });

    it('keeps a button a form would submit with, plain or an island', async () => {
      const plain = await page(node('f', 'form', {}, node('wrap', 'div', {}, node('send', 'button', { children: 'Send', ...behaviour(bound) }))));
      expect(plain.html).not.toContain('html:not([data-fc-b])');
      const island = await page(node('f', 'div', { 'data-form-kind': 'form' }, node('send', 'button', { children: 'Send', ...behaviour(bound) })));
      expect(island.html).not.toContain('html:not([data-fc-b])');
    });

    it('hides a button with a script as its only job', async () => {
      const { html } = await page(
        node('a', 'button', { children: 'Open', ...behaviour(bound) }),
        node('b', 'button', { type: 'button', ...behaviour(bound) }, node('t', '#text', { children: 'Open' }), node('i', 'svg')),
        node('c', 'div', { role: 'button', tabIndex: 0, ...behaviour(bound) }, node('j', 'img', { alt: '' })),
        node('d', 'f', {}, node('e', 'button', { type: 'button', ...behaviour(bound) })),
      );
      for (const key of ['a', 'b', 'c', 'e']) expect(html).toContain(`.fc_r-${key}.fc_r-${key}:where(html:not([data-fc-b]) *){display:none !important}`);
    });

    it('still hides what an author asked to hide, whatever it is', async () => {
      const { html } = await page(node('n', 'nav', behaviour({ ...bound, noScript: 'hide' })));
      expect(html).toContain('.fc_r-n.fc_r-n:where(html:not([data-fc-b]) *)');
    });
  });

  it('reads a list repeated across rows once', async () => {
    const list = [{ id: 'r', selector: '&', when: { state: 's1', eq: true }, style: { color: 'red' } }, { id: 'x', selector: '&', when: { state: 'nope', eq: true }, style: { color: 'blue' } }];
    const { root, cmsRepo } = collection(40, node('tpl', 'li', { rules: list }));
    const { html } = await published(node('p', 'div', behaviour({ state: [bool('s1')], on: [click({ toggle: 's1' })] }), root), cmsRepo);
    expect(html.match(/color:red/g)).toHaveLength(1);
    expect((warn.mock.calls[0][1] as unknown[])).toHaveLength(1);
  });

  it('does not hide what only watches a native event', async () => {
    const { html } = await published(node('p', 'div', behaviour({ state: [bool('s1')] }),
      node('menu', 'div', behaviour({ on: [{ id: 'n', on: 'toggle', do: [{ set: 's1', value: { eq: [{ event: 'newState' }, 'open'] } }] }], bind: [{ attr: 'aria-hidden', from: { not: { not: { get: 's1' } } } }] }))));
    expect(html).not.toContain('html:not([data-fc-b])');
  });

  it('marks a target, and nothing that needs no mark', async () => {
    const { dom } = await published(node('p', 'div', {},
      node('a', 'button', behaviour({ on: [click({ focus: 'b' }, { delay: 20, do: [{ scroll: 'c' }] })] })),
      node('b', 'input'),
      node('c', 'div'),
      node('d', 'div', { children: 'plain' })));
    expect([...dom.querySelectorAll('[data-fc-n]')].map((el) => el.getAttribute('data-fc-n'))).toEqual(['a', 'b', 'c']);
  });

  it('finds what expressions and a virtual group name', async () => {
    const { dom } = await published(node('p', 'div', behaviour({ state: [num('n'), text('t')] }),
      node('owner', 'input', behaviour({ on: [{ id: 'k', on: 'keydown', keys: ['Enter'], do: [{ set: 't', value: { active: 'g' } }] }] })),
      node('g', 'ul', behaviour({ group: { role: 'option', axis: 'line', virtual: { owner: 'owner' } } })),
      node('ruler', 'div'),
      node('sep', 'div', behaviour({ on: [{ id: 'm', on: 'pointermove', do: [{ set: 'n', value: { pointer: 'x', of: 'ruler', as: 'percent' } }] }] }))));
    expect([...dom.querySelectorAll('[data-fc-n]')].map((el) => el.getAttribute('data-fc-n')).sort()).toEqual(['g', 'owner', 'p', 'ruler', 'sep']);
  });

  it('never lets behaviour reach the page or the program unread', async () => {
    const root = node('p', 'div', behaviour({ state: [bool('s')], extra: 'x', on: [click({ toggle: 's' }), { id: 'bad', on: 'click', do: [{ click: 'x' }] }] }));
    const { html, program } = await published(root);
    expect(html).not.toContain('behaviour=');
    expect(html).not.toContain('extra');
    expect(JSON.stringify(program)).not.toContain('bad');
    expect(warn).toHaveBeenCalledOnce();
  });

  it('leaves a node visible when its showWhen is refused', async () => {
    const { html } = await published(node('p', 'div', behaviour({ state: [text('t')], on: [click({ set: 't', value: 'x' })] }),
      node('a', 'div', behaviour({ showWhen: { state: 't', eq: 'x' } }))));
    expect(html).not.toContain('display:none !important');
  });

  it('takes nothing from a behaviour that is not one', async () => {
    const { html } = await published(node('a', 'div', behaviour('nonsense' as unknown as object)));
    expect(html).not.toContain('nonsense');
    expect(warn).toHaveBeenCalledOnce();
  });

  it('holds no behaviour on a node with no stable id', async () => {
    const { program, html } = await published({ type: 'div', props: behaviour({ state: [bool('s')], on: [click({ toggle: 's' })] }) } as ComponentNode);
    expect(program).toBeNull();
    expect(html).not.toContain('data-fcs-s');
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('what a stored attribute could forge', () => {
  it('drops every attribute the selectors and the runtime honour', async () => {
    const { dom } = await published(node('p', 'div', behaviour({ state: [bool('s', true)], on: [click({ toggle: 's' })] }),
      node('form', 'div', { 'data-form-kind': 'form' },
        node('email', 'div', { 'data-form-kind': 'form-field', fieldType: 'email', fieldName: 'e', 'data-fc-n': 'p', 'data-fcs-s': 'false', 'DATA-FC-I': '3', 'data-fc-scope': '', 'data-fc-v': '1' }))));
    expect(dom.querySelectorAll('[data-fc-n]')).toHaveLength(1);
    expect(dom.querySelectorAll('[data-fcs-s]')).toHaveLength(1);
    expect(dom.querySelectorAll('[data-fc-i], [data-fc-v]')).toHaveLength(0);
  });

  it('keeps an author attribute that merely starts alike', async () => {
    const { dom } = await published(node('p', 'div', { 'data-fc-note': 'x', ...behaviour({ state: [bool('s')] }) }));
    expect(dom.querySelector('[data-fc-note]')).not.toBeNull();
  });

  it('binds nothing into a behaviour', async () => {
    const template = { ...node('row', 'li', behaviour({ state: [bool('s')] })), bindings: { 'behaviour.state.0.initial': { mode: 'read', expression: '{{row.title}}' } } } as ComponentNode;
    const { root, cmsRepo } = collection(1, template);
    const { dom } = await published(root, cmsRepo);
    expect(dom.querySelector('li')?.getAttribute('data-fcs-s')).toBe('false');
  });
});

describe('rows', () => {
  const row = () =>
    node('tpl', 'li', behaviour({ state: [bool('s1')] }),
      node('btn', 'button', behaviour({ on: [click({ toggle: 's1' }, { focus: 'panel' })], bind: [{ attr: 'aria-expanded', from: { get: 's1' } }] })),
      node('panel', 'div', { children: 'Body', ...behaviour({ showWhen: { state: 's1', eq: true } }) }));

  it('gives each clone its scope, its index and its own state', async () => {
    const { root, cmsRepo } = collection(3, row());
    const { dom } = await published(root, cmsRepo);
    const rows = [...dom.querySelectorAll('li')];
    expect(rows.map((el) => el.getAttribute('data-fc-i'))).toEqual(['0', '1', '2']);
    for (const el of rows) {
      expect(el.hasAttribute('data-fc-scope')).toBe(true);
      expect(el.getAttribute('data-fcs-s1')).toBe('false');
    }
  });

  it('makes a row a scope with no state of its own, so a target resolves inside it', async () => {
    const { root, cmsRepo } = collection(2, node('tpl', 'li', {}, node('a', 'button', behaviour({ on: [click({ focus: 'b' })] })), node('b', 'input')));
    const { dom } = await published(root, cmsRepo);
    for (const el of dom.querySelectorAll('li')) expect(el.hasAttribute('data-fc-scope')).toBe(true);
    expect(dom.querySelector('ul')?.hasAttribute('data-fc-scope')).toBe(false);
  });

  it('marks no row a program does not reach', async () => {
    const { root, cmsRepo } = collection(2, node('tpl', 'li', { children: 'x' }));
    const page = node('p', 'div', behaviour({ state: [bool('s')], on: [click({ toggle: 's' })] }), root);
    const { dom } = await published(page, cmsRepo);
    expect(dom.querySelectorAll('[data-fc-i]')).toHaveLength(0);
  });

  it('shares one program entry and one rule across every row', async () => {
    const { root, cmsRepo } = collection(50, row());
    const { html, program } = await published(root, cmsRepo);
    expect(Object.keys(program?.nodes ?? {}).sort()).toEqual(['btn', 'tpl']);
    expect(program?.nodes.btn).toHaveLength(1);
    expect(html.match(/\.fc_r-panel\.fc_r-panel/g)).toHaveLength(1);
  });

  it('charges a repeated entry to the page caps once', async () => {
    const triggers = Array.from({ length: 16 }, (_, index) => ({ ...click({ toggle: 's1' }), id: `t${index}` }));
    const rows = MAX_TRIGGERS_PER_PAGE / 16 + 50;
    const { root, cmsRepo } = collection(rows, node('tpl', 'li', behaviour({ state: [bool('s1')], on: triggers })));
    const { dom, program } = await published(root, cmsRepo);
    expect(warn).not.toHaveBeenCalled();
    expect(dom.querySelectorAll('[data-fc-n="tpl"]')).toHaveLength(rows);
    expect(program?.nodes.tpl).toHaveLength(1);
  });

  it('reads each row in a binding', async () => {
    const { root, cmsRepo } = collection(3, node('tab', 'li', behaviour({ bind: [{ attr: 'data-u-at', from: { row: 'index' } }] })));
    const { dom } = await published(node('p', 'div', behaviour({ state: [num('n')], on: [click({ set: 'n', value: 1 })] }), root), cmsRepo);
    expect([...dom.querySelectorAll('li')].map((el) => el.getAttribute('data-u-at'))).toEqual(['0', '1', '2']);
  });

  it('turns tabs from a Collection into a binding a shared rule can read', async () => {
    const tabs = node('tabs', 'div', behaviour({ state: [num('n', 1)] }));
    const { root, cmsRepo } = collection(3, node('tpl', 'li', {},
      node('tab', 'button', behaviour({ on: [click({ set: 'n', value: { row: 'index' } })] })),
      node('tabpanel', 'div', behaviour({ showWhen: { state: 'n', eq: { row: 'index' } } }))));
    const { html, dom } = await published({ ...tabs, children: [root] }, cmsRepo);
    expect([...dom.querySelectorAll('div div, li div')].map((el) => el.getAttribute('data-u-on'))).toEqual(['false', 'true', 'false']);
    expect(html).toContain(':where(html[data-fc-b]) .fc_r-tabpanel.fc_r-tabpanel:not([data-u-on="true"]){display:none !important}');
  });

  it('keeps a node visible that compares with a row it is not in', async () => {
    const { html } = await published(node('p', 'div', behaviour({ state: [num('n')], on: [click({ set: 'n', value: 1 })] }),
      node('a', 'div', behaviour({ showWhen: { state: 'n', eq: { row: 'index' } } }))));
    expect(html).not.toContain('data-u-on');
    expect(warn).toHaveBeenCalledOnce();
  });

  it('keeps a node visible when a binding already writes what its showWhen would', async () => {
    const { root, cmsRepo } = collection(1, node('a', 'div', behaviour({ showWhen: { state: 'n', eq: { row: 'index' } }, bind: [{ attr: 'data-u-on', from: 'mine' }] })));
    const { html } = await published(node('p', 'div', behaviour({ state: [num('n')], on: [click({ set: 'n', value: 1 })] }), root), cmsRepo);
    expect(html).not.toContain('display:none !important');
    expect(html).toContain('data-u-on="mine"');
  });

  it('leaves no repeated id and no dangling reference in the published page', async () => {
    const template = node('tpl', 'li', behaviour({ state: [bool('s1')] }),
      node('l', 'label', { htmlFor: 'field', id: 'name', children: 'Name' }),
      node('i', 'input', { id: 'field', 'aria-labelledby': 'name hint', 'aria-describedby': 'hint outside' }),
      node('h', 'p', { id: 'hint', children: 'Hint' }),
      node('b', 'button', { popoverTarget: 'menu', 'aria-controls': 'menu', children: 'Open' }),
      node('m', 'div', { id: 'menu', popover: 'auto' }),
      node('k', 'a', { href: '#hint', children: 'Jump' }),
      node('o', 'a', { href: '#outside', children: 'Out' }));
    const { root, cmsRepo } = collection(4, template);
    const page = node('p', 'div', {}, node('out', 'div', { id: 'outside' }), root);
    const { dom } = await published(page, cmsRepo);
    expect(idProblems(dom)).toEqual([]);
    const buttons = [...dom.querySelectorAll('button')].map((el) => el.getAttribute('popovertarget'));
    expect(new Set(buttons).size).toBe(4);
    expect([...dom.querySelectorAll('a')].filter((el) => el.textContent === 'Out').map((el) => el.getAttribute('href'))).toEqual(Array(4).fill('#outside'));
  });

  it('refuses a bound id reference in a clone that could not follow its row', async () => {
    const { root, cmsRepo } = collection(2, node('tpl', 'li', {},
      node('a', 'button', { id: 'x', ...behaviour({ state: [choice('c', ['x', 'y'])], on: [click({ set: 'c', value: 'y' })], bind: [{ attr: 'aria-controls', from: { get: 'c' } }] }) })));
    const { html, program } = await published(root, cmsRepo);
    expect(html).not.toContain('aria-controls');
    expect(program?.nodes.a[0].bind).toBeUndefined();
  });

  it('keeps a constant one, which the page writes once and follows', async () => {
    const { root, cmsRepo } = collection(2, node('tpl', 'li', {},
      node('a', 'button', behaviour({ on: [click({ focus: 'p' })], bind: [{ attr: 'aria-controls', from: 'p' }] })),
      node('p', 'div', { id: 'p' })));
    const { dom, program } = await published(root, cmsRepo);
    expect(idProblems(dom)).toEqual([]);
    expect(program?.nodes.a[0].bind).toBeUndefined();
    expect(dom.querySelectorAll('button')[1].getAttribute('aria-controls')).toBe('p-r1');
  });

  it('keeps nested Collections apart', async () => {
    const inner = { id: 'inner', type: 'ul', props: { 'data-component-kind': 'collection' }, bindings: { collection: { mode: 'read', expression: 'c2' } }, children: [node('leaf', 'li', {}, node('x', 'span', { id: 'deep', 'aria-owns': 'deep' }))] } as ComponentNode;
    const { root, cmsRepo } = collection(2, node('outer', 'li', {}, inner));
    const { dom } = await published(root, cmsRepo);
    expect(idProblems(dom)).toEqual([]);
    expect(dom.querySelectorAll('span')).toHaveLength(4);
  });
});

describe('islands', () => {
  const shop = (row: ComponentNode): ComponentNode => ({ id: 'shop', type: 'div', props: { 'data-component-kind': 'product-list' }, bindings: { products: { mode: 'read', expression: 'all' } }, children: [row] }) as ComponentNode;

  it('claims every descendant of a commerce list on a hydrated page', async () => {
    const { program, html } = await published(shop(node('card', 'article', behaviour({ on: [click({ emit: 'x' })] }))));
    expect(program).toBeNull();
    expect(html).not.toContain('data-fc-n');
    expect(warn.mock.calls[0][1][0].reason).toMatch(/island claims/);
  });

  it('claims a row deep in a commerce list and holds it to aria and data-u', async () => {
    const { dom } = await published(node('p', 'div', behaviour({ state: [bool('s')], on: [click({ toggle: 's' })] }),
      shop(node('card', 'article', {}, node('title', 'h2', {
        children: 'x',
        ...behaviour({ bind: [{ attr: 'aria-busy', from: { get: 's' } }, { attr: 'value', from: 'x' }, { text: 'y' }] }),
      })))));
    expect(dom.querySelector('h2')?.getAttribute('aria-busy')).toBe('false');
    expect(dom.querySelector('h2')?.textContent).toBe('x');
    expect(dom.querySelector('h2')?.hasAttribute('value')).toBe(false);
  });

  it('refuses a verb on a commerce descendant from outside the island', async () => {
    const { program } = await published(node('p', 'div', {},
      node('a', 'button', behaviour({ on: [click({ setProp: 'title', prop: 'disabled', value: true }), { id: 'ok', on: 'click', do: [{ scroll: 'title' }] }] })),
      shop(node('card', 'article', {}, node('title', 'h2', { children: 'x' })))));
    expect(program?.nodes.a[0].on?.map((trigger) => trigger.id)).toEqual(['ok']);
  });

  it('strips behaviour from what an interactive island receives', async () => {
    const island = node('buy', 'div', { 'data-component-kind': 'add-to-cart', ...behaviour({ on: [click({ emit: 'x' })] }) }, node('inner', 'span', behaviour({ state: [bool('s')] })));
    const { root } = applyBehaviour(node('p', 'div', {}, island));
    expect(JSON.stringify(root)).not.toContain('"behaviour"');
  });

  it('lets a trigger sit around a form, and not on its fields', async () => {
    const { program } = await published(node('p', 'div', behaviour({ state: [bool('s')] }),
      node('form', 'div', { 'data-form-kind': 'form', ...behaviour({ on: [{ id: 'sub', on: 'submit', do: [{ set: 's', value: true }] }] }) },
        node('f', 'div', { 'data-form-kind': 'form-field', fieldType: 'email', fieldName: 'e', ...behaviour({ on: [{ id: 'bad', on: 'focus', do: [{ set: 's', value: true }] }] }) }))));
    expect(program?.nodes.form[0].on?.map((trigger) => trigger.id)).toEqual(['sub']);
    expect(program?.nodes.f).toBeUndefined();
  });

  it('reaches only page state from the hoisted sticky bar', async () => {
    const bar = node('bar', 'div', { 'data-sticky-cta': 'bar', ctaLabel: 'Book', ctaHref: '#x', ...behaviour({ bind: [{ attr: 'aria-hidden', from: { get: 'inner' } }, { attr: 'aria-busy', from: { get: 'top' } }] }) });
    const { dom } = await published(node('p', 'div', behaviour({ state: [bool('top')] }), node('sec', 'div', behaviour({ state: [bool('inner')] }), bar)));
    const hoisted = dom.querySelector('[aria-busy]');
    expect(hoisted?.getAttribute('aria-busy')).toBe('false');
    expect(hoisted?.hasAttribute('aria-hidden')).toBe(false);
    expect(hoisted?.hasAttribute('data-fc-sticky-cta')).toBe(true);
  });
});

describe('keys', () => {
  it('keys marks and the program on classKey, so a reference inside a definition holds', async () => {
    const card = (placement: string) => ({
      ...node(`${placement}__root`, 'div', behaviour({ state: [bool('s')] }),
        { ...node(`${placement}__btn`, 'button', behaviour({ on: [click({ toggle: 's' }, { focus: 'def-panel' })] })), classKey: 'def-btn' },
        { ...node(`${placement}__panel`, 'div'), classKey: 'def-panel' }),
      classKey: 'def-root',
      placementRoot: true,
    });
    const { dom, program } = await published(node('p', 'div', {}, card('a'), card('b')));
    expect(Object.keys(program?.nodes ?? {}).sort()).toEqual(['def-btn', 'def-root']);
    expect(dom.querySelectorAll('[data-fc-n="def-panel"]')).toHaveLength(2);
    expect(dom.querySelectorAll('[data-fc-scope]')).toHaveLength(2);
  });

  it('makes a placement root a scope with no state of its own', async () => {
    const placed = (id: string) => ({
      ...node(id, 'div', {}, { ...node(`${id}__a`, 'button', behaviour({ on: [click({ focus: 'd-b' })] })), classKey: 'd-a' }, { ...node(`${id}__b`, 'input'), classKey: 'd-b' }),
      placementRoot: true,
    });
    const { dom } = await published(node('p', 'div', {}, placed('x'), placed('y')));
    expect(dom.querySelectorAll('[data-fc-scope]')).toHaveLength(2);
  });

  it('compiles a definition placed twice through the real expansion', async () => {
    const tree = {
      id: 'c-root', type: 'div', props: behaviour({ state: [bool('s')] }),
      children: [
        { id: 'c-btn', type: 'button', props: { children: 'Open', ...behaviour({ on: [click({ toggle: 's' }, { focus: 'c-panel' })] }) } },
        { id: 'c-panel', type: 'div', props: { children: 'Body', tabIndex: -1, ...behaviour({ showWhen: { state: 's', eq: true } }) } },
      ],
    };
    const frames = { a: { id: 'a', canvasNodeType: 'viewport', breakpointId: 'd', breakpointMinWidth: 1280 } };
    const { definitions } = parseComponents({ card: { id: 'card', name: 'Card', page: { appComponentTree: tree, canvasNodes: frames }, inputs: [], states: [] } });
    const placed = (id: string) => ({ id, type: '#component', props: { component: 'card' } }) as ComponentNode;
    const root = expandPlacements(node('p', 'main', {}, placed('one'), placed('two')), definitions, BPS);
    const { html, dom, program } = await published(root);
    expect(Object.keys(program?.nodes ?? {}).sort()).toEqual(['c-btn', 'c-root']);
    expect(dom.querySelectorAll('[data-fc-scope]')).toHaveLength(2);
    expect(dom.querySelectorAll('[data-fc-n="c-panel"]')).toHaveLength(2);
    expect(html.match(/\.fc_r-c-panel\.fc_r-c-panel/g)).toHaveLength(1);
  });

  it('never hands the placement root mark to an island', async () => {
    const tree = { id: 'c-root', type: 'div', props: { 'data-component-kind': 'add-to-cart' } };
    const frames = { a: { id: 'a', canvasNodeType: 'viewport', breakpointId: 'd', breakpointMinWidth: 1280 } };
    const { definitions } = parseComponents({ buy: { id: 'buy', name: 'Buy', page: { appComponentTree: tree, canvasNodes: frames }, inputs: [], states: [] } });
    const root = expandPlacements(node('p', 'main', {}, { id: 'one', type: '#component', props: { component: 'buy' } } as ComponentNode), definitions, BPS);
    expect(root.children?.[0].placementRoot).toBe(true);
    const { root: styled } = applyResponsiveStyles(root, BPS);
    expect(styled.children?.[0]).not.toHaveProperty('placementRoot');
  });

  it('runs a different entry for a placement that differs, on one key', async () => {
    const button = (id: string, trigger: Trigger) => ({ ...node(id, 'button', behaviour({ on: [trigger] })), classKey: 'def' });
    const { dom, program } = await published(node('p', 'div', {},
      button('a', click({ emit: 'one' })), button('b', click({ emit: 'two' })), button('c', click({ emit: 'one' }))));
    expect(program?.nodes.def).toHaveLength(2);
    expect([...dom.querySelectorAll('button')].map((el) => el.getAttribute('data-fc-v'))).toEqual([null, '1', null]);
    expect([...dom.querySelectorAll('button')].map((el) => el.getAttribute('data-fc-n'))).toEqual(['def', 'def', 'def']);
  });

  it('runs nothing on a node that shares a key and has no behaviour', async () => {
    const { dom, program } = await published(node('p', 'div', {},
      { ...node('a', 'button'), classKey: 'def' },
      { ...node('b', 'button', behaviour({ on: [click({ focus: 'def' })] })), classKey: 'def' }));
    expect(program?.nodes.def).toEqual([{}, { on: [{ id: 't', on: 'click', do: [{ focus: 'def' }] }] }]);
    expect(dom.querySelectorAll('button')[1].getAttribute('data-fc-v')).toBe('1');
  });

  it('reads a key as an island when any node holding it is one', async () => {
    const { program } = await published(node('p', 'div', {},
      node('a', 'button', behaviour({ on: [click({ setProp: 'def', prop: 'disabled', value: true })] })),
      { ...node('plain', 'div'), classKey: 'def' },
      { ...node('field', 'div', { 'data-form-kind': 'form-field', fieldType: 'email', fieldName: 'e' }), classKey: 'def' }));
    expect(program).toBeNull();
    expect(warn.mock.calls[0][1][0].reason).toMatch(/island owns/);
  });

  it('files a row whose bound type changes what parses under its own entry', async () => {
    const template = { ...node('field', 'input', behaviour({ state: [choice('c', ['a', 'b'])], on: [{ id: 'k', on: 'keydown', keys: ['a'], do: [{ set: 'c', value: 'b' }] }] })), bindings: { type: { mode: 'read', expression: '{{row.kind}}' } } } as ComponentNode;
    const cmsRepo = { listRows: async () => ({ rows: [{ id: 'a', values: { kind: 'checkbox' } }, { id: 'b', values: { kind: 'text' } }], total: 2 }), getRow: async () => null } as unknown as CmsReadRepository;
    const { root } = collection(1, template);
    const { dom, program } = await published(root, cmsRepo);
    expect(program?.nodes.field).toHaveLength(2);
    expect(program?.nodes.field[1].on).toBeUndefined();
    expect([...dom.querySelectorAll('input')].map((el) => el.getAttribute('data-fc-v'))).toEqual([null, '1']);
  });
});

describe('what bindings write', () => {
  it('fills a text child, in both stored forms, for React to keep', async () => {
    const asProp = node('a', 'p', { children: 'old', ...behaviour({ bind: [{ text: { get: 't' } }] }) });
    const asNode = node('b', 'p', behaviour({ bind: [{ text: { get: 't' } }] }), node('tx', '#text', { children: 'old' }));
    const { dom } = await published(node('p', 'div', behaviour({ state: [text('t', 'first')], on: [click({ set: 't', value: 'x' })] }), asProp, asNode));
    expect([...dom.querySelectorAll('p')].map((el) => el.textContent)).toEqual(['first', 'first']);
  });

  it('asks React to leave a bound text alone', () => {
    const { root } = applyBehaviour(node('p', 'div', { children: 'old', ...behaviour({ state: [text('t', 'first')], bind: [{ text: { get: 't' } }] }) }));
    expect(propsOf(root).suppressHydrationWarning).toBe(true);
    expect(propsOf(root).children).toBe('first');
  });

  it('writes a custom property, with its unit, and a number as text', async () => {
    const { html } = await published(node('p', 'div', behaviour({ state: [num('n', 30)], bind: [{ cssVar: '--u-split', from: { get: 'n' }, unit: '%' }, { attr: 'aria-valuenow', from: { get: 'n' } }] })));
    expect(html).toContain('--u-split:30%');
    expect(html).toContain('aria-valuenow="30"');
  });

  it('writes booleans as an attribute reads them', async () => {
    const { dom } = await published(node('p', 'div', behaviour({ state: [bool('s', true)] }),
      node('d', 'details', { open: true, ...behaviour({ bind: [{ attr: 'open', from: { not: { get: 's' } } }] }) }),
      node('b', 'button', behaviour({ bind: [{ attr: 'disabled', from: { get: 's' } }, { attr: 'aria-pressed', from: { get: 's' } }] }))));
    expect(dom.querySelector('details')?.hasAttribute('open')).toBe(false);
    expect(dom.querySelector('button')?.hasAttribute('disabled')).toBe(true);
    expect(dom.querySelector('button')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('leaves a field for a person to change', () => {
    const { root } = applyBehaviour(node('p', 'input', { value: 'stored', ...behaviour({ state: [text('t')], bind: [{ attr: 'value', from: 'x' }] }) }));
    expect(propsOf(root)).toMatchObject({ defaultValue: 'x' });
    expect(propsOf(root)).not.toHaveProperty('value');
  });

  it('warns once per page, however many entries were refused', async () => {
    await published(node('p', 'div', behaviour({ bind: [{ attr: 'href', from: 'x' }, { attr: 'src', from: 'y' }], on: [{ id: 'x', on: 'nope', do: [] }] })));
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('the payloads of the review', () => {
  it('writes no address from a mixed map into a custom property, the sheet or the program', async () => {
    const mixed = (a: unknown, b: unknown) => ({ map: 'c', cases: { a, b } });
    const { html, program } = await published(node('p', 'div', {
      style: { color: 'red' },
      ...behaviour({ state: [choice('c', ['a', 'b'])], on: [click({ set: 'c', value: 'b' })], bind: [{ cssVar: '--u-x', from: { add: [mixed('url(http://evil.example/add', 1), mixed(')', 1)] } }] }),
    }));
    expect(html).not.toContain('evil.example');
    expect(JSON.stringify(program)).not.toContain('evil.example');
  });

  it('leaves a rule reading an id inside a row matching on every row', async () => {
    const { root, cmsRepo } = collection(3, node('rw', 'li', { rules: [{ id: 'r', selector: '& #badge', style: { color: 'red' } }] }, node('b', 'span', { id: 'badge', 'aria-owns': 'badge' })));
    const { dom, html } = await published(root, cmsRepo);
    expect(html).toContain('.fc_r-rw.fc_r-rw #badge{color:red}');
    expect([...dom.querySelectorAll('span')].map((el) => el.id)).toEqual(['badge', 'badge', 'badge']);
  });

  it('points an image map at its own row', async () => {
    const { root, cmsRepo } = collection(2, node('rw', 'li', {}, node('i', 'img', { src: '/a.png', useMap: '#m' }), node('m', 'map', { name: 'm' })));
    const { dom } = await published(root, cmsRepo);
    expect(dom.querySelectorAll('img')[1].getAttribute('usemap')).toBe('#m-r1');
    expect(dom.querySelectorAll('map')[1].getAttribute('name')).toBe('m-r1');
  });
});

describe('a rule with a condition', () => {
  const page = (rules: unknown[], states: StateValue[] = [bool('s1')]) =>
    node('p', 'div', behaviour({ state: states, on: [click({ emit: 'x' })] }), node('a1', 'div', { style: { color: '#111' }, rules }));

  it('writes the selector of the contract', async () => {
    const { html } = await published(page([{ id: 'r', selector: '&', when: { state: 's1', eq: true }, style: { color: '#0a0' } }]));
    expect(html).toContain(':where(html[data-fc-b]) .fc_r-a1.fc_r-a1:where([data-fcs-s1="true"] *, [data-fcs-s1="true"]){color:#0a0}');
  });

  it('moves Normal to the sheet, so a condition can beat it', async () => {
    const { dom } = await published(page([{ id: 'r', selector: '&', when: { state: 's1', eq: true }, style: { color: '#0a0' } }]));
    expect(dom.querySelector('.fc_r-a1')?.getAttribute('style')).toBeNull();
  });

  it('keeps the condition before a pseudo-element, where a browser can read it', async () => {
    const { html } = await published(page([{ id: 'r', selector: '&::before', when: { state: 's1', eq: true }, style: { content: '"x"' } }]));
    expect(html).toContain('.fc_r-a1.fc_r-a1:where([data-fcs-s1="true"] *, [data-fcs-s1="true"])::before{content:"x"}');
  });

  it('maps not, all and any, with no specificity', async () => {
    const { html } = await published(page([{
      id: 'r', selector: '&', style: { color: 'red' },
      when: { all: [{ not: { state: 's1', eq: true } }, { any: [{ state: 'c', eq: 'a' }, { state: 'n', eq: 2 }] }] },
    }], [bool('s1'), choice('c', ['a', 'b']), num('n')]));
    expect(html).toContain(
      '.fc_r-a1.fc_r-a1:where(:not(:where([data-fcs-s1="true"] *, [data-fcs-s1="true"])))'
      + ':where(:where([data-fcs-c="a"] *, [data-fcs-c="a"]), :where([data-fcs-n="2"] *, [data-fcs-n="2"])){color:red}',
    );
  });

  it('keeps list order, so a later rule wins a tie', async () => {
    const { html } = await published(page([
      { id: 'o', selector: '&', when: { state: 's1', eq: true }, style: { color: 'red' } },
      { id: 'h', selector: '&:hover', style: { color: 'blue' } },
    ]));
    expect(html.indexOf('color:red')).toBeLessThan(html.indexOf('color:blue'));
  });

  it('refuses text state, and state not on the path', async () => {
    const { html } = await published(node('p', 'div', behaviour({ state: [text('t')], on: [click({ emit: 'x' })] }),
      node('a', 'div', { rules: [{ id: 'r', selector: '&', when: { state: 't', eq: 'x' }, style: { color: 'red' } }] }),
      node('b', 'div', behaviour({ state: [bool('here')] })),
      node('c', 'div', { rules: [{ id: 'r', selector: '&', when: { state: 'here', eq: true }, style: { color: 'blue' } }] })));
    expect(html).not.toContain('color:red');
    expect(html).not.toContain('color:blue');
  });

  it('keeps the rest of a list when one rule is refused', async () => {
    const { html } = await published(page([
      { id: 'bad', selector: '&', when: { state: 'nope', eq: true }, style: { color: 'red' } },
      { id: 'good', selector: '&:hover', style: { color: 'blue' } },
    ]));
    expect(html).not.toContain('color:red');
    expect(html).toContain('color:blue');
  });

  it('emits a rule for where the gate is down, behind the look of the contract', async () => {
    const { html } = await published(page([{ id: 'r', selector: '&', gate: 'off', style: { color: 'red' } }]));
    expect(html).toContain('.fc_r-a1.fc_r-a1:where(html:not([data-fc-b]) *){color:red}');
  });

  it('reads condition values through the parser, so none can leave the selector', async () => {
    const { html } = await published(page([{ id: 'r', selector: '&', when: { state: 'c', eq: 'a"]{}' }, style: { color: 'red' } }], [choice('c', ['a', 'b'])]));
    expect(html).not.toContain('color:red');
  });
});

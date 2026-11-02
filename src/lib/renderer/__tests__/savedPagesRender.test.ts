// Every tree the repo can put on a site keeps rendering whole. The render gate
// refuses by default, so a page built from a registry entry, the demo seed, a legal
// template or the corpus must lose nothing to it.
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { COMPONENT_REGISTRY, FORM_COMPONENTS } from '@/lib/componentRegistry';
import { buildLegalTemplate } from '@/lib/legal/templates';
import { legalPageRoot } from '@/lib/legal/legalPageTree';
import { FORM_CONFIG_PROPS } from '@/lib/forms/definition';
import { contentBelow, type ForeignContent, isBlockedTag, isDroppedId, isDroppedProp, isRefusedTag, safeInlineStyle } from '@/lib/renderer/blockedNodes';
import { buildHomeSnapshot } from '@/lib/renderer/server/seedDemoSite';
import { EMPTY_BUSINESS } from '@/lib/site/siteSettings';
import { stripStickyCtaProps } from '@/lib/stickyCta/stickyCta';
import { FIXTURES } from '../../../../test/score/corpus/fixtures';

interface Tree {
  type?: unknown;
  props?: Record<string, unknown>;
  children?: unknown;
  appComponentTree?: unknown;
}

/** Read by a renderer and removed before an element exists, so the gate never decides them. */
const NOT_ATTRIBUTES = new Set([...FORM_CONFIG_PROPS, 'query', 'bindings', 'effects', 'rules']);

function losses(tree: Tree, where: string, out: string[] = [], foreign: ForeignContent = false): string[] {
  if (typeof tree.type === 'string' && (isRefusedTag(tree.type) || isBlockedTag(tree.type, foreign))) out.push(`${where}: <${tree.type}>`);
  const props = tree.props ?? {};
  const attributes = stripStickyCtaProps(props);
  for (const [name, value] of Object.entries(attributes)) {
    if (!NOT_ATTRIBUTES.has(name) && isDroppedProp(name, value)) out.push(`${where}: ${name} on <${String(tree.type)}>`);
  }
  if (isDroppedId(tree.type, props.id)) out.push(`${where}: the id ${String(props.id)} on <${String(tree.type)}>`);
  const { style } = props;
  if (style && typeof style === 'object') {
    const flat = Object.fromEntries(Object.entries(style).map(([key, value]) => [key, value && typeof value === 'object' ? Object.values(value)[0] : value]));
    if (safeInlineStyle(flat) !== flat) out.push(`${where}: a style on <${String(tree.type)}>`);
  }
  const name = typeof tree.type === 'string' ? tree.type : '';
  for (const child of Array.isArray(tree.children) ? tree.children : []) losses(child as Tree, where, out, contentBelow(name, foreign));
  return out;
}

describe('saved pages', () => {
  it('loses nothing from a registry entry', () => {
    const entries = { ...COMPONENT_REGISTRY, ...FORM_COMPONENTS };
    const found = Object.entries(entries).flatMap(([id, entry]) => losses({ type: entry.htmlType, props: entry.defaultProps as Record<string, unknown> }, id));
    expect(found).toEqual([]);
  });

  it('loses nothing from the demo seed', () => {
    const snapshot = buildHomeSnapshot({ pageId: 'p', slug: 'home', eventsCollectionId: 'c', eventsTitleColumnId: 't' });
    const tree = (snapshot as unknown as Tree).appComponentTree ?? snapshot;
    expect(losses(tree as Tree, 'demo')).toEqual([]);
  });

  it.each(['impressum', 'privacy', 'terms'] as const)('loses nothing from the legal template %s', (kind) => {
    const facts = { unsplash: true, forms: true, analytics: true, shop: true };
    const template = buildLegalTemplate({ kind, language: 'de', business: EMPTY_BUSINESS, siteName: 'x', facts } as never);
    expect(losses(legalPageRoot(template) as unknown as Tree, kind)).toEqual([]);
  });

  it.each(FIXTURES.map((fixture) => [fixture.id, fixture] as const))('loses nothing from the corpus fixture %s', (id, fixture) => {
    expect(losses(fixture.tree() as unknown as Tree, id)).toEqual([]);
  });
});

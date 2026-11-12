// The authoritative lists: every HTML element and global attribute, CSS property,
// selector, at-rule and media feature, read from the pinned data packages, with
// the exclusions in data/exclusions.json applied. Nothing here decides a cell.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { Entry, RowKind } from './types';
import exclusions from '../data/exclusions.json';
import samples from '../data/samples.json';
import apg from '../data/apg-patterns.json';
import componentCapabilities from '../data/component-capabilities.json';
import pageItems from '../data/page-items.json';
import fxScenes from '../data/fx-scenes.json';

const require = createRequire(path.join(process.cwd(), 'package.json'));

interface BcdFeature {
  __compat?: { status?: { deprecated?: boolean; standard_track?: boolean }; spec_url?: string | string[] };
  [key: string]: unknown;
}

interface BcdMarkup {
  elements: Record<string, BcdFeature>;
  global_attributes: Record<string, BcdFeature>;
}

const mdn = {
  properties: require('mdn-data/css/properties.json') as Record<string, { status: string }>,
  selectors: require('mdn-data/css/selectors.json') as Record<string, { status: string; syntax: string }>,
  atRules: require('mdn-data/css/at-rules.json') as Record<string, { status: string }>,
  types: require('mdn-data/css/types.json') as Record<string, { status: string }>,
  functions: require('mdn-data/css/functions.json') as Record<string, { status: string }>,
  units: require('mdn-data/css/units.json') as Record<string, { status: string }>,
};
const bcd = require('@mdn/browser-compat-data') as {
  html: BcdMarkup;
  svg: BcdMarkup;
  mathml: BcdMarkup;
  api: Record<string, Record<string, BcdFeature>>;
  css: { properties: Record<string, BcdFeature>; 'at-rules': Record<string, BcdFeature> };
};

export function dataVersions(): Record<string, string> {
  const version = (name: string) => {
    const file = path.join(process.cwd(), 'node_modules', name, 'package.json');
    return (JSON.parse(fs.readFileSync(file, 'utf8')) as { version: string }).version;
  };
  return {
    'mdn-data': version('mdn-data'),
    '@mdn/browser-compat-data': version('@mdn/browser-compat-data'),
    playwright: version('playwright'),
  };
}

const ruleReason = (id: string): string => {
  const rule = exclusions.rules.find((r) => r.id === id);
  if (!rule) throw new Error(`exclusions.json has no rule ${id}`);
  return rule.reason;
};

const itemReason = (kind: RowKind, id: string): string | undefined =>
  (exclusions.items as Record<string, Record<string, string> | undefined>)[kind]?.[id];

const isDeprecated = (feature: BcdFeature | undefined): boolean => feature?.__compat?.status?.deprecated === true;
const isNonstandard = (feature: BcdFeature | undefined): boolean => feature?.__compat?.status?.standard_track === false;

function mdnExclusion(status: string, deprecated: boolean): string | undefined {
  if (deprecated) return ruleReason('bcd-deprecated');
  if (status === 'obsolete') return ruleReason('mdn-obsolete');
  if (status === 'nonstandard') return ruleReason('mdn-nonstandard');
  return undefined;
}

const entry = (kind: RowKind, id: string, source: string, excluded?: string): Entry => ({
  kind,
  id,
  source,
  ...(excluded ? { excluded } : {}),
});

export function htmlElements(): Entry[] {
  const source = '@mdn/browser-compat-data html.elements';
  return Object.entries(bcd.html.elements).map(([id, feature]) =>
    entry('html-element', id, source, itemReason('html-element', id) ?? (isDeprecated(feature) ? ruleReason('bcd-deprecated') : undefined)),
  );
}

export function htmlGlobalAttributes(): Entry[] {
  const source = '@mdn/browser-compat-data html.global_attributes';
  const listed = Object.entries(bcd.html.global_attributes).map(([id, feature]) =>
    entry('html-global-attribute', id, source, itemReason('html-global-attribute', id) ?? (isDeprecated(feature) ? ruleReason('bcd-deprecated') : undefined)),
  );
  const extra = samples.extraAttributes.map((id) => entry('html-global-attribute', id, 'HTML and WAI-ARIA standards (samples.json)'));
  return [...listed, ...extra];
}

export function cssProperties(): Entry[] {
  const source = 'mdn-data css/properties.json';
  return Object.entries(mdn.properties)
    .map(([id, p]) =>
      entry('css-property', id, source, mdnExclusion(p.status, isDeprecated(bcd.css.properties[id]))),
    );
}

export function cssSelectors(): Entry[] {
  const source = 'mdn-data css/selectors.json';
  return Object.entries(mdn.selectors).map(([id, s]) =>
    entry('css-selector', id, source, itemReason('css-selector', id) ?? mdnExclusion(s.status, false)),
  );
}

export function cssAtRules(): Entry[] {
  const source = 'mdn-data css/at-rules.json';
  return Object.entries(mdn.atRules).map(([id, a]) =>
    entry('css-at-rule', id, source, itemReason('css-at-rule', id) ?? mdnExclusion(a.status, isDeprecated(bcd.css['at-rules'][id.slice(1)]))),
  );
}

export function cssMediaFeatures(): Entry[] {
  const source = '@mdn/browser-compat-data css.at-rules.media';
  const media = bcd.css['at-rules'].media as Record<string, BcdFeature>;
  const known = samples.mediaFeatures as Record<string, string>;
  const ids = Object.keys(media).filter((id) => {
    if (id === '__compat' || id.startsWith('-')) return false; // vendor-only names
    // Syntax notes in the data, not media features.
    return !['calc', 'media_features', 'media_query_values', 'nested-queries', 'or_syntax', 'range_syntax'].includes(id);
  });
  return ids.map((id) => {
    if (!(id in known) && !isDeprecated(media[id])) throw new Error(`samples.json has no sample for media feature ${id}`);
    return entry('css-media-feature', id, source, isDeprecated(media[id]) ? ruleReason('bcd-deprecated') : undefined);
  });
}

/**
 * Keys under an element in the compatibility data: an attribute, or a note about
 * the element. Attribute names never hold an underscore, and `input.type_color`
 * is the one note that is really an attribute value, so it stays a row.
 */
const isAttributeKey = (key: string): boolean => !key.includes('_') || /^type_/.test(key);

function attributeExclusion(kind: RowKind, id: string, key: string, feature: BcdFeature, element?: Entry): string | undefined {
  const named = itemReason(kind, id);
  if (named) return named;
  if (element?.excluded) return ruleReason('element-excluded');
  if (!isAttributeKey(key)) return ruleReason('bcd-not-an-attribute');
  if (isDeprecated(feature)) return ruleReason('bcd-deprecated');
  if (isNonstandard(feature)) return ruleReason('bcd-nonstandard');
  return undefined;
}

/** Every attribute of single elements: `a.href`. */
function elementAttributes(kind: RowKind, markup: BcdMarkup, elements: Entry[], source: string): Entry[] {
  const byId = new Map(elements.map((e) => [e.id, e]));
  return Object.entries(markup.elements).flatMap(([tag, feature]) =>
    Object.entries(feature)
      .filter(([key]) => key !== '__compat')
      .map(([key, attribute]) => {
        const id = `${tag}.${key}`;
        return entry(kind, id, source, attributeExclusion(kind, id, key, attribute as BcdFeature, byId.get(tag)));
      }),
  );
}

/** Attributes any element of a namespace takes: `*.fill`. */
function globalAttributes(kind: RowKind, markup: BcdMarkup, source: string): Entry[] {
  return Object.entries(markup.global_attributes).map(([key, feature]) => {
    const id = `*.${key}`;
    const excluded = isDeprecated(feature) ? ruleReason('bcd-deprecated') : isNonstandard(feature) ? ruleReason('bcd-nonstandard') : undefined;
    return entry(kind, id, source, itemReason(kind, id) ?? excluded);
  });
}

export function htmlElementAttributes(): Entry[] {
  return elementAttributes('html-element-attribute', bcd.html, htmlElements(), '@mdn/browser-compat-data html.elements.*');
}

export function svgElements(): Entry[] {
  const source = '@mdn/browser-compat-data svg.elements';
  return Object.entries(bcd.svg.elements).map(([id, feature]) =>
    entry('svg-element', id, source, itemReason('svg-element', id) ?? (isDeprecated(feature) ? ruleReason('bcd-deprecated') : undefined)),
  );
}

export function svgAttributes(): Entry[] {
  return [
    ...elementAttributes('svg-attribute', bcd.svg, svgElements(), '@mdn/browser-compat-data svg.elements.*'),
    ...globalAttributes('svg-attribute', bcd.svg, '@mdn/browser-compat-data svg.global_attributes'),
  ];
}

export function mathmlElements(): Entry[] {
  const source = '@mdn/browser-compat-data mathml.elements';
  return Object.entries(bcd.mathml.elements).map(([id, feature]) =>
    entry('mathml-element', id, source, isDeprecated(feature) ? ruleReason('bcd-deprecated') : undefined),
  );
}

export function mathmlAttributes(): Entry[] {
  return [
    ...elementAttributes('mathml-attribute', bcd.mathml, mathmlElements(), '@mdn/browser-compat-data mathml.elements.*'),
    ...globalAttributes('mathml-attribute', bcd.mathml, '@mdn/browser-compat-data mathml.global_attributes'),
  ];
}

/**
 * Event handler content attributes: the events of element interfaces whose handler
 * the specification links, plus the listed ones it does not (samples.json). The
 * browser probe compares the result with what Chromium reflects.
 */
export function htmlEventHandlers(): Entry[] {
  const source = '@mdn/browser-compat-data api.*Element.*_event';
  const unlinked = new Set(samples.eventHandlersWithoutSpecLink);
  const seen = new Map<string, Entry>();
  for (const [name, members] of Object.entries(bcd.api)) {
    if (name !== 'Element' && !name.endsWith('Element')) continue;
    for (const [member, feature] of Object.entries(members)) {
      if (!member.endsWith('_event')) continue;
      const id = `on${member.slice(0, -'_event'.length)}`;
      const links = [feature.__compat?.spec_url ?? []].flat().some((url) => url.includes('handler-'));
      if (!links && !unlinked.has(id)) continue;
      const excluded = isDeprecated(feature) ? ruleReason('bcd-deprecated') : isNonstandard(feature) ? ruleReason('bcd-nonstandard') : undefined;
      // An event on several interfaces is one attribute: it counts if any of them is live.
      if (!seen.has(id) || !excluded) seen.set(id, entry('html-event-handler', id, source, excluded));
    }
  }
  return [...seen.values()];
}

/** One row per value type, function and unit of mdn-data, the grammar `initial` never reaches. */
export function cssValues(): Entry[] {
  const known = samples.cssValues as Record<string, CssValueSample>;
  const list = (ids: string[], source: string, status: (id: string) => string) =>
    ids.map((id) => {
      // mdn-data calls rgba() and hsla() nonstandard, but they are aliases the
      // standard keeps, not vendor names: only obsolete leaves the list.
      const excluded = itemReason('css-value', id) ?? (status(id) === 'obsolete' ? ruleReason('mdn-obsolete') : undefined);
      if (!excluded && !(id in known)) throw new Error(`samples.json has no sample for CSS value ${id}`);
      return entry('css-value', id, source, excluded);
    });
  return [
    ...list(Object.keys(mdn.types).map((id) => `<${id}>`), 'mdn-data css/types.json', (id) => mdn.types[id.slice(1, -1)].status),
    ...list(Object.keys(mdn.functions), 'mdn-data css/functions.json', (id) => mdn.functions[id].status),
    ...list(Object.keys(mdn.units), 'mdn-data css/units.json', (id) => mdn.units[id].status),
  ];
}

/** The WAI-ARIA Authoring Practices patterns, hand-listed: no data package carries them. */
export function ariaPatterns(): Entry[] {
  return apg.patterns.map((p) => entry('aria-pattern', p.id, apg.source));
}

export function allEntries(): Entry[] {
  return [
    ...htmlElements(),
    ...htmlGlobalAttributes(),
    ...htmlElementAttributes(),
    ...htmlEventHandlers(),
    ...svgElements(),
    ...svgAttributes(),
    ...mathmlElements(),
    ...mathmlAttributes(),
    ...cssProperties(),
    ...cssValues(),
    ...cssSelectors(),
    ...cssAtRules(),
    ...cssMediaFeatures(),
    ...ariaPatterns(),
  ];
}

/**
 * What the reusable component format promises, hand-listed: no web standard names
 * it. Not part of allEntries, because the probes over that list ask what a node
 * can hold, and a row here asks whether the format keeps a promise: its cells come
 * from report.ts, and only an entry with a measured result passes.
 */
export function componentEntries(): Entry[] {
  const { source, inputTypes, capabilities } = componentCapabilities;
  return [...inputTypes, ...capabilities].map((id) => entry('component', id, source));
}

/**
 * What applies to a whole site or page, hand-listed from the theme and head contract:
 * a site's theme today, as `theme:<what>`. Not part of allEntries for the same reason as
 * the component rows: a node cannot hold one, so the node probes have nothing to ask.
 * Cells come from pageItems.score.ts, and a cell nothing measured fails.
 */
export function pageItemEntries(): Entry[] {
  return pageItems.theme.map((id) => entry('page-item', `theme:${id}`, pageItems.source));
}

/**
 * The reference scenes an FX scene box must keep, as `scene:<name>`: the lumitra.co hub
 * hero and two of the engine's presets. Not part of allEntries, as the component rows are
 * not: the node probes have nothing to ask of a scene. Cells come from fx.score.ts, and a
 * cell nothing measured fails.
 */
export function fxSceneEntries(): Entry[] {
  return fxScenes.scenes.map((id) => entry('fx-scene', `scene:${id}`, fxScenes.source));
}

/** Every row of the matrix. */
export function scoredEntries(): Entry[] {
  return [...allEntries(), ...componentEntries(), ...pageItemEntries(), ...fxSceneEntries()];
}

/** The sample selector text for a mdn-data selector row. */
export function selectorSample(id: string): string {
  return (samples.selectors as Record<string, string>)[id] ?? id;
}

export function atRuleSample(id: string): string {
  const sample = (samples.atRules as Record<string, string>)[id];
  if (!sample) throw new Error(`samples.json has no sample for at-rule ${id}`);
  return sample;
}

export function mediaFeatureSample(id: string): string {
  return (samples.mediaFeatures as Record<string, string>)[id];
}

export interface AttributeSample {
  prop: string;
  value: unknown;
  html: string;
}

export function attributeSample(id: string): AttributeSample {
  const sample = (samples.attributes as Record<string, AttributeSample>)[id];
  if (!sample) throw new Error(`samples.json has no sample for attribute ${id}`);
  return sample;
}

export interface CssValueSample {
  /** A style key, as a node stores it. */
  property: string;
  value: string;
}

export function cssValueSample(id: string): CssValueSample {
  return (samples.cssValues as Record<string, CssValueSample>)[id];
}

export type Namespace = 'html' | 'svg' | 'mathml';

export const namespaceOf = (kind: RowKind): Namespace =>
  kind.startsWith('svg') ? 'svg' : kind.startsWith('mathml') ? 'mathml' : 'html';

const NAMESPACE_ROOT: Record<Namespace, string | undefined> = { html: undefined, svg: 'svg', mathml: 'math' };
const GLOBAL_HOST: Record<Namespace, string> = { html: 'div', svg: 'rect', mathml: 'mi' };

export interface NodeShape {
  id: string;
  type: string;
  props: Record<string, unknown>;
  children?: NodeShape[];
}

/**
 * A node with the tag in the place it has meaning: an SVG or MathML child inside
 * its root, because alone it would be an unknown HTML element. `probe` is its id.
 */
export function placed(namespace: Namespace, tag: string, props: Record<string, unknown> = {}): NodeShape {
  const node: NodeShape = { id: 'probe', type: tag, props };
  const root = NAMESPACE_ROOT[namespace];
  return !root || tag === root ? node : { id: 'probe-root', type: root, props: {}, children: [node] };
}

export interface MarkupAttributeSample extends AttributeSample {
  tag: string;
}

/** `a.href`, `input.type_color` or `*.fill` as something a node can hold and the markup must show. */
export function markupAttributeSample(namespace: Namespace, id: string): MarkupAttributeSample {
  const dot = id.indexOf('.');
  const owner = id.slice(0, dot);
  const name = id.slice(dot + 1);
  const tag = owner === '*' ? GLOBAL_HOST[namespace] : owner;
  if (name.startsWith('type_')) {
    const value = name.slice('type_'.length);
    return { tag, prop: 'type', value, html: `type="${value}"` };
  }
  const shared = (samples.attributes as Record<string, AttributeSample>)[name];
  if (owner === '*' && shared) return { tag, ...shared };
  const { reactProps, booleans, values } = samples.elementAttributes as {
    reactProps: Record<string, string>;
    booleans: string[];
    values: Record<string, string | number>;
  };
  const prop = reactProps[name] ?? name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
  if (namespace === 'html' && booleans.includes(name)) return { tag, prop, value: true, html: name };
  const value = values[name] ?? 'probe';
  return { tag, prop, value, html: `${name}="${value}"` };
}

/** The element's opening tag in rendered markup, attributes included. */
export function openingTag(html: string, tag: string): string | undefined {
  return html.match(new RegExp(`<${tag}(?=[\\s>/])[^>]*>`))?.[0];
}

/** Markup with the entities React writes into attributes decoded, so a value compares as authored. */
export const decodeEntities = (html: string): string =>
  html
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/** A CSS property as a style key: `font-size` to `fontSize`, `-webkit-box-flex` to `WebkitBoxFlex`. */
export function styleKeyOf(property: string): string {
  if (property === '--*') return '--probe';
  if (property.startsWith('--')) return property;
  return property
    .replace(/^-ms-/, 'ms-')
    .replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

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

const require = createRequire(path.join(process.cwd(), 'package.json'));

interface BcdFeature {
  __compat?: { status?: { deprecated?: boolean } };
  [key: string]: unknown;
}

const mdn = {
  properties: require('mdn-data/css/properties.json') as Record<string, { status: string }>,
  selectors: require('mdn-data/css/selectors.json') as Record<string, { status: string; syntax: string }>,
  atRules: require('mdn-data/css/at-rules.json') as Record<string, { status: string }>,
};
const bcd = require('@mdn/browser-compat-data') as {
  html: { elements: Record<string, BcdFeature>; global_attributes: Record<string, BcdFeature> };
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
    entry('html-global-attribute', id, source, isDeprecated(feature) ? ruleReason('bcd-deprecated') : undefined),
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

/** The WAI-ARIA Authoring Practices patterns, hand-listed: no data package carries them. */
export function ariaPatterns(): Entry[] {
  return apg.patterns.map((p) => entry('aria-pattern', p.id, apg.source));
}

export function allEntries(): Entry[] {
  return [
    ...htmlElements(),
    ...htmlGlobalAttributes(),
    ...cssProperties(),
    ...cssSelectors(),
    ...cssAtRules(),
    ...cssMediaFeatures(),
    ...ariaPatterns(),
  ];
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

/** A CSS property as a style key: `font-size` to `fontSize`, `-webkit-box-flex` to `WebkitBoxFlex`. */
export function styleKeyOf(property: string): string {
  if (property === '--*') return '--probe';
  if (property.startsWith('--')) return property;
  return property
    .replace(/^-ms-/, 'ms-')
    .replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

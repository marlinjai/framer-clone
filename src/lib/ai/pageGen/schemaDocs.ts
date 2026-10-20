// src/lib/ai/pageGen/schemaDocs.ts
//
// Model-facing reference for the page generator's output format, generated
// from ./schema.ts (which is itself derived from the component registry, the
// properties panel's tag sets and CSS_PROP_SET). Deterministic: the same code
// produces byte-identical text, so it sits in the prompt-cached system prefix.
//
// The breakpoints are NOT in here (they vary per page and sit after the cache
// breakpoint); see ./prompt.ts.

import { stableStringify } from '@/lib/ai/serializers/normalize';
import {
  BASE_KEY,
  FORBIDDEN_TAGS,
  GENERATION_LIMITS,
  allowedPropKeysFor,
  listGenerationPresets,
  listGenerationStyleKeys,
  listGenerationTags,
} from './schema';
import { isVoidTag } from '@/lib/drag/voidTags';

export function buildSchemaDocs(): string {
  const presets = listGenerationPresets();
  const tags = listGenerationTags();
  const styleKeys = listGenerationStyleKeys();

  const tagLines = tags.map((tag) => {
    const props = allowedPropKeysFor(tag);
    const extra = props.filter((p) => p !== 'children');
    const parts = [
      isVoidTag(tag) ? 'void (no children, no text)' : 'may have children or text',
    ];
    if (extra.length > 0) parts.push(`props: ${extra.join(', ')}`);
    return `- ${tag}: ${parts.join('; ')}`;
  });

  const presetBlocks = presets.map((p) => {
    const header = [
      `### preset "${p.id}" (${p.label}, category ${p.category})`,
      `- type: ${p.htmlType}${p.acceptsChildren ? '' : ' (void: no children)'}`,
    ];
    if (p.dataComponentKind) {
      header.push(
        `- data component "${p.dataComponentKind}": renders a placeholder until the user binds it in the properties panel` +
          (p.bindableSlots.length > 0 ? ` (bindable: ${p.bindableSlots.join(', ')})` : '') +
          '. Use it only when the brief clearly asks for this kind of content; never add children to it.',
      );
    }
    header.push(`- defaults: ${stableStringify(p.defaultProps)}`);
    return header.join('\n');
  });

  return [
    '# Output format: framer-clone component snapshots',
    '',
    'You produce nodes for the framer-clone visual editor. Each node becomes one editable',
    'component (a MobX-State-Tree ComponentSnapshotIn). Shape of one node:',
    '',
    '{',
    '  "type": "<html tag from the tag list>",',
    '  "preset": "<optional preset id from the preset list>",',
    '  "label": "<short name shown in the layers panel, e.g. Hero, Pricing card>",',
    '  "props": {',
    '    "children": "<text content, only on non-void tags without child nodes>",',
    '    "src": "<img only>", "alt": "<img only>", "imageQuery": "<img only: English stock-photo search>",',
    '    "href": "<a only>", "target": "<a only: _blank or _self>",',
    '    "style": { "<camelCase CSS property>": <value or responsive map> }',
    '  },',
    '  "children": [ <nodes> ]',
    '}',
    '',
    'Rules:',
    '- Never send "id", "componentType", "canvasNodeType" or "parentId": the editor assigns them.',
    '- "type" is always the HTML tag. A preset is a starting point: its defaults are merged under your',
    '  props (your style keys win), and "type" must equal the preset\'s type. A "card" is',
    '  {"type":"div","preset":"card"}, not {"type":"card"}.',
    '- A node has either text ("props.children" as a string) or child nodes, never both.',
    `- Void tags (${tags.filter((t) => isVoidTag(t)).join(', ') || 'none'}) have neither text nor children.`,
    '- Style values are strings ("16px", "#111827", "1fr 1fr") or numbers (unitless, e.g. fontWeight 600, opacity 0.8).',
    '- Only the style keys listed below are kept; anything else is dropped. No class names, no CSS text,',
    '  no event handlers, no HTML strings.',
    '- Links: href must start with https://, http://, mailto:, tel:, # or a single /. Images: src must be https://,',
    '  http:// or a site path starting with /. Always give images a meaningful alt in the page\'s language.',
    `- Stock photos: an img without src gets "imageQuery", 2 to 6 English words describing the photo`,
    `  (at most ${GENERATION_LIMITS.maxImageQueryChars} characters, plain words only). The server resolves at most`,
    `  ${GENERATION_LIMITS.maxStockImages} images per generation to photos; the rest keep a placeholder.`,
    '- An existing image in the selected component whose src is on images.unsplash.com: either copy its src,',
    '  title and data-credit-name, data-credit-url, data-credit-source-url props unchanged, or give a new imageQuery.',
    '  An Unsplash src without its credit props is dropped.',
    `- Never use these tags: ${[...FORBIDDEN_TAGS].sort().join(', ')}.`,
    `- Budget: at most ${GENERATION_LIMITS.maxNodes} nodes in total, nesting at most ${GENERATION_LIMITS.maxDepth} levels,`,
    `  text at most ${GENERATION_LIMITS.maxTextChars} characters per node. Prefer fewer, well-structured nodes.`,
    '',
    '## Responsive styles',
    '',
    'Any style value may instead be a responsive map keyed by breakpoint key (the keys are listed in the',
    `request context) plus the "${BASE_KEY}" key: {"${BASE_KEY}": "64px", "mobile": "24px"}. "${BASE_KEY}" is the value for`,
    `every breakpoint without its own key; always include "${BASE_KEY}" in a responsive map. Give every`,
    'layout-relevant property (padding, fontSize, gridTemplateColumns, flexDirection) a mobile value when the',
    'desktop value would not fit a phone.',
    '',
    '## Tags',
    '',
    ...tagLines,
    '',
    '## Presets (from the editor\'s component registry)',
    '',
    ...presetBlocks,
    '',
    '## Style keys',
    '',
    styleKeys.join(', '),
  ].join('\n');
}

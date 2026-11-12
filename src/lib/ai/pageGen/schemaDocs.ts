// src/lib/ai/pageGen/schemaDocs.ts
//
// Model-facing reference for the page generator's output format, generated
// from the taught lists of ./schema.ts (derived from the component registry, the
// properties panel's tag sets and CSS_PROP_SET); the validator accepts more than
// this on purpose. Deterministic: the same code
// produces byte-identical text, so it sits in the prompt-cached system prefix.
//
// The breakpoints are NOT in here (they vary per page and sit after the cache
// breakpoint); see ./prompt.ts.

import { isShopControlKind } from '@/lib/commerce/parts';
import { stableStringify } from '@/lib/ai/serializers/normalize';
import {
  BASE_KEY,
  GENERATION_LIMITS,
  PHOTO_BACKGROUND_TAGS,
  PROMPT_AVOID_TAGS,
  allowedPropKeysFor,
  listGenerationPresets,
  listGenerationStyleKeys,
  listGenerationTags,
} from './schema';
import { isVoidTag } from '@/lib/drag/voidTags';
import { effectsDocs } from './promptSections/effects';
import { rulesDocs } from './promptSections/rules';
import { behaviourDocs } from './promptSections/behaviour';
import { formPropKeysFor } from '@/lib/forms/generation';
import { STICKY_CTA_PROP_KEYS, isStickyCta } from '@/lib/stickyCta/stickyCta';
import { FONT_CATEGORIES, FONT_LIBRARY, fontStack } from '@/lib/fonts/registry';
import { fxGenerationDocs } from '@/lib/fxScene/generation';
import { FX_PROP, isFxScene } from '@/lib/fxScene/marker';
import type { ThemeMode } from '@/lib/site/theme';

/**
 * The schema docs. `mode` is the site's theme mode: a site that fixes it (`light` or `dark`)
 * is not taught the dark look, see rulesDocs. Left out, it is the docs of a site with no choice.
 */
export function buildSchemaDocs(mode?: ThemeMode): string {
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
    if (p.dataComponentKind && isShopControlKind(p.dataComponentKind)) {
      // Its button, steps and messages arrive as part nodes when it lands on the page
      // (src/lib/commerce/parts.ts): the generator writes the control alone.
      const parts = `- shop control "${p.dataComponentKind}": the page adds its parts (buttons, fields, messages) as child nodes in the site language, which the user then styles. `;
      header.push(
        p.dataComponentKind === 'variant-selector'
          ? parts +
              'Use it only when the brief clearly asks for it. Put the add to cart and any price bound to the variant ({{variant.price.*}}) INSIDE it, as its children: ' +
              'they follow the visitor\'s choice only there. Never write its parts.'
          : p.dataComponentKind === 'add-to-cart'
            ? parts +
              'Use it only when the brief clearly asks for it; never add children to it. On a product page with options, put it INSIDE the variant selector: ' +
              'it adds the chosen variant only there (one written beside the selector is moved into it).'
            : parts + 'Use it only when the brief clearly asks for it; never add children to it.',
      );
    } else if (p.dataComponentKind) {
      header.push(
        `- data component "${p.dataComponentKind}": renders a placeholder until the user binds it in the properties panel` +
          (p.bindableSlots.length > 0 ? ` (bindable: ${p.bindableSlots.join(', ')})` : '') +
          '. Use it only when the brief clearly asks for this kind of content; never add children to it.',
      );
    }
    const formKeys = formPropKeysFor(p.defaultProps as Record<string, unknown>);
    if (formKeys.length > 0) header.push(`- form component (see "Forms"): props ${formKeys.join(', ')}`);
    if (isStickyCta(p.defaultProps)) {
      header.push(`- sticky call to action (see "Sticky call to action"): props ${STICKY_CTA_PROP_KEYS.join(', ')}; new pages only, no children`);
    }
    if (isFxScene(p.defaultProps, p.htmlType)) {
      // The stored scene is long and is not what the model writes: it names a preset (see "FX scene").
      const { [FX_PROP]: _scene, ...shown } = p.defaultProps as Record<string, unknown>;
      void _scene;
      header.push('- FX scene (see "FX scene"): props.fx names a preset and what it changes; at most one per page');
      header.push(`- defaults: ${stableStringify(shown)}`);
      return header.join('\n');
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
    '    "src": "<img only>", "alt": "<img only>", "decorative": <img only: true for a purely decorative image>,',
    '    "imageQuery": "<img or container: English stock-photo search>",',
    '    "href": "<a only>", "target": "<a only: _blank or _self>",',
    '    "style": { "<camelCase CSS property>": <value or responsive map> },',
    '    "effects": { "appear": { ... } }  (optional, see Motion),',
    '    "rules": [ { ... } ]  (optional, see States and decoration),',
    '    "behaviour": { ... }  (optional, see Behaviour)',
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
    '- To mix text with elements in one node (a bold word or a link inside a sentence), give it child nodes and',
    '  write each stretch of text as {"type":"#text","props":{"children":"Hello "}}, spaces included. A "#text" node',
    '  renders as bare text: it has no style, no label, no children and never stands at the top level.',
    `- Void tags (${tags.filter((t) => isVoidTag(t)).join(', ') || 'none'}) have neither text nor children.`,
    '- Style values are strings ("16px", "#111827", "1fr 1fr") or numbers (unitless, e.g. fontWeight 600, opacity 0.8).',
    '- Use the tags, props and style keys listed here: the editor has controls for them. Any other standard HTML',
    '  tag, attribute or CSS property is kept when a design truly needs it (a list needs ul and li, a table its',
    '  table tags, a shape clipPath). No class names, no CSS text, no event handlers, no HTML strings, no code.',
    '- Links: href must start with https://, http://, mailto:, tel:, # or a single /. Images: src must be https://,',
    '  http:// or a site path starting with /. Always give images a meaningful alt in the page\'s language that',
    '  says what the image shows (never "image", "photo", a file name or the layer name). Only a purely',
    '  decorative image (a texture, a divider) gets "alt": "" with "decorative": true.',
    `- Stock photos: an img without src gets "imageQuery", 2 to 6 English words describing the photo`,
    `  (at most ${GENERATION_LIMITS.maxImageQueryChars} characters, plain words only). The server resolves at most`,
    `  ${GENERATION_LIMITS.maxStockImages} images per generation to photos; the rest keep a placeholder.`,
    `- Photo backgrounds: an imageQuery on a container (${[...PHOTO_BACKGROUND_TAGS].sort().join(', ')}) puts the photo`,
    '  under the container\'s content as the bottom layer of its backgroundImage. Write any scrim gradient into',
    '  style.backgroundImage yourself (no url()); the server appends the photo and sets backgroundSize,',
    '  backgroundRepeat and backgroundPosition. Without a photo the scrim and backgroundColor remain.',
    '- Crops: the server sets objectPosition (img) or backgroundPosition (photo background) to the photo\'s subject.',
    '  An img with aspectRatio and no height of its own gets height "auto", so the ratio shapes the box.',
    '- An existing image in the selected component whose src is on images.unsplash.com: either copy its src,',
    '  title and data-credit-name, data-credit-url, data-credit-source-url props unchanged, or give a new imageQuery.',
    '  The same for a container whose backgroundImage has an images.unsplash.com url(): copy backgroundImage and',
    '  its three data-credit-* props unchanged, or drop the url() layer and give a new imageQuery.',
    '  An Unsplash photo without its credit props is dropped.',
    `- Never use these tags: ${[...PROMPT_AVOID_TAGS].sort().join(', ')}.`,
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
    effectsDocs(),
    '',
    rulesDocs(mode),
    '',
    behaviourDocs(),
    '',
    fxGenerationDocs(),
    '',
    '## Fonts',
    '',
    'The self-hosted font library (no other web font is available). Write fontFamily exactly as quoted, the',
    'family name followed by its fallback stack. A fontFamily naming any other family is replaced by the',
    'library default of its kind; a plain system stack (system-ui, Georgia, ...) is kept but looks generic.',
    ...fontLines(),
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

/** One line per library family, grouped by category (src/lib/fonts/registry.ts). */
function fontLines(): string[] {
  const lines: string[] = [];
  for (const cat of FONT_CATEGORIES) {
    for (const f of FONT_LIBRARY.filter((x) => x.category === cat.id)) {
      const [min, max] = f.weight;
      const weights = min === max ? `weight ${min} only` : `weights ${min} to ${max}`;
      const italic = f.faces.some((face) => face.style === 'italic') ? ', italic' : '';
      lines.push(`- ${cat.label}: "${fontStack(f)}" (${weights}${italic}): ${f.character}`);
    }
  }
  return lines;
}

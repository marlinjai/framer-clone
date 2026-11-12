// What Framer's plugin API can store natively, for every row of the coverage matrix, read from the
// typings of framer-plugin (see typings.ts). Deterministic: a table per kind keyed by exact row id,
// and a stated default per kind that is never `native`. This is not a render test of Framer's
// published pages; that is a later step that rebuilds the corpus fixtures in Framer.

import type { RowKind } from '../types';
import { ROW_KINDS } from '../types';
import { FRAMER_DOCS, FRAMER_EDITOR_TEST } from './typings';

export const FRAMER_VERDICTS = ['native', 'partial', 'code-only', 'unknown'] as const;
export type FramerVerdictName = (typeof FRAMER_VERDICTS)[number];

export interface FramerVerdict {
  verdict: FramerVerdictName;
  /** One line: why this verdict. */
  reason: string;
  /** Typings symbols the verdict rests on, `Name` or `Name.member`, all declared in index.d.ts. */
  symbols: string[];
  /** What a `partial` cannot express. */
  restriction?: string;
  /** A Framer documentation page fetched on 2026-11-02, for a row that draws on a documented feature. */
  docUrl?: string;
  /** Where a documented feature has no public page, the recorded source. */
  source?: string;
  /** The row rests on Framer's documentation of an editor feature, not on the typings or a measurement. */
  documentedNotMeasured?: boolean;
}

const NO_SYMBOL = 'no node kind, trait or enumeration in framer-plugin 3.10.3 expresses it';

const native = (reason: string, ...symbols: string[]): FramerVerdict => ({ verdict: 'native', reason, symbols });
const partial = (restriction: string, reason: string, ...symbols: string[]): FramerVerdict => ({
  verdict: 'partial',
  restriction,
  reason,
  symbols,
});
const unknown = (reason: string, ...symbols: string[]): FramerVerdict => ({ verdict: 'unknown', reason, symbols });
const codeOnly = (reason = NO_SYMBOL, ...symbols: string[]): FramerVerdict => ({ verdict: 'code-only', reason, symbols });
const documented = (base: FramerVerdict, docUrl: string | undefined, source?: string): FramerVerdict => ({
  ...base,
  documentedNotMeasured: true,
  ...(docUrl ? { docUrl } : {}),
  ...(source ? { source } : {}),
});

/** Gives every key of a table the same verdict. */
function all(ids: readonly string[], verdict: FramerVerdict): Record<string, FramerVerdict> {
  return Object.fromEntries(ids.map((id) => [id, verdict]));
}

// HTML

const INLINE_TEXT = unknown(
  'TextNode.setText is "Plain text content, not HTML"; FormattedTextField accepts contentType html, but the typings do not say which tags survive',
  'TextNode.setText',
  'ContentType',
  'FormattedTextField',
);
const FORMS = documented(
  unknown('Framer documents input variants and form validation built as a component; no form or input node kind or attribute is typed', 'KnownNodeClass'),
  FRAMER_DOCS.forms,
);
const TEXT_TAG = native('a text node tag', 'TextNodeTag', 'AddTextOptions.tag');

const HTML_ELEMENT: Record<string, FramerVerdict> = {
  div: native('a frame is a box', 'FrameNode', 'createableNodes'),
  p: TEXT_TAG,
  h1: TEXT_TAG,
  h2: TEXT_TAG,
  h3: TEXT_TAG,
  h4: TEXT_TAG,
  h5: TEXT_TAG,
  h6: TEXT_TAG,
  a: native('frames and text nodes carry a link and a new tab flag', 'WithLinkTrait.link', 'LinkToUrl', 'LinkToWebPage'),
  img: partial(
    'an image is a frame fill (backgroundImage) with alt text and a resolution, not an element with its own attributes',
    'ImageAsset carries url, altText and resolution',
    'WithBackgroundImageTrait.backgroundImage',
    'ImageAsset.altText',
  ),
  ...all(
    ['strong', 'em', 'b', 'i', 'u', 's', 'span', 'br', 'ul', 'ol', 'li', 'blockquote', 'code', 'pre', 'hr', 'sub', 'sup', 'mark', 'small', 'del', 'ins'],
    INLINE_TEXT,
  ),
  input: FORMS,
  form: FORMS,
  ...all(['iframe', 'embed', 'object'], codeOnly("embedded content only through Framer's Embed or a code component (createCodeFile)", 'FramerPluginAPI.createCodeFile')),
  ...all(
    ['section', 'header', 'footer', 'nav', 'main', 'article', 'aside'],
    codeOnly('no tag field on FrameNode; TextNodeTag covers only h1 to h6 and p', 'FrameNode', 'TextNodeTag'),
  ),
};

const HTML_GLOBAL_ATTRIBUTE: Record<string, FramerVerdict> = {
  hidden: partial('a visible flag on the layer, not the hidden attribute (no until-found)', 'every drawable node has visible', 'WithVisibleTrait.visible'),
  id: unknown('links can target a scroll section, but no id attribute is typed on a node', 'LinkToWebPage.scrollSection'),
  lang: unknown('locales exist at site level; no lang attribute on a node', 'Locale', 'FramerPluginAPI.getLocales'),
  style: codeOnly('no inline style attribute; only the typed traits'),
  class: codeOnly('no class attribute; only the typed traits'),
};

const LINK_TAB = partial('new tab or same tab only, no named targets', 'linkOpenInNewTab is a boolean', 'WithLinkTrait.linkOpenInNewTab');

const HTML_ELEMENT_ATTRIBUTE: Record<string, FramerVerdict> = {
  'a.href': native('a link is a URL or a web page with an optional scroll section', 'WithLinkTrait.link', 'LinkToUrl', 'LinkToWebPage'),
  'a.target': LINK_TAB,
  'a.rel': unknown('Rel (nofollow, noreferrer, me, ugc, sponsored) is typed only as a component property control, not on WithLinkTrait', 'LinkRelControl', 'Rel'),
  'img.alt': partial('the alt text of a frame fill', 'ImageAsset has altText', 'ImageAsset.altText'),
  'img.src': partial('an uploaded image asset only, not an arbitrary URL', 'images are uploaded and referenced as ImageAsset', 'ImageAsset.url', 'FramerPluginAPI.uploadImage'),
  'img.srcset': unknown('Framer picks a resolution per asset; whether it emits srcset is not typed', 'Resolution'),
  'img.sizes': unknown('Framer picks a resolution per asset; whether it emits sizes is not typed', 'Resolution'),
};

/** Documented Framer triggers. Click start has no public page and rests on the editor test. */
const TRIGGER_RESTRICTION = 'fires a variant change, navigation or overlay; no arbitrary code';
const HTML_EVENT_HANDLER: Record<string, FramerVerdict> = {
  onclick: documented(partial(TRIGGER_RESTRICTION, 'the Click trigger connects variants', 'WithComponentVariantTrait.isVariant'), FRAMER_DOCS.animations),
  onmouseenter: documented(partial(TRIGGER_RESTRICTION, 'the Mouse enter trigger connects variants', 'WithComponentVariantTrait.isVariant'), FRAMER_DOCS.animations),
  onmouseleave: documented(partial(TRIGGER_RESTRICTION, 'the Mouse leave trigger connects variants', 'WithComponentVariantTrait.isVariant'), FRAMER_DOCS.animations),
  onmousedown: documented(
    partial(TRIGGER_RESTRICTION, 'the Click start trigger, seen in the editor; no public page found', 'WithComponentVariantTrait.isVariant'),
    undefined,
    FRAMER_EDITOR_TEST,
  ),
  onpointerdown: documented(
    partial(TRIGGER_RESTRICTION, 'the Click start trigger, seen in the editor; no public page found', 'WithComponentVariantTrait.isVariant'),
    undefined,
    FRAMER_EDITOR_TEST,
  ),
};

// SVG and MathML

/** SVG elements whose survival inside the svg string the typings do not settle (links, animation, foreign content). */
export const SVG_UNSETTLED = ['a', 'animate', 'animateMotion', 'animateTransform', 'set', 'mpath', 'foreignObject'] as const;
const SVG_IN_STRING = partial(
  "inside SVGNode's svg string: one opaque string per node, not editable per element, no selectors or interactions inside",
  'an SVG node stores its markup as a string',
  'WithSVGTrait.svg',
);
const SVG_UNSETTLED_VERDICT = unknown('svg is typed as a plain string; the typings do not say whether links, animation or foreign content survive in it', 'WithSVGTrait.svg');

const SVG_ELEMENT: Record<string, FramerVerdict> = {
  svg: native('an SVG node holds an SVG', 'SVGNode', 'WithSVGTrait.svg', 'FramerPluginAPI.addSVG'),
  ...all(SVG_UNSETTLED, SVG_UNSETTLED_VERDICT),
};

// CSS properties

const PX_SIDES = 'px only';
const SVG_PRESENTATION = partial(
  "as an attribute inside SVGNode's svg string, not as CSS on a layer",
  'SVG presentation properties live in the SVG markup',
  'WithSVGTrait.svg',
);
const TRANSITION_CONTROL = unknown('Transition (type, ease, duration, delay) is typed only as a component property control, not on a node', 'TransitionControl', 'Transition');
const ANIMATION_EFFECT = documented(
  unknown('Framer documents appear, hover, press, drag, loop and scroll effects on a layer; the typings store only rotation', 'WithRotationTrait.rotation'),
  FRAMER_DOCS.animations,
);
const BORDER_SIDE_WIDTH = partial('through the four-value px border width', 'BorderWidth takes one or four px values', 'BorderWidth');
const BORDER_SIDE_COLOR = partial('the same colour as every other side', 'Border has one colour', 'Border.color');
const BORDER_SIDE_STYLE = partial('the same style as every other side; solid, dashed, dotted or double', 'Border has one style', 'Border.style', 'BorderStyle');
const BORDER_SIDE = partial('width per side, colour and style shared by all sides', 'Border holds width, colour and style', 'Border');
const CORNER = partial('through the four-px corner form of BorderRadius; no elliptical radii', 'BorderRadius takes one value or four px values', 'BorderRadius');
const PADDING_SIDE = partial('through the four-value px padding', 'padding takes one or four px values', 'WithLayoutTrait.padding');
const GAP_AXIS = partial('through the two-value px gap', 'gap takes one or two px values', 'WithLayoutTrait.gap');
const PIN = partial(PX_SIDES, 'pins are px dimensions', 'WithPinsTrait.top', 'WithPinsTrait.left');
const OVERFLOW = partial('visible, hidden, auto or clip; no scroll', 'Overflow has four values', 'Overflow', 'WithOverflowTrait.overflow');
const MIN_MAX_WIDTH = partial('px or %', 'width constraints are px or %', 'WidthConstraint');
const MIN_MAX_HEIGHT = partial('px, % or vh', 'height constraints are px, % or vh', 'HeightConstraint');
const BACKGROUND = partial(
  'one uploaded ImageAsset or one linear, radial or conic gradient; no url(), no repeating gradients, no layers, no position or size',
  'frames have backgroundImage and backgroundGradient',
  'WithBackgroundImageTrait.backgroundImage',
  'WithBackgroundGradientTrait.backgroundGradient',
  'Gradient',
);
const LINE_CLAMP = partial('a line count on a text node', 'textTruncation is a number', 'WithTextTruncationTrait.textTruncation');
const BALANCE = partial('balance on or off', 'a text style has balance', 'TextStyle.balance');
const GRID_SELF_X = partial('start, center, end or fill on a grid item', 'grid items align and fill their cell', 'WithGridItemTrait.gridItemHorizontalAlignment', 'WithGridItemTrait.gridItemFillCellWidth');
const GRID_SELF_Y = partial('start, center, end or fill on a grid item', 'grid items align and fill their cell', 'WithGridItemTrait.gridItemVerticalAlignment', 'WithGridItemTrait.gridItemFillCellHeight');

const CSS_PROPERTY: Record<string, FramerVerdict> = {
  position: partial('relative, absolute, fixed or sticky; no static', 'Position has four values', 'Position', 'WithPositionTrait.position'),
  top: PIN,
  right: PIN,
  bottom: PIN,
  left: PIN,
  inset: partial('px per side through the four pins', 'pins are px dimensions', 'WithPinsTrait.top'),
  width: partial('px, %, fr, fit-content or fit-image; no rem, em, vw, auto or calc()', 'WidthLength', 'WithSizeTrait.width', 'WidthLength'),
  height: partial('px, %, fr, vh, fit-content or fit-image; no rem, em, auto or calc()', 'HeightLength', 'WithSizeTrait.height', 'HeightLength'),
  'min-width': MIN_MAX_WIDTH,
  'max-width': MIN_MAX_WIDTH,
  'min-height': MIN_MAX_HEIGHT,
  'max-height': MIN_MAX_HEIGHT,
  'aspect-ratio': partial('one number; no auto, no a / b', 'aspectRatio is a number', 'WithAspectRatioTrait.aspectRatio'),
  'z-index': native('zIndex is a number, null for auto', 'WithZIndexTrait.zIndex'),
  overflow: OVERFLOW,
  'overflow-x': OVERFLOW,
  'overflow-y': OVERFLOW,
  opacity: native('opacity is a number', 'WithOpacityTrait.opacity'),
  rotate: partial('one number, unit not stated in the typings; no 3D axis', 'rotation is a number', 'WithRotationTrait.rotation'),
  visibility: partial('visible on or off; no collapse', 'visible is a boolean', 'WithVisibleTrait.visible'),
  'background-color': native('a colour string or a colour style', 'WithBackgroundColorTrait.backgroundColor', 'ColorStyle'),
  'background-image': BACKGROUND,
  background: BACKGROUND,
  border: partial('one width or four px widths, one colour, solid, dashed, dotted or double', 'Border holds width, colour and style', 'Border', 'BorderStyle'),
  'border-width': partial('px, one value or four', 'BorderWidth', 'BorderWidth'),
  'border-style': partial('solid, dashed, dotted or double for all sides; no none, hidden, groove, ridge, inset, outset', 'BorderStyle has four values', 'BorderStyle'),
  'border-color': partial('one colour for all four sides', 'Border has one colour', 'Border.color'),
  ...all(['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'], BORDER_SIDE_WIDTH),
  ...all(['border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'], BORDER_SIDE_COLOR),
  ...all(['border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style'], BORDER_SIDE_STYLE),
  ...all(['border-top', 'border-right', 'border-bottom', 'border-left'], BORDER_SIDE),
  'border-radius': partial('px or %, or four px corners; no elliptical radii', 'BorderRadius', 'BorderRadius'),
  ...all(['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'], CORNER),
  display: partial(
    'flex as a stack layout, grid as a grid layout, none as visible off; no inline, inline-block, contents or table',
    'LayoutType is stack or grid',
    'LayoutType',
    'WithLayoutTrait.layout',
    'WithVisibleTrait.visible',
  ),
  'flex-direction': partial('horizontal or vertical; no reverse', 'StackDirection has two values', 'StackDirection'),
  'flex-wrap': partial('on or off; no wrap-reverse', 'stackWrapEnabled is a boolean', 'StackLayout.stackWrapEnabled'),
  'justify-content': partial(
    'start, center, end, space-between, space-around or space-evenly on a stack; no stretch, left, right',
    'StackDistribution',
    'StackDistribution',
  ),
  'align-items': partial('start, center or end; no stretch, baseline', 'StackAlignment has three values', 'StackAlignment'),
  'place-content': partial('start, center or end on a grid', 'gridAlignment has three values', 'GridLayout.gridAlignment', 'GridContentAlignment'),
  gap: partial('px, one or two values', 'gap is one or two px values', 'WithLayoutTrait.gap'),
  'row-gap': GAP_AXIS,
  'column-gap': GAP_AXIS,
  padding: partial('px, one or four values', 'padding is one or four px values', 'WithLayoutTrait.padding'),
  ...all(['padding-top', 'padding-right', 'padding-bottom', 'padding-left'], PADDING_SIDE),
  'grid-template-columns': partial(
    'a column count or auto-fill, with fixed or minmax px column widths; no track lists or named lines',
    'GridLayout',
    'GridLayout.gridColumnCount',
    'GridLayout.gridColumnWidthType',
  ),
  'grid-template-rows': partial('a row count with fixed, auto or fit row height', 'GridLayout', 'GridLayout.gridRowCount', 'GridLayout.gridRowHeightType'),
  'grid-column': partial('a span count or all; no line numbers', 'gridItemColumnSpan', 'WithGridItemTrait.gridItemColumnSpan', 'GridItemColumnSpan'),
  'grid-row': partial('a span count; no line numbers', 'gridItemRowSpan is a number', 'WithGridItemTrait.gridItemRowSpan'),
  'justify-self': GRID_SELF_X,
  'align-self': GRID_SELF_Y,
  'font-family': partial("a family from Framer's font library, chosen by selector; no font stacks", 'Font has family and selector', 'Font.family', 'Font.selector'),
  'font-weight': partial('100 to 900 in steps of 100; null for custom fonts', 'fontWeights', 'fontWeights', 'Font.weight'),
  'font-style': partial('normal or italic; no oblique', 'fontStyles', 'fontStyles', 'Font.style'),
  'font-size': partial('px or rem, per breakpoint', 'TextStyle fontSize', 'TextStyle.fontSize'),
  'letter-spacing': partial('px or em', 'TextStyle letterSpacing', 'TextStyle.letterSpacing'),
  'line-height': partial('px, em or %; no unitless number', 'TextStyle lineHeight', 'TextStyle.lineHeight'),
  color: native('a text style colour, a string or a colour style', 'TextStyle.color', 'WithInlineTextStyleTrait.inlineTextStyle'),
  'text-transform': partial('none, capitalize, uppercase or lowercase; no full-width, full-size-kana', 'TextTransform', 'TextTransform'),
  'text-align': partial('left, center, right or justify; no start, end, match-parent', 'TextAlignment', 'TextAlignment'),
  'text-decoration-line': partial('none, underline or line-through; no overline, no combinations', 'TextDecoration', 'TextDecoration'),
  'text-decoration': partial('line, colour, style and thickness as separate fields; the same line values', 'TextStyle decoration fields', 'TextStyle.decoration'),
  'text-decoration-color': native('decorationColor is a colour', 'TextStyle.decorationColor'),
  'text-decoration-style': native('all five CSS values', 'TextDecorationStyle'),
  'text-decoration-thickness': partial('auto, px or em; no from-font, no %', 'decorationThickness', 'TextStyle.decorationThickness'),
  'text-decoration-skip-ink': native('all three CSS values', 'TextDecorationSkipInk'),
  'text-underline-offset': partial('auto, px or em; no %', 'decorationOffset', 'TextStyle.decorationOffset'),
  'text-wrap': BALANCE,
  'text-wrap-style': BALANCE,
  'line-clamp': LINE_CLAMP,
  '-webkit-line-clamp': LINE_CLAMP,
  'image-rendering': partial('auto or pixelated; no smooth, high-quality, crisp-edges', 'ImageRendering', 'ImageRendering'),
  'box-shadow': unknown('Shadow (box or realistic, inset, x, y, blur, spread) is typed only as a component property control, not on a node', 'ShadowControl', 'Shadow'),
  cursor: unknown('CSSCursor is typed only as a component property control, not on a node', 'CursorControl', 'CSSCursor'),
  transition: TRANSITION_CONTROL,
  'transition-delay': TRANSITION_CONTROL,
  'transition-duration': TRANSITION_CONTROL,
  'transition-timing-function': TRANSITION_CONTROL,
  'transition-property': codeOnly('Transition has no property list', 'Transition'),
  transform: ANIMATION_EFFECT,
  scale: ANIMATION_EFFECT,
  translate: ANIMATION_EFFECT,
  '--*': codeOnly("no author-named custom property; colour styles are Framer's own tokens", 'ColorStyle'),
  ...all(
    [
      'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-color', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap',
      'stroke-linejoin', 'stroke-miterlimit', 'stroke-opacity', 'stroke-width', 'stop-color', 'stop-opacity', 'flood-color',
      'flood-opacity', 'lighting-color', 'marker', 'marker-start', 'marker-mid', 'marker-end', 'cx', 'cy', 'r', 'rx', 'ry', 'x',
      'y', 'd', 'paint-order', 'vector-effect', 'shape-rendering', 'text-anchor', 'dominant-baseline', 'alignment-baseline',
      'baseline-shift', 'clip-rule', 'color-interpolation-filters', 'mask-type',
    ],
    SVG_PRESENTATION,
  ),
};

// CSS values

const COLOR_SYNTAX = unknown('colours are typed as a plain string; which syntaxes Framer accepts is not stated', 'WithBackgroundColorTrait.backgroundColor', 'ColorStop.color');
const TRANSITION_VALUE = unknown('Transition has duration, delay and a four-number ease, typed only as a component property control', 'Transition', 'TransitionControl');
const ROTATION_UNIT = unknown('rotation is a bare number and the typings state no unit', 'WithRotationTrait.rotation');

const CSS_VALUE: Record<string, FramerVerdict> = {
  px: native('the unit of every pin, size, gap, padding, border and radius', 'CSSUnit', 'PixelNumber'),
  '<percentage>': native('sizes, constraints, radii and line height take %', 'CSSUnit', 'Length'),
  '<number>': native('opacity, aspect ratio and grid counts are numbers', 'WithOpacityTrait.opacity', 'WithAspectRatioTrait.aspectRatio'),
  rem: partial('font size only', 'fontSize is px or rem', 'TextStyle.fontSize', 'CSSUnit'),
  em: partial('letter spacing, line height, decoration thickness and offset only', 'em appears in four text fields', 'TextStyle.letterSpacing', 'TextStyle.lineHeight'),
  fr: partial('width and height only', 'Length is px, % or fr', 'Length', 'CSSUnit'),
  vh: partial('height and its constraints only', 'HeightLength and HeightConstraint take vh', 'HeightLength', 'HeightConstraint'),
  vw: unknown('CSSUnit declares vw, but no trait accepts it', 'CSSUnit'),
  deg: ROTATION_UNIT,
  '<angle>': ROTATION_UNIT,
  'rotate()': ROTATION_UNIT,
  '<transform-function>': ROTATION_UNIT,
  '<color>': partial(
    'typed as a string or a colour style; hex with alpha measured on a published Framer page (docs/plans/2026-11-02-theme-and-head.md), other syntaxes unknown',
    'colours are strings or ColorStyle',
    'WithBackgroundColorTrait.backgroundColor',
    'ColorStyle',
  ),
  ...all(['rgb()', 'rgba()', 'hsl()', 'hsla()', 'hwb()', 'lab()', 'lch()', 'oklab()', 'oklch()', 'color()', 'color-mix()', 'light-dark()'], COLOR_SYNTAX),
  '<integer>': partial('typed as number, not integer: grid counts and spans', 'grid counts are numbers', 'GridLayout.gridColumnCount', 'WithGridItemTrait.gridItemRowSpan'),
  '<image>': partial('an uploaded ImageAsset or one gradient', 'ImageAsset and Gradient', 'ImageAsset', 'Gradient'),
  '<url>': partial('an uploaded ImageAsset or a link URL, not an arbitrary url()', 'ImageAsset.url and links', 'ImageAsset.url', 'LinkToUrl'),
  '<length>': partial('px in most places; rem and em only in named text fields', 'CSSDimension per trait', 'CSSDimension', 'CSSUnit'),
  '<length-percentage>': partial('px or % where a trait allows it', 'CSSDimension per trait', 'CSSDimension', 'Length'),
  '<ratio>': partial('one number, not a / b', 'aspectRatio is a number', 'WithAspectRatioTrait.aspectRatio'),
  '<overflow>': partial('visible, hidden, auto or clip; no scroll', 'Overflow', 'Overflow'),
  '<line-style>': partial('solid, dashed, dotted or double', 'BorderStyle', 'BorderStyle'),
  '<gradient>': partial('linear, radial or conic, no repeating', 'Gradient', 'Gradient'),
  'linear-gradient()': partial('an angle and colour stops', 'LinearGradient', 'LinearGradient', 'ColorStop'),
  'radial-gradient()': partial('width, height, x and y in %, and colour stops', 'RadialGradient', 'RadialGradient', 'ColorStop'),
  'conic-gradient()': partial('an angle, x and y in %, and colour stops', 'ConicGradient', 'ConicGradient', 'ColorStop'),
  ...all(['repeating-linear-gradient()', 'repeating-radial-gradient()', 'repeating-conic-gradient()'], codeOnly('Gradient is linear, radial or conic only', 'Gradient')),
  ms: TRANSITION_VALUE,
  s: TRANSITION_VALUE,
  '<time>': TRANSITION_VALUE,
  '<easing-function>': TRANSITION_VALUE,
  'cubic-bezier()': TRANSITION_VALUE,
  ...all(['linear()', 'steps()'], codeOnly('Transition.ease is four numbers, a cubic bezier only', 'Transition')),
};

// Selectors, at-rules, media features

const MEASURED_HOVER =
  'measured on framer.app 2026-11-01: a component hover state is applied by script (a hover class and inline style), there is no CSS :hover rule, and with scripts blocked hover did nothing';

const CSS_SELECTOR: Record<string, FramerVerdict> = {
  ':hover': partial(`a hover variant of a component, not a selector on any element; ${MEASURED_HOVER}`, 'Gesture includes hover', 'Gesture', 'WithComponentVariantTrait.gesture'),
  ':active': partial('a pressed variant of a component, not a selector on any element', 'Gesture includes pressed', 'Gesture', 'WithComponentVariantTrait.gesture'),
};

const CSS_AT_RULE: Record<string, FramerVerdict> = {
  '@media': partial(
    'width breakpoints only: breakpoint frames and text style breakpoints by minWidth',
    'breakpoints are typed',
    'WithBreakpointTrait.isBreakpoint',
    'TextStyleBreakpointData.minWidth',
  ),
  '@font-face': unknown("fonts come from Framer's font library by selector; uploading a face is not typed", 'Font.selector', 'FramerPluginAPI.getFonts'),
};

const CSS_MEDIA_FEATURE: Record<string, FramerVerdict> = {
  width: partial('min-width breakpoints only', 'breakpoints by minWidth', 'WithBreakpointTrait.isBreakpoint', 'TextStyleBreakpointData.minWidth'),
  'prefers-color-scheme': partial('a colour style holds a light and a dark value; how the mode is chosen is not typed', 'ColorStyle light and dark', 'ColorStyle.light', 'ColorStyle.dark'),
};

// WAI-ARIA patterns

const VARIANT_PATTERN = (reason: string) =>
  documented(partial('visual states by variants and Click; keyboard behaviour and ARIA states are not documented', reason, 'WithComponentVariantTrait.isVariant'), FRAMER_DOCS.animations);

const ARIA_PATTERN: Record<string, FramerVerdict> = {
  link: partial('a link target on a frame or text; keyboard and roles of the published markup not measured', 'WithLinkTrait', 'WithLinkTrait.link'),
  button: VARIANT_PATTERN('a frame with Hover and Pressed variants and a Click interaction'),
  disclosure: VARIANT_PATTERN('closed and open variants switched by Click'),
  accordion: VARIANT_PATTERN('closed and open variants per item switched by Click'),
  tabs: VARIANT_PATTERN('one variant per tab switched by Click'),
  tooltip: documented(
    partial('a variant shown on Mouse enter and hidden on Mouse leave; focus and Escape are not documented', 'Mouse enter and Mouse leave triggers', 'WithComponentVariantTrait.isVariant'),
    FRAMER_DOCS.animations,
  ),
  'dialog-modal': documented(
    partial('Show Overlay opens a fixed overlay; focus trap, Escape and aria-modal are not documented', 'the Show Overlay action', 'KnownNodeClass'),
    FRAMER_DOCS.triggers,
  ),
  alert: documented(
    partial('Show Overlay is documented for popups and alerts; role alert and announcement are not documented', 'the Show Overlay action', 'KnownNodeClass'),
    FRAMER_DOCS.triggers,
  ),
};

// Reusable component promises

const VARIABLE = (symbol: string) => native(`a component variable of this type (${symbol})`, 'ComponentVariable', symbol);
const CONTROL_ONLY = (symbol: string) =>
  partial(`typed as a property control on a component instance (${symbol}), not among the ComponentVariable kinds`, 'Control union member', 'Control', symbol);
const DOCUMENTED_INTERACTION = (reason: string, docUrl: string) =>
  documented(partial('variant changes, navigation and overlays only', reason, 'WithComponentVariantTrait.isVariant'), docUrl);

const COMPONENT: Record<string, FramerVerdict> = {
  text: VARIABLE('StringVariable'),
  number: VARIABLE('NumberVariable'),
  toggle: VARIABLE('BooleanVariable'),
  color: VARIABLE('ColorVariable'),
  image: VARIABLE('ImageVariable'),
  link: VARIABLE('LinkVariable'),
  choice: VARIABLE('EnumVariable'),
  richtext: VARIABLE('FormattedTextVariable'),
  file: VARIABLE('FileVariable'),
  date: VARIABLE('DateVariable'),
  border: VARIABLE('BorderVariable'),
  shadow: CONTROL_ONLY('ShadowControl'),
  cursor: CONTROL_ONLY('CursorControl'),
  transition: CONTROL_ONLY('TransitionControl'),
  list: CONTROL_ONLY('ArrayControl'),
  gallery: partial('an ArrayControl whose items are ImageControl, on a component instance; not a ComponentVariable kind', 'ArrayItemControl includes ImageControl', 'ArrayControl', 'ArrayItemControl', 'ImageControl'),
  event: documented(
    partial('typed as a property control with no value; a nested component triggers its parent', 'EventHandlerControl', 'EventHandlerControl'),
    FRAMER_DOCS.events,
  ),
  definition: native('a component node', 'ComponentNode', 'createableNodes'),
  placement: native('a component instance node', 'ComponentInstanceNode', 'FramerPluginAPI.addComponentInstance'),
  'placement-style': native('an instance has position, pins, size, constraints, opacity and rotation', 'EditableComponentInstanceNodeAttributes'),
  nested: unknown('instances can be parented anywhere, but whether an instance inside a component definition is supported is not typed', 'FramerPluginAPI.setParent'),
  'cycle-refused': unknown('the typings do not say what happens when a component contains itself', 'ComponentInstanceNode'),
  'collection-template': unknown('collections and items are typed, but binding a component to a collection list is not', 'Collection', 'CollectionItem'),
  'state-hover': native('a hover gesture variant', 'Gesture', 'WithComponentVariantTrait.gesture'),
  'state-pressed': native('a pressed gesture variant', 'Gesture', 'WithComponentVariantTrait.gesture'),
  'state-focused': codeOnly('Gesture has hover, pressed, loading and error; no focus', 'Gesture'),
  'state-custom': native('a variant that inherits from another', 'WithComponentVariantTrait.isVariant', 'WithComponentVariantTrait.inheritsFromId'),
  'interaction-click': DOCUMENTED_INTERACTION('the Click trigger connects variants', FRAMER_DOCS.animations),
  'interaction-appear': DOCUMENTED_INTERACTION('the Appear effect animates a layer as it becomes visible', FRAMER_DOCS.appear),
  'placement-trigger': documented(
    partial('the automatic Trigger field of a placed instance; not typed', 'seen in the editor', 'ComponentInstanceNode'),
    undefined,
    FRAMER_EDITOR_TEST,
  ),
};

// Page-level items

const MODE = unknown('a colour style holds both values; how a site picks light, dark or system is not typed', 'ColorStyle.dark');
const DOCUMENT = unknown('no document-level attribute; a web page node holds only path and collectionId', 'WithWebPageInfoTrait');

const PAGE_ITEM: Record<string, FramerVerdict> = {
  'theme:color-token': native('a shared colour style', 'ColorStyle', 'FramerPluginAPI.createColorStyle'),
  'theme:dark-value': native('a colour style has a dark value', 'ColorStyle.dark'),
  'theme:font-token': partial('a text style (tag, font, size per breakpoint), not a bare font token', 'TextStyle has font', 'TextStyle.font', 'FramerPluginAPI.createTextStyle'),
  'theme:mode-system': MODE,
  'theme:mode-light': MODE,
  'theme:mode-dark': MODE,
  'theme:document-background': DOCUMENT,
  'theme:document-color': DOCUMENT,
  'theme:document-font': DOCUMENT,
};

// The classifier

interface KindRules {
  table: Record<string, FramerVerdict>;
  fallback: (id: string) => FramerVerdict;
}

const CODE_ONLY_DEFAULT = (): FramerVerdict => codeOnly();

export const FRAMER_RULES: Record<RowKind, KindRules> = {
  'html-element': { table: HTML_ELEMENT, fallback: CODE_ONLY_DEFAULT },
  'html-global-attribute': { table: HTML_GLOBAL_ATTRIBUTE, fallback: CODE_ONLY_DEFAULT },
  'html-element-attribute': {
    table: HTML_ELEMENT_ATTRIBUTE,
    fallback: (id) => (id.startsWith('input.') || id.startsWith('form.') ? FORMS : codeOnly()),
  },
  'html-event-handler': { table: HTML_EVENT_HANDLER, fallback: () => codeOnly(`${NO_SYMBOL}; code overrides or code components only`, 'FramerPluginAPI.createCodeFile') },
  'svg-element': { table: SVG_ELEMENT, fallback: () => SVG_IN_STRING },
  'svg-attribute': {
    table: {},
    fallback: (id) => {
      const [element, attribute = ''] = id.split('.');
      if ((SVG_UNSETTLED as readonly string[]).includes(element) || attribute.startsWith('on')) return SVG_UNSETTLED_VERDICT;
      return SVG_IN_STRING;
    },
  },
  'mathml-element': { table: {}, fallback: () => codeOnly(`${NO_SYMBOL}; MathML only as raw HTML in a code component or custom code`, 'FramerPluginAPI.setCustomCode') },
  'mathml-attribute': { table: {}, fallback: () => codeOnly(`${NO_SYMBOL}; MathML only as raw HTML in a code component or custom code`, 'FramerPluginAPI.setCustomCode') },
  'css-property': { table: CSS_PROPERTY, fallback: CODE_ONLY_DEFAULT },
  'css-value': { table: CSS_VALUE, fallback: CODE_ONLY_DEFAULT },
  'css-selector': { table: CSS_SELECTOR, fallback: () => codeOnly('no selector or stylesheet authoring is typed; only site custom code', 'FramerPluginAPI.setCustomCode') },
  'css-at-rule': { table: CSS_AT_RULE, fallback: () => codeOnly('no stylesheet authoring is typed; only site custom code', 'FramerPluginAPI.setCustomCode') },
  'css-media-feature': { table: CSS_MEDIA_FEATURE, fallback: () => codeOnly('breakpoints are by width only; anything else needs site custom code', 'FramerPluginAPI.setCustomCode') },
  'aria-pattern': { table: ARIA_PATTERN, fallback: () => unknown('no typed path and no fetched Framer page covers it', 'KnownNodeClass') },
  component: { table: COMPONENT, fallback: () => unknown('a component promise this mapping has not settled', 'ComponentNode') },
  'page-item': { table: PAGE_ITEM, fallback: () => unknown('a page-level item this mapping has not settled', 'WithWebPageInfoTrait') },
  // Lumitra FX scenes are this app's own engine. What the typings do say: no node class draws a layered
  // WebGL scene. Whether a code component can draw the same one has not been looked into, so beyond
  // that nothing is claimed either way.
  'fx-scene': { table: {}, fallback: () => unknown('an FX scene of this app\'s own engine: no node class of the plugin typings draws a layered WebGL scene, and a code component has not been tried', 'KnownNodeClass') },
};

export function classifyFramer(kind: string, id: string): FramerVerdict {
  if (!(ROW_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`Framer mapping: unknown row kind "${kind}" (row "${kind}:${id}"); add rules for it in test/score/lib/framer/mapping.ts`);
  }
  const rules = FRAMER_RULES[kind as RowKind];
  return rules.table[id] ?? rules.fallback(id);
}

// src/lib/styles/customEditor.ts
//
// The rules of the Custom section of the properties panel, the general editor
// for any CSS property, any attribute and an element's tag. PURE, and imported by
// the model, so a refused tag cannot be written from anywhere. Each check returns
// the message the panel shows, or null when the input is fine. The rules are the
// renderers' own: a value the published stylesheet would drop
// (src/lib/responsive/responsiveCss.ts), a tag or prop that never reaches a page
// (src/lib/renderer/blockedNodes.ts), a link target that is not safe
// (src/lib/links/safeHref.ts).

import { isVoidTag } from '@/lib/drag/voidTags';
import { isSafeHref } from '@/lib/links/safeHref';
import { isDroppedId, isDroppedProp, isRefusedTag } from '@/lib/renderer/blockedNodes';
import { isRenderedAttribute } from '@/lib/renderer/renderVocabulary';
import { bareTextRefusal, isTextNodeType } from '@/lib/renderer/textNode';
import { cssPropertyName, cssStyleKey, unsafeDeclaration } from '@/lib/responsive/responsiveCss';
import {
  cssProperties,
  elementAttributes,
  elements,
  globalAttributes,
  legacyCssProperties,
} from '@/lib/styles/webPlatformNames.generated';

// ---------- CSS ----------

const KNOWN_PROPERTIES: ReadonlySet<string> = new Set([...cssProperties, ...legacyCssProperties]);
const VENDOR_PROPERTY = /^-(?:webkit|moz|ms|o)-[a-z][a-z-]*$/;
const CUSTOM_PROPERTY = /^--[A-Za-z0-9_-]+$/;

export { cssProperties as cssPropertySuggestions };

/** What was typed as a property name, in CSS spelling: `clipPath` and `clip-path` both name it. */
export function cssPropertySpelling(typed: string): string {
  const name = typed.trim();
  if (name.startsWith('--')) return name;
  return /[A-Z]/.test(name) && !name.includes('-') ? cssPropertyName(name) : name.toLowerCase();
}

/** Why this cannot be a property name, or null. */
export function cssPropertyError(typed: string): string | null {
  const name = cssPropertySpelling(typed);
  if (name === '') return 'Type a CSS property.';
  const known = KNOWN_PROPERTIES.has(name) || VENDOR_PROPERTY.test(name) || CUSTOM_PROPERTY.test(name);
  if (!known || unsafeDeclaration(cssStyleKey(name), undefined)) {
    return `${name} is not a CSS property. A custom property starts with --.`;
  }
  return null;
}

/** Why this value is not stored, or null: exactly what the published stylesheet would drop. */
export function cssValueError(styleKey: string, value: string): string | null {
  if (unsafeDeclaration(styleKey, value.trim()) === null) return null;
  return 'Not saved: this value could break out of the page or load code. Check for { }, for ; < > \\ outside quotes, an unclosed bracket or quote, and script addresses.';
}

/** False when this browser reads the declaration as invalid, so it would silently do nothing. */
export function isSupportedDeclaration(property: string, value: string): boolean {
  if (property.startsWith('--') || value.trim() === '') return true;
  return typeof CSS === 'undefined' || typeof CSS.supports !== 'function' || CSS.supports(property, value);
}

// ---------- ATTRIBUTES ----------

/** Attributes React spells differently from HTML. Anything else keeps its HTML name. */
const CAMEL_CASE_PROPS = [
  'accessKey', 'allowFullScreen', 'autoCapitalize', 'autoComplete', 'autoCorrect', 'autoFocus', 'autoPlay',
  'cellPadding', 'cellSpacing', 'charSet', 'colSpan', 'contentEditable', 'controlsList', 'crossOrigin',
  'dateTime', 'disablePictureInPicture', 'disableRemotePlayback', 'encType', 'enterKeyHint', 'fetchPriority',
  'formAction', 'formEncType', 'formMethod', 'formNoValidate', 'formTarget', 'hrefLang', 'imageSizes',
  'imageSrcSet', 'inputMode', 'itemID', 'itemProp', 'itemRef', 'itemScope', 'itemType', 'maxLength', 'minLength',
  'noModule', 'noValidate', 'playsInline', 'popoverTarget', 'popoverTargetAction', 'readOnly', 'referrerPolicy',
  'rowSpan', 'spellCheck', 'srcDoc', 'srcLang', 'srcSet', 'tabIndex', 'useMap',
];

const PROP_OF_ATTRIBUTE: ReadonlyMap<string, string> = new Map([
  ...CAMEL_CASE_PROPS.map((prop): [string, string] => [prop.toLowerCase(), prop]),
  ['class', 'className'],
  ['for', 'htmlFor'],
  ['accept-charset', 'acceptCharset'],
  ['http-equiv', 'httpEquiv'],
]);

const ATTRIBUTE_OF_PROP: ReadonlyMap<string, string> = new Map(
  [...PROP_OF_ATTRIBUTE].map(([attribute, prop]) => [prop, attribute]),
);

/** A `value` or `checked` prop would freeze a form control, so they store the starting state. */
const STARTING_STATE: Readonly<Record<string, { attribute: string; prop: string }>> = {
  input: { attribute: 'value', prop: 'defaultValue' },
  textarea: { attribute: 'value', prop: 'defaultValue' },
  select: { attribute: 'value', prop: 'defaultValue' },
};

/** The prop a node stores for an attribute on this tag. */
export function attributeProp(attribute: string, tag: string): string {
  const name = attribute.trim().toLowerCase();
  if (name === STARTING_STATE[tag]?.attribute) return STARTING_STATE[tag].prop;
  if (name === 'checked' && tag === 'input') return 'defaultChecked';
  return PROP_OF_ATTRIBUTE.get(name) ?? attribute.trim();
}

/** The HTML name of a stored prop, the reverse of attributeProp. */
export function attributeName(prop: string): string {
  if (prop === 'defaultValue') return 'value';
  if (prop === 'defaultChecked') return 'checked';
  return ATTRIBUTE_OF_PROP.get(prop) ?? prop;
}

/** Props that are the editor's own data, or that React reads as more than an attribute. */
const RESERVED_PROPS: ReadonlySet<string> = new Set([
  'children', 'key', 'ref', 'style', 'query', 'bindings', 'effects', 'behaviour', 'dangerouslySetInnerHTML',
  'suppressContentEditableWarning', 'suppressHydrationWarning', 'hostType',
]);

/** Attributes the editor and renderers use as markers: changing one changes what the node is. */
const RESERVED_MARKER =
  /^data-(?:form-|component-|inner-component-|credit-|decorative$|sticky-cta$|map-embed$|fc-|viewport-id$|floating-root-id$|text-node-row$|editor-ui$|ground)/i;

/** Attributes whose value is an address a browser follows or loads. */
const URL_ATTRIBUTES: ReadonlySet<string> = new Set([
  'action', 'background', 'cite', 'data', 'formaction', 'href', 'poster', 'src', 'xlink:href',
]);

const SCRIPT_ADDRESS = /(?:javascript|vbscript)\s*:/i;
const ATTRIBUTE_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;

/** A prop the Custom section lists as an attribute of the node. */
export function isAttributeProp(prop: string): boolean {
  return ATTRIBUTE_NAME.test(prop) && !RESERVED_PROPS.has(prop) && !RESERVED_MARKER.test(prop) && !/^on/i.test(prop);
}

/** Why this cannot be an attribute of the tag, or null. */
export function attributeNameError(typed: string, tag: string): string | null {
  const name = typed.trim();
  if (name === '') return 'Type an attribute name.';
  if (!ATTRIBUTE_NAME.test(name)) return `${name} is not an attribute name.`;
  const prop = attributeProp(name, tag);
  const lower = name.toLowerCase();
  if (/^on/i.test(name) || lower === 'srcdoc' || prop === 'dangerouslySetInnerHTML') {
    return 'A page runs no stored code, so event handlers and raw HTML are not available.';
  }
  if (lower === 'style') return 'Add styles as CSS properties above.';
  if (!isRenderedAttribute(prop.toLowerCase())) return `${name} is not available on a page: nothing would render it.`;
  if (!isAttributeProp(prop)) return `${name} belongs to the editor and cannot be set here.`;
  return null;
}

/** Why this value is not stored on this tag, or null. */
export function attributeValueError(attribute: string, value: string, tag?: string): string | null {
  const name = attribute.trim().toLowerCase();
  if (URL_ATTRIBUTES.has(name) && value.trim() !== '' && !isSafeHref(value)) {
    return 'Not saved: use a page path (/contact), #section, https://, mailto: or tel:';
  }
  if (SCRIPT_ADDRESS.test(value)) return 'Not saved: this value could run code.';
  const reserved = isDroppedProp(attributeProp(attribute, ''), value) || (name === 'id' && isDroppedId(tag, value));
  return reserved ? 'Not saved: this value is reserved by the page itself.' : null;
}

/** Present or absent is the whole value: React reads the string "false" as true. */
const BOOLEAN_ATTRIBUTES: ReadonlySet<string> = new Set([
  'allowfullscreen', 'async', 'autofocus', 'autoplay', 'checked', 'controls', 'default', 'defer', 'disabled',
  'disablepictureinpicture', 'disableremoteplayback', 'formnovalidate', 'hidden', 'inert', 'ismap', 'itemscope',
  'loop', 'multiple', 'muted', 'nomodule', 'novalidate', 'open', 'playsinline', 'readonly', 'required',
  'reversed', 'selected',
]);

export function isBooleanAttribute(attribute: string): boolean {
  return BOOLEAN_ATTRIBUTES.has(attribute.trim().toLowerCase());
}

/** What a node stores for a typed value. `undefined` removes the prop. */
export function attributeStoredValue(attribute: string, value: string): string | boolean | undefined {
  if (!isBooleanAttribute(attribute)) return value;
  const text = value.trim().toLowerCase();
  return text === 'false' ? undefined : true;
}

/** The attributes to suggest for a tag. */
export function attributeSuggestions(tag: string): string[] {
  const own = (elementAttributes as Record<string, string[]>)[tag] ?? [];
  return [...new Set([...globalAttributes, ...own])].sort();
}

// ---------- TAGS ----------

/** The document shell: the published route owns these, and a node always sits inside body. */
const SHELL_TAGS: ReadonlySet<string> = new Set(['html', 'head', 'body', 'title']);

const TAG_NAME = /^[a-z][a-z0-9-]*$/;

/** What a node holds, for the tags that cannot hold it. */
export interface NodeContent {
  childCount: number;
  /** The node's `props.children`. */
  text: unknown;
  /** True when a child is bare text (src/lib/renderer/textNode.ts). */
  hasTextNode?: boolean;
}

const holdsText = (text: unknown) => (typeof text === 'string' && text !== '') || typeof text === 'number';

/** Why a node with this content cannot become this tag, or null. */
export function tagRefusal(tag: string, content: NodeContent): string | null {
  if (!TAG_NAME.test(tag)) return `${tag} is not a tag.`;
  if (SHELL_TAGS.has(tag)) return `<${tag}> belongs to the page itself, not to an element on it.`;
  if (isRefusedTag(tag)) return `<${tag}> is not allowed on a page: it could run or embed outside code.`;
  const hasContent = content.childCount > 0 || holdsText(content.text);
  if (isVoidTag(tag) && hasContent) return `<${tag}> cannot hold content. Remove its text and children first.`;
  if (tag === 'textarea' && content.childCount > 0) return '<textarea> holds only text. Remove its children first.';
  // The same list a drop obeys: text in here would not stay where the tree says.
  if (holdsText(content.text) || content.hasTextNode) return bareTextRefusal(tag) ?? null;
  return null;
}

/** What tagRefusal needs to know about a node. */
export function contentOf(node: { props?: unknown; children: readonly { type: string }[] }): NodeContent {
  return {
    childCount: node.children.length,
    text: (node.props as { children?: unknown } | undefined)?.children,
    hasTextNode: node.children.some(child => isTextNodeType(child.type)),
  };
}

const TAG_GROUPS: readonly { label: string; tags: readonly string[] }[] = [
  { label: 'Text', tags: ['p', 'span', 'blockquote', 'pre', 'code', 'strong', 'em', 'small', 'mark', 'a', 'label'] },
  { label: 'Headings', tags: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hgroup'] },
  { label: 'Page structure', tags: ['div', 'section', 'article', 'aside', 'header', 'footer', 'main', 'nav', 'search', 'address', 'figure', 'figcaption', 'hr'] },
  { label: 'Lists', tags: ['ul', 'ol', 'li', 'menu', 'dl', 'dt', 'dd'] },
  { label: 'Tables', tags: ['table', 'caption', 'colgroup', 'col', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td'] },
  { label: 'Forms', tags: ['form', 'fieldset', 'legend', 'button', 'input', 'textarea', 'select', 'selectedcontent', 'optgroup', 'option', 'datalist', 'output', 'meter', 'progress'] },
  { label: 'Interactive', tags: ['details', 'summary', 'dialog'] },
  { label: 'Media', tags: ['img', 'picture', 'source', 'video', 'audio', 'track', 'canvas', 'map', 'area'] },
];

/** The tags on offer, in groups: every element of the data that a page can show. */
export function tagGroups(): { label: string; tags: string[] }[] {
  const allowed = elements.filter((tag) => !isRefusedTag(tag));
  const named = new Set(TAG_GROUPS.flatMap((group) => group.tags));
  return [
    ...TAG_GROUPS.map(({ label, tags }) => ({ label, tags: tags.filter((tag) => allowed.includes(tag)) })),
    { label: 'Other', tags: allowed.filter((tag) => !named.has(tag)) },
  ];
}

/** Where browsers keep a tag. Elsewhere the HTML parser moves or drops it, so the panel says so. */
const PARENT_TAGS: Readonly<Record<string, readonly string[]>> = {
  area: ['map'],
  caption: ['table'],
  col: ['colgroup'],
  colgroup: ['table'],
  dd: ['dl', 'div'],
  dt: ['dl', 'div'],
  figcaption: ['figure'],
  legend: ['fieldset'],
  li: ['ul', 'ol', 'menu'],
  optgroup: ['select'],
  option: ['select', 'optgroup', 'datalist'],
  rp: ['ruby'],
  rt: ['ruby'],
  source: ['picture', 'audio', 'video'],
  summary: ['details'],
  tbody: ['table'],
  td: ['tr'],
  tfoot: ['table'],
  th: ['tr'],
  thead: ['table'],
  tr: ['table', 'thead', 'tbody', 'tfoot'],
  track: ['audio', 'video'],
};

/** A note when this tag is out of place in its parent, or null. It never blocks: parents are often changed next. */
export function tagNestingHint(tag: string, parentTag: string | undefined): string | null {
  const parents = PARENT_TAGS[tag];
  if (!parents || !parentTag || parents.includes(parentTag)) return null;
  return `<${tag}> belongs inside ${parents.map((p) => `<${p}>`).join(' or ')}. Here browsers may move or drop it on the published page.`;
}

// src/components/sidebars/right/ownedKeys.ts
//
// What the hand-written sections of the properties panel already have a control
// for, per section, so the Custom section neither lists nor accepts those: one
// property, one control. It goes by the sections a category actually shows, so
// `font-size` on an image, which has no Typography section, stays available in
// Custom. A control that takes only a number or a fixed list cannot hold every
// value, so `width: calc(100% - 8px)` belongs to Custom while `width: 10px` belongs
// to the Size section. A test scans the section sources, so a new control cannot be
// missed.

import { SECTION_MAP, type ComponentCategory, type SectionId } from './sectionConfig';

const SECTION_TITLES: Partial<Record<SectionId, string>> = {
  size: 'Size',
  position: 'Position',
  layout: 'Layout',
  typography: 'Typography',
  image: 'Image',
  styles: 'Styles',
};

export const SECTION_STYLE_KEYS: Partial<Record<SectionId, readonly string[]>> = {
  size: ['width', 'height', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight'],
  position: ['position', 'top', 'right', 'bottom', 'left', 'zIndex'],
  layout: [
    'display', 'flexDirection', 'flexWrap', 'justifyContent', 'alignItems', 'gap', 'rowGap', 'columnGap',
    'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  ],
  typography: ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'textAlign', 'textDecoration'],
  image: ['objectFit', 'objectPosition', 'backgroundImage', 'backgroundPosition', 'backgroundRepeat', 'backgroundSize'],
  styles: [
    'opacity', 'display', 'backgroundColor', 'color', 'overflow', 'borderRadius', 'borderTopLeftRadius',
    'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius', 'borderWidth', 'borderStyle',
    'borderColor', 'boxShadow',
  ],
};

/** The Image section edits an image's fit, and a container's background photo. */
const notForCategory: Partial<Record<ComponentCategory, ReadonlySet<string>>> = {
  image: new Set(['backgroundImage', 'backgroundPosition', 'backgroundRepeat', 'backgroundSize']),
  container: new Set(['objectFit', 'objectPosition']),
};

/** The style keys with a control in this category's sections, and the title of that section. */
export function ownedStyleKeys(category: ComponentCategory): ReadonlyMap<string, string> {
  const owned = new Map<string, string>();
  for (const section of SECTION_MAP[category]) {
    for (const key of SECTION_STYLE_KEYS[section] ?? []) {
      if (!notForCategory[category]?.has(key)) owned.set(key, SECTION_TITLES[section] ?? section);
    }
  }
  return owned;
}

/** Keys whose control is a number with a unit. */
const NUMERIC_KEYS: ReadonlySet<string> = new Set([
  'width', 'height', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'top', 'right', 'bottom', 'left',
  'gap', 'rowGap', 'columnGap', 'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'fontSize', 'letterSpacing', 'lineHeight', 'borderRadius', 'borderTopLeftRadius', 'borderTopRightRadius',
  'borderBottomLeftRadius', 'borderBottomRightRadius', 'borderWidth',
]);

const NUMERIC_VALUE = /^(?:-?\d*\.?\d+(?:px|%)?|auto|none)$/i;
const DISPLAY_CONTROL: ReadonlySet<string> = new Set(['block', 'flex', 'grid', 'none']);

/** True when the section's control takes only some values of this key, so Custom holds the rest. */
export function isPartlyOwned(key: string): boolean {
  return key === 'display' || NUMERIC_KEYS.has(key);
}

/** True when the key's own control can show and edit this value. */
export function controlHolds(key: string, value: string): boolean {
  const text = value.trim();
  if (text === '') return true;
  if (key === 'display') return DISPLAY_CONTROL.has(text);
  return !NUMERIC_KEYS.has(key) || NUMERIC_VALUE.test(text);
}

const FORM_FIELD_PROPS = [
  'label', 'name', 'placeholder', 'required', 'minLength', 'maxLength', 'options', 'inputBackground',
  'inputBorderColor', 'inputTextColor', 'inputRadius',
];

const CATEGORY_PROPS: Partial<Record<ComponentCategory, readonly string[]>> = {
  link: ['href'],
  image: ['src', 'alt'],
  form: ['formName', 'successBehavior', 'successMessage', 'redirectPageId', 'notifyEmail'],
  formField: FORM_FIELD_PROPS,
  formSubmit: ['loadingLabel'],
  stickyCta: ['ctaLabel', 'ctaHref', 'buttonBackground', 'buttonTextColor', 'buttonRadius'],
  mapEmbed: ['mapUrl', 'mapAddress', 'mapTitle'],
};

/** The props with a control of their own in this category's sections. */
export function ownedProps(category: ComponentCategory): ReadonlySet<string> {
  return new Set(CATEGORY_PROPS[category] ?? []);
}

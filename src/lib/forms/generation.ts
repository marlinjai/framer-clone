// src/lib/forms/generation.ts
//
// What the AI page generator may set on the form presets, and how it is
// cleaned (published site essentials, decision 4). The validator
// (src/lib/ai/pageGen/validate.ts) asks `formPropKeysFor` which extra props a
// form preset accepts and runs `sanitizeGeneratedFormProps` over them; the
// preset's own defaults (including `data-form-kind` and `fieldType`) come from
// the registry and can never be set or changed by the model. Raw form tags
// (form, input, select, textarea) stay forbidden in the generator: forms are
// only ever built from these presets.
//
// Client-safe.

import {
  FORM_LIMITS,
  TYPE_LENGTH,
  formKindOf,
  normalizeFieldKey,
  readFieldAppearance,
  readOptions,
  type FormKind,
} from './definition';

const FORM_KEYS: Record<FormKind, readonly string[]> = {
  form: ['formName', 'successMessage'],
  'form-field': [
    'label',
    'name',
    'placeholder',
    'required',
    'minLength',
    'maxLength',
    'options',
    'inputBackground',
    'inputBorderColor',
    'inputTextColor',
    'inputRadius',
  ],
  'form-submit': ['loadingLabel'],
};

/** The form kind of a generation preset (from its registry defaults), or null. */
export function presetFormKind(defaultProps: Record<string, unknown> | undefined): FormKind | null {
  return formKindOf(defaultProps);
}

/** Extra props a form preset accepts from the model (empty for every other preset). */
export function formPropKeysFor(defaultProps: Record<string, unknown> | undefined): readonly string[] {
  const kind = presetFormKind(defaultProps);
  return kind ? FORM_KEYS[kind] : [];
}

function cleanString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const v = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return v ? v.slice(0, max) : undefined;
}

function cleanLength(value: unknown, ceiling: number): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(Math.trunc(n), ceiling);
}

/**
 * The model's form props, cleaned: strings bounded and stripped of control
 * characters, the name normalized to a safe key, lengths clamped to the field
 * type's ceiling, options de-duplicated. A value that cannot be used is dropped
 * with a warning, never passed through.
 */
export function sanitizeGeneratedFormProps(
  defaultProps: Record<string, unknown> | undefined,
  modelProps: Record<string, unknown>,
  warn: (message: string) => void,
): Record<string, unknown> {
  const kind = presetFormKind(defaultProps);
  if (!kind) return {};
  const out: Record<string, unknown> = {};
  const drop = (key: string) => warn(`form prop "${key}" could not be used, dropped`);
  const fieldType = typeof defaultProps?.fieldType === 'string' ? (defaultProps.fieldType as keyof typeof TYPE_LENGTH) : 'text';
  const ceiling = TYPE_LENGTH[fieldType]?.ceiling ?? 0;

  for (const key of FORM_KEYS[kind]) {
    if (!Object.prototype.hasOwnProperty.call(modelProps, key)) continue;
    const value = modelProps[key];
    switch (key) {
      case 'formName': {
        const v = cleanString(value, FORM_LIMITS.maxFormNameChars);
        if (v) out.formName = v;
        else drop(key);
        break;
      }
      case 'successMessage': {
        const v = cleanString(value, FORM_LIMITS.maxSuccessMessageChars);
        if (v) out.successMessage = v;
        else drop(key);
        break;
      }
      case 'label':
      case 'placeholder':
      case 'loadingLabel': {
        const v = cleanString(value, FORM_LIMITS.maxLabelChars);
        if (v) out[key] = v;
        else drop(key);
        break;
      }
      case 'name': {
        const v = normalizeFieldKey(value);
        if (v) out.name = v;
        else drop(key);
        break;
      }
      case 'required':
        if (typeof value === 'boolean') out.required = value;
        else drop(key);
        break;
      case 'minLength':
      case 'maxLength': {
        const v = ceiling > 0 && fieldType !== 'select' ? cleanLength(value, ceiling) : undefined;
        if (v !== undefined) out[key] = v;
        else drop(key);
        break;
      }
      case 'options': {
        const v = fieldType === 'select' ? readOptions(value) : [];
        if (v.length > 0) out.options = v;
        else drop(key);
        break;
      }
      default: {
        // inputBackground / inputBorderColor / inputTextColor / inputRadius
        const appearance = readFieldAppearance({ [key]: value });
        const v = Object.values(appearance).find((x) => x !== undefined);
        if (v) out[key] = v;
        else drop(key);
      }
    }
  }
  if (typeof out.minLength === 'number' && typeof out.maxLength === 'number' && out.minLength > out.maxLength) {
    warn('form prop "minLength" was larger than "maxLength", dropped');
    delete out.minLength;
  }
  return out;
}

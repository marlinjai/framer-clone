// src/lib/forms/validation.ts
//
// The validation rules of a form field, ONE implementation for the published
// island (on blur and on submit) and the submit endpoint (the authority): a
// value the island accepts is a value the server accepts, and the server
// refuses with the same message the island would have shown.
//
// Rules per type (src/lib/forms/definition.ts holds the limits):
//   - every text value is trimmed and stripped of control characters (a
//     textarea keeps its line breaks and tabs);
//   - required: an empty value (or an unticked box) is an error;
//   - minLength / maxLength in characters (code points, so an emoji is one);
//   - email: one @, no spaces, a dot in the domain, at most 254 characters;
//   - tel: digits with + ( ) - . / and spaces, at least 5 digits;
//   - select: the value must be one of the options;
//   - checkbox / consent: a boolean; required means ticked.
//
// Messages exist in English and German; the island picks the page's `lang`,
// the server the visitor's Accept-Language.
//
// Client-safe: no server imports.

import { isCheckboxType, type FieldSpec } from './definition';

export type FieldErrorCode = 'required' | 'consent' | 'email' | 'tel' | 'too_short' | 'too_long' | 'option' | 'type';

export interface FieldError {
  code: FieldErrorCode;
  message: string;
}

export type FormLocale = 'en' | 'de';

export type FieldValue = string | boolean;

/** 'de' for a German language tag ("de", "de-AT"), else 'en'. */
export function localeOf(tag: string | null | undefined): FormLocale {
  return typeof tag === 'string' && /^de\b/i.test(tag.trim()) ? 'de' : 'en';
}

/** The first language of an Accept-Language header. */
export function localeFromAcceptLanguage(header: string | null | undefined): FormLocale {
  const first = (header ?? '').split(',')[0]?.split(';')[0];
  return localeOf(first);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@.]{2,}$/;
const TEL_CHARS = /^\+?[0-9 ()\-./]+$/;

/** Characters as a person counts them (code points). */
export function charCount(value: string): number {
  return Array.from(value).length;
}

/** Trim and strip control characters; a textarea keeps \n and \t (\r\n becomes \n). */
export function cleanText(value: string, multiline: boolean): string {
  const unified = value.replace(/\r\n?/g, '\n');
  // eslint-disable-next-line no-control-regex
  const stripped = multiline ? unified.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '') : unified.replace(/[\u0000-\u001f\u007f]+/g, ' ');
  return stripped.trim();
}

/** A submitted checkbox value as a boolean: browsers send "on", the island sends true. */
export function checkboxValue(raw: unknown): boolean {
  if (raw === true) return true;
  if (typeof raw !== 'string') return false;
  return ['on', 'true', 'yes', '1'].includes(raw.trim().toLowerCase());
}

/** The value as it is validated and stored. */
export function normalizeValue(field: FieldSpec, raw: unknown): FieldValue {
  if (isCheckboxType(field.type)) return checkboxValue(raw);
  if (typeof raw !== 'string') return '';
  return cleanText(raw, field.type === 'textarea');
}

function message(code: FieldErrorCode, field: FieldSpec, locale: FormLocale): string {
  const de = locale === 'de';
  switch (code) {
    case 'required':
      return field.type === 'select'
        ? de ? 'Bitte wählen Sie eine Option.' : 'Please choose an option.'
        : field.type === 'checkbox'
          ? de ? 'Bitte setzen Sie das Häkchen.' : 'Please tick this box.'
          : de ? 'Bitte füllen Sie dieses Feld aus.' : 'Please fill in this field.';
    case 'consent':
      return de ? 'Bitte stimmen Sie zu, um das Formular zu senden.' : 'Please agree to send the form.';
    case 'email':
      return de ? 'Bitte geben Sie eine gültige E-Mail-Adresse ein, zum Beispiel name@beispiel.de.' : 'Please enter a valid email address, for example name@example.com.';
    case 'tel':
      return de ? 'Bitte geben Sie eine gültige Telefonnummer ein.' : 'Please enter a valid phone number.';
    case 'too_short':
      return de ? `Bitte geben Sie mindestens ${field.minLength} Zeichen ein.` : `Please enter at least ${field.minLength} characters.`;
    case 'too_long':
      return de ? `Bitte geben Sie höchstens ${field.maxLength} Zeichen ein.` : `Please enter at most ${field.maxLength} characters.`;
    case 'option':
      return de ? 'Bitte wählen Sie eine der angebotenen Optionen.' : 'Please choose one of the options offered.';
    case 'type':
      return de ? 'Dieser Wert ist ungültig.' : 'This value is not valid.';
  }
}

function error(code: FieldErrorCode, field: FieldSpec, locale: FormLocale): FieldError {
  return { code, message: message(code, field, locale) };
}

/** The error of one normalized value, or null when it is valid. */
export function validateValue(field: FieldSpec, value: FieldValue, locale: FormLocale = 'en'): FieldError | null {
  if (isCheckboxType(field.type)) {
    if (typeof value !== 'boolean') return error('type', field, locale);
    if (field.required && !value) return error(field.type === 'consent' ? 'consent' : 'required', field, locale);
    return null;
  }
  if (typeof value !== 'string') return error('type', field, locale);
  if (value === '') return field.required ? error('required', field, locale) : null;
  if (field.type === 'select') {
    return field.options.includes(value) ? null : error('option', field, locale);
  }
  const length = charCount(value);
  if (field.maxLength > 0 && length > field.maxLength) return error('too_long', field, locale);
  if (field.minLength !== null && length < field.minLength) return error('too_short', field, locale);
  if (field.type === 'email' && !EMAIL.test(value)) return error('email', field, locale);
  if (field.type === 'tel') {
    const digits = value.replace(/\D/g, '').length;
    if (!TEL_CHARS.test(value) || digits < 5 || digits > 20) return error('tel', field, locale);
  }
  return null;
}

export interface SubmissionCheck {
  ok: boolean;
  /** Every field's normalized value, by key (fields not sent count as empty). */
  values: Record<string, FieldValue>;
  /** The errors, by field key. Empty when ok. */
  errors: Record<string, FieldError>;
}

/**
 * Check a whole submission against the form's fields. Only the form's own
 * fields are read; anything else in `raw` is ignored (never stored).
 */
export function validateSubmission(
  fields: readonly FieldSpec[],
  raw: Record<string, unknown>,
  locale: FormLocale = 'en',
): SubmissionCheck {
  const values: Record<string, FieldValue> = {};
  const errors: Record<string, FieldError> = {};
  for (const field of fields) {
    const value = normalizeValue(field, Object.prototype.hasOwnProperty.call(raw, field.key) ? raw[field.key] : undefined);
    values[field.key] = value;
    const problem = validateValue(field, value, locale);
    if (problem) errors[field.key] = problem;
  }
  return { ok: Object.keys(errors).length === 0, values, errors };
}

/** One stored field: what the owner sees in the submissions view and the CSV. */
export interface StoredField {
  key: string;
  label: string;
  type: FieldSpec['type'];
  value: FieldValue;
}

/** The stored list, in the form's field order. */
export function toStoredFields(fields: readonly FieldSpec[], values: Record<string, FieldValue>): StoredField[] {
  return fields.map((f) => ({ key: f.key, label: f.label, type: f.type, value: values[f.key] ?? (isCheckboxType(f.type) ? false : '') }));
}

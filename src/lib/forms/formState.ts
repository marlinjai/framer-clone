// src/lib/forms/formState.ts
//
// The published form's state machine, pure so its four paths are testable
// without a browser (docs standard: stateful-flow-testing.md):
//
//   1. Forward: fill in, submit, `submitting`, success.
//   2. Backtrack and revise: an error the server or the submit check found is
//      KEYED to the value it was found on. Changing that field re-checks it
//      (the error clears as soon as the value is valid) and leaves every other
//      field's error alone; changing any value after a failed send also drops
//      the form-level error and mints a new submission id, because the next
//      send is a different submission. Re-sending the SAME values keeps the id,
//      so a retry after a lost answer can never store the message twice (the
//      endpoint ignores a repeated id).
//   3. Resume: the island keeps a draft (the values, never the boxes, see
//      `draftValues`) in sessionStorage, keyed to the form id AND the fields
//      signature. A draft for a form whose published fields changed is
//      discarded on load (`restoreDraft`), never poured into other fields.
//   4. Re-entry: after success, "send another" starts clean (empty values, no
//      errors, a fresh id, the draft gone); after a failure the values stay and
//      a new send is allowed, never blocked by the old one.
//
// `submitting` blocks a second send (the island also disables the button).

import { fieldsSignature, isCheckboxType, type FieldSpec } from './definition';
import { normalizeValue, validateValue, type FieldError, type FieldValue, type FormLocale } from './validation';

export type FormStatus = 'idle' | 'submitting' | 'success' | 'error';

export interface FormState {
  values: Record<string, FieldValue>;
  errors: Record<string, FieldError>;
  /** Fields the visitor left at least once (blur validates only those). */
  touched: Record<string, boolean>;
  status: FormStatus;
  /** The form-level error shown above the button (network, server, rate limit). */
  formError: string | null;
  /** Shown after an inline success. */
  successMessage: string | null;
  /** The id of the submission the next send carries (idempotency, see header). */
  submissionId: string;
}

export function emptyValues(fields: readonly FieldSpec[]): Record<string, FieldValue> {
  return Object.fromEntries(fields.map((f) => [f.key, isCheckboxType(f.type) ? false : '']));
}

export function initialFormState(fields: readonly FieldSpec[], newId: () => string, values?: Record<string, FieldValue>): FormState {
  return {
    values: { ...emptyValues(fields), ...(values ?? {}) },
    errors: {},
    touched: {},
    status: 'idle',
    formError: null,
    successMessage: null,
    submissionId: newId(),
  };
}

export type FormAction =
  | { type: 'change'; key: string; value: FieldValue }
  | { type: 'blur'; key: string }
  | { type: 'submit' }
  | { type: 'success'; message: string | null }
  | { type: 'failure'; formError: string; fieldErrors?: Record<string, FieldError> }
  | { type: 'reset' };

export interface FormContextDeps {
  fields: readonly FieldSpec[];
  locale: FormLocale;
  newId: () => string;
}

function check(fields: readonly FieldSpec[], key: string, value: FieldValue, locale: FormLocale): FieldError | null {
  const field = fields.find((f) => f.key === key);
  return field ? validateValue(field, normalizeValue(field, value), locale) : null;
}

/** All errors of the current values (the submit check). */
export function errorsOf(fields: readonly FieldSpec[], values: Record<string, FieldValue>, locale: FormLocale): Record<string, FieldError> {
  const errors: Record<string, FieldError> = {};
  for (const field of fields) {
    const problem = validateValue(field, normalizeValue(field, values[field.key]), locale);
    if (problem) errors[field.key] = problem;
  }
  return errors;
}

export function formReducer(state: FormState, action: FormAction, deps: FormContextDeps): FormState {
  const { fields, locale, newId } = deps;
  switch (action.type) {
    case 'change': {
      if (state.status === 'submitting') return state;
      if (state.values[action.key] === action.value) return state;
      const values = { ...state.values, [action.key]: action.value };
      const errors = { ...state.errors };
      // The error belonged to the old value: re-check this field only.
      if (errors[action.key]) {
        const problem = check(fields, action.key, action.value, locale);
        if (problem) errors[action.key] = problem;
        else delete errors[action.key];
      }
      return {
        ...state,
        values,
        errors,
        status: state.status === 'success' ? 'success' : 'idle',
        formError: null,
        // Different values are a different submission.
        submissionId: newId(),
      };
    }
    case 'blur': {
      const touched = { ...state.touched, [action.key]: true };
      const problem = check(fields, action.key, state.values[action.key], locale);
      const errors = { ...state.errors };
      // Blur reports a problem only once there is something to judge (an empty
      // optional field, or a required one the visitor merely tabbed through,
      // is left for the submit check).
      const value = state.values[action.key];
      const judged = typeof value === 'boolean' || (typeof value === 'string' && value.trim() !== '');
      if (problem && judged) errors[action.key] = problem;
      else if (!problem) delete errors[action.key];
      return { ...state, touched, errors };
    }
    case 'submit': {
      if (state.status === 'submitting') return state;
      const errors = errorsOf(fields, state.values, locale);
      const touched = Object.fromEntries(fields.map((f) => [f.key, true]));
      if (Object.keys(errors).length > 0) return { ...state, errors, touched, status: 'idle', formError: null };
      return { ...state, errors: {}, touched, status: 'submitting', formError: null };
    }
    case 'success':
      return { ...state, status: 'success', errors: {}, formError: null, successMessage: action.message };
    case 'failure':
      return {
        ...state,
        status: 'error',
        formError: action.formError,
        errors: action.fieldErrors ?? {},
        // The same values may be re-sent with the same id (see header).
      };
    case 'reset':
      return initialFormState(fields, newId);
  }
}

// ---------- the draft (resume) ----------

export interface FormDraft {
  v: 1;
  signature: string;
  values: Record<string, string>;
}

export function draftKey(formId: string): string {
  return `framer-form-draft:${formId}`;
}

/**
 * The values a draft keeps: text only. Ticked boxes are never restored (a
 * consent must be given again, knowingly, on the page the visitor sees).
 */
export function draftValues(fields: readonly FieldSpec[], values: Record<string, FieldValue>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = values[f.key];
    if (!isCheckboxType(f.type) && typeof v === 'string' && v !== '') out[f.key] = v;
  }
  return out;
}

export function serializeDraft(fields: readonly FieldSpec[], values: Record<string, FieldValue>): string | null {
  const kept = draftValues(fields, values);
  if (Object.keys(kept).length === 0) return null;
  const draft: FormDraft = { v: 1, signature: fieldsSignature(fields), values: kept };
  return JSON.stringify(draft);
}

/**
 * The values of a stored draft, or null when there is none, it is malformed,
 * or it was kept for a different version of the form (signature mismatch).
 * Only keys of the current fields survive.
 */
export function restoreDraft(fields: readonly FieldSpec[], raw: string | null): Record<string, string> | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const draft = parsed as Partial<FormDraft>;
  if (draft.v !== 1 || draft.signature !== fieldsSignature(fields) || !draft.values || typeof draft.values !== 'object') return null;
  const out: Record<string, string> = {};
  for (const f of fields) {
    const v = (draft.values as Record<string, unknown>)[f.key];
    if (!isCheckboxType(f.type) && typeof v === 'string') out[f.key] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

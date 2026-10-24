// The published form's state machine, through the four paths of the stateful
// flow standard: forward, backtrack and revise, resume, re-entry after success
// or failure.

import { describe, expect, it } from 'vitest';
import { FORM_KIND_ATTR, collectFormFields } from '../definition';
import { draftKey, formReducer, initialFormState, restoreDraft, serializeDraft, type FormAction, type FormState } from '../formState';

const fields = collectFormFields({
  id: 'form-1',
  props: { [FORM_KIND_ATTR]: 'form' },
  children: [
    { id: 'n', props: { [FORM_KIND_ATTR]: 'form-field', fieldType: 'text', name: 'name', required: true } },
    { id: 'e', props: { [FORM_KIND_ATTR]: 'form-field', fieldType: 'email', name: 'email', required: true } },
    { id: 'c', props: { [FORM_KIND_ATTR]: 'form-field', fieldType: 'consent', name: 'consent' } },
  ],
});

let counter = 0;
const deps = { fields, locale: 'en' as const, newId: () => `id-${++counter}` };
const run = (state: FormState, ...actions: FormAction[]) => actions.reduce((s, a) => formReducer(s, a, deps), state);
const fresh = () => initialFormState(fields, deps.newId);
const filled = () =>
  run(
    fresh(),
    { type: 'change', key: 'name', value: 'Ana' },
    { type: 'change', key: 'email', value: 'ana@example.com' },
    { type: 'change', key: 'consent', value: true },
  );

describe('forward', () => {
  it('fill in, submit, sending, success', () => {
    const ready = filled();
    const sending = run(ready, { type: 'submit' });
    expect(sending.status).toBe('submitting');
    expect(sending.errors).toEqual({});
    // A second submit while sending changes nothing (no double send).
    expect(run(sending, { type: 'submit' })).toBe(sending);
    // Typing while sending is ignored too.
    expect(run(sending, { type: 'change', key: 'name', value: 'Bob' })).toBe(sending);
    const done = run(sending, { type: 'success', message: 'Thanks' });
    expect(done.status).toBe('success');
    expect(done.successMessage).toBe('Thanks');
  });

  it('submit with problems stays idle and reports every invalid field', () => {
    const s = run(fresh(), { type: 'change', key: 'email', value: 'nope' }, { type: 'submit' });
    expect(s.status).toBe('idle');
    expect(Object.keys(s.errors).sort()).toEqual(['consent', 'email', 'name']);
  });

  it('blur reports a wrong value but not an untouched empty field', () => {
    let s = run(fresh(), { type: 'blur', key: 'name' });
    expect(s.errors.name).toBeUndefined();
    s = run(s, { type: 'change', key: 'email', value: 'x' }, { type: 'blur', key: 'email' });
    expect(s.errors.email?.code).toBe('email');
  });
});

describe('backtrack and revise', () => {
  it('fixing one field clears only its error; a still-wrong value keeps a fresh error', () => {
    let s = run(fresh(), { type: 'change', key: 'email', value: 'x' }, { type: 'submit' });
    expect(Object.keys(s.errors).sort()).toEqual(['consent', 'email', 'name']);
    s = run(s, { type: 'change', key: 'email', value: 'still wrong' });
    expect(s.errors.email?.code).toBe('email');
    s = run(s, { type: 'change', key: 'email', value: 'ana@example.com' });
    expect(s.errors.email).toBeUndefined();
    expect(Object.keys(s.errors).sort()).toEqual(['consent', 'name']);
  });

  it('after a failed send, changing a value drops the form error and mints a new submission id', () => {
    const failed = run(filled(), { type: 'submit' }, { type: 'failure', formError: 'Network down' });
    expect(failed.status).toBe('error');
    expect(failed.formError).toBe('Network down');
    const revised = run(failed, { type: 'change', key: 'name', value: 'Anna' });
    expect(revised.formError).toBeNull();
    expect(revised.status).toBe('idle');
    expect(revised.submissionId).not.toBe(failed.submissionId);
  });

  it('re-sending the SAME values keeps the id (a retry can never store twice)', () => {
    const failed = run(filled(), { type: 'submit' }, { type: 'failure', formError: 'Timeout' });
    const retry = run(failed, { type: 'submit' });
    expect(retry.status).toBe('submitting');
    expect(retry.submissionId).toBe(failed.submissionId);
    // Setting a field to the value it already has is not a change either.
    expect(run(failed, { type: 'change', key: 'name', value: 'Ana' }).submissionId).toBe(failed.submissionId);
  });

  it('server field errors are shown and cleared field by field like local ones', () => {
    const rejected = run(filled(), { type: 'submit' }, {
      type: 'failure',
      formError: 'Some fields need your attention.',
      fieldErrors: { email: { code: 'type', message: 'Server says no' } },
    });
    expect(rejected.errors.email?.message).toBe('Server says no');
    const fixed = run(rejected, { type: 'change', key: 'email', value: 'other@example.com' });
    expect(fixed.errors.email).toBeUndefined();
  });
});

describe('resume', () => {
  it('a draft keeps the text values, never a ticked box, and restores into empty fields', () => {
    const raw = serializeDraft(fields, filled().values);
    expect(raw).not.toBeNull();
    const restored = restoreDraft(fields, raw);
    expect(restored).toEqual({ name: 'Ana', email: 'ana@example.com' });
    const s = run(fresh(), { type: 'change', key: 'name', value: 'Typed first' }, { type: 'restore', values: restored! });
    // What the visitor typed before the restore wins; the rest is filled in.
    expect(s.values).toMatchObject({ name: 'Typed first', email: 'ana@example.com', consent: false });
  });

  it('a draft for a changed form, a malformed one or a legacy one is discarded', () => {
    const raw = serializeDraft(fields, filled().values)!;
    const changed = collectFormFields({
      id: 'form-1',
      props: { [FORM_KIND_ATTR]: 'form' },
      children: [{ id: 'n', props: { [FORM_KIND_ATTR]: 'form-field', fieldType: 'text', name: 'name', required: false } }],
    });
    expect(restoreDraft(changed, raw)).toBeNull();
    expect(restoreDraft(fields, '{nope')).toBeNull();
    expect(restoreDraft(fields, JSON.stringify({ values: { name: 'x' } }))).toBeNull();
    expect(restoreDraft(fields, null)).toBeNull();
    expect(draftKey('form-1')).toBe('framer-form-draft:form-1');
  });

  it('nothing to keep means no draft', () => {
    expect(serializeDraft(fields, fresh().values)).toBeNull();
  });
});

describe('re-entry after completion or failure', () => {
  it('"send another" after success starts clean with a new id', () => {
    const done = run(filled(), { type: 'submit' }, { type: 'success', message: 'Thanks' });
    const again = run(done, { type: 'reset' });
    expect(again.status).toBe('idle');
    expect(again.values).toEqual({ name: '', email: '', consent: false });
    expect(again.errors).toEqual({});
    expect(again.successMessage).toBeNull();
    expect(again.submissionId).not.toBe(done.submissionId);
    // A draft restore never lands on a sent form either.
    expect(run(done, { type: 'restore', values: { name: 'x' } })).toBe(done);
  });

  it('after a failure the values stay and a new send is allowed', () => {
    const failed = run(filled(), { type: 'submit' }, { type: 'failure', formError: 'Server error' });
    expect(failed.values.name).toBe('Ana');
    const again = run(failed, { type: 'submit' });
    expect(again.status).toBe('submitting');
    expect(again.formError).toBeNull();
  });
});

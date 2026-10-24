/* eslint-disable @typescript-eslint/no-explicit-any */
// src/lib/renderer/forms/FormIsland.tsx
//
// The published form: a client island the server renderer
// (renderComponentNode) emits for a `form` node, plus the two islands it
// emits for the form's fields and its submit button. The form's descendants are
// rendered through renderComponentNode again (the CommerceIsland pattern), so
// any layout the owner built around the fields renders exactly as designed; the
// field and submit islands read the form's state from FormRuntimeContext.
//
// Behaviour (src/lib/forms/formState.ts is the state machine):
//   - validates a field when the visitor leaves it, and every field on submit
//     (the rules are the server's, src/lib/forms/validation.ts); the first
//     invalid field gets focus;
//   - while sending, the submit button is disabled, shows the loading label and
//     a spinner, and a second send is impossible;
//   - success shows the owner's message in place of the fields (focused, so a
//     screen reader reads it) with "Send another", or navigates to the
//     thank-you page the server names;
//   - a failure shows a form-level error above the button and keeps the values;
//   - the text values survive a reload (sessionStorage, keyed to the form and
//     its published fields), ticked boxes never do.
//
// Without JavaScript the same markup is a plain HTML form: method POST to
// /api/forms/submit with the hidden `_form`, `_rendered` and honeypot inputs,
// and the browser's own required / email checks (noValidate is only set once
// the island has hydrated and validates itself).

'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { BindingScope } from '@/lib/bindings/resolver/scope';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import {
  TRANSPORT_FIELDS,
  collectFormFields,
  fieldDomIds,
  readFieldAppearance,
  readFieldSpec,
  readFormSettings,
  stripFormConfigProps,
  type FieldSpec,
} from '@/lib/forms/definition';
import {
  draftKey,
  formReducer,
  initialFormState,
  restoreDraft,
  serializeDraft,
  type FormAction,
  type FormState,
} from '@/lib/forms/formState';
import { localeOf, type FieldValue, type FormLocale } from '@/lib/forms/validation';
import { SUBMIT_PATH, sendForm } from '@/lib/forms/sendForm';
import { FormFieldView } from './FormFieldView';
import { renderComponentNode, nodeDomProps } from '../server/renderComponentNode';

interface FormRuntime {
  formId: string;
  fields: readonly FieldSpec[];
  fieldsByNode: ReadonlyMap<string, FieldSpec>;
  state: FormState;
  dispatch: (action: FormAction) => void;
  hydrated: boolean;
}

const FormRuntimeContext = createContext<FormRuntime | null>(null);

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // RFC 4122 version 4 from Math.random (old browsers only; the server accepts any v4 shape).
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

const SEND_ANOTHER: Record<FormLocale, string> = { en: 'Send another message', de: 'Weitere Nachricht senden' };
const HONEYPOT_LABEL = 'Leave this field empty';
const SPIN_CSS =
  '@keyframes fc-form-spin{to{transform:rotate(360deg)}}' +
  '@media (prefers-reduced-motion: reduce){[data-form-spinner]{animation:none!important}}';

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

export interface FormIslandProps {
  node: ComponentNode;
  scope: BindingScope;
  /** When the server rendered the page (epoch ms), for the no-JavaScript fill-time check. */
  renderedAt: number;
}

export default function FormIsland(props: FormIslandProps) {
  const outer = useContext(FormRuntimeContext);
  // A form inside a form is not a form (nested <form> is invalid HTML): its
  // children render as part of the outer one's layout.
  if (outer) return <NestedFormShell node={props.node} scope={props.scope} />;
  return <LiveForm {...props} />;
}

function NestedFormShell({ node, scope }: { node: ComponentNode; scope: BindingScope }) {
  const domProps = stripFormConfigProps(nodeDomProps(node));
  return React.createElement(
    'div',
    domProps,
    (node.children ?? []).map((child, i) => renderComponentNode(child, scope, child.id ?? i)),
  );
}

function LiveForm({ node, scope, renderedAt }: FormIslandProps) {
  const formId = node.id ?? 'form';
  const settings = useMemo(() => readFormSettings(node.props as Record<string, unknown>), [node.props]);
  const fields = useMemo(() => collectFormFields(node as any), [node]);
  const fieldsByNode = useMemo(() => new Map(fields.map((f) => [f.nodeId, f])), [fields]);
  const [locale, setLocale] = useState<FormLocale>('en');
  const deps = useMemo(() => ({ fields, locale, newId }), [fields, locale]);
  const [state, dispatch] = useReducer(
    (s: FormState, a: FormAction) => formReducer(s, a, deps),
    undefined,
    () => initialFormState(fields, newId),
  );
  const [hydrated, setHydrated] = useState(false);
  const mountedAt = useRef<number>(0);
  const inFlight = useRef(false);
  const honeypotRef = useRef<HTMLInputElement>(null);
  const successRef = useRef<HTMLDivElement>(null);
  const formErrorId = `f-${formId.replace(/[^A-Za-z0-9_-]/g, '')}-form-error`;

  // Mount: the page's language, the fill-time clock, and the draft (resume).
  useEffect(() => {
    mountedAt.current = Date.now();
    setLocale(localeOf(document.documentElement.lang));
    setHydrated(true);
    const restored = restoreDraft(fields, storage()?.getItem(draftKey(formId)) ?? null);
    if (restored) dispatch({ type: 'restore', values: restored });
    // fields and formId identify the form; a different form is a different island.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the draft in step with the values (removed once nothing is left to keep).
  useEffect(() => {
    if (!hydrated) return;
    const store = storage();
    if (!store) return;
    try {
      if (state.status === 'success') {
        store.removeItem(draftKey(formId));
        return;
      }
      const draft = serializeDraft(fields, state.values);
      if (draft) store.setItem(draftKey(formId), draft);
      else store.removeItem(draftKey(formId));
    } catch {
      // Storage full or blocked: the draft is a convenience, never required.
    }
  }, [hydrated, state.values, state.status, fields, formId]);

  useEffect(() => {
    if (state.status === 'success') successRef.current?.focus();
  }, [state.status]);

  const focusFirstInvalid = useCallback(
    (errors: Record<string, unknown>) => {
      const first = fields.find((f) => errors[f.key]);
      if (!first) return;
      const el = document.getElementById(fieldDomIds(formId, first).control);
      el?.focus();
    },
    [fields, formId],
  );

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inFlight.current || state.status === 'submitting') return;
    // The same check the reducer runs, to know the outcome synchronously.
    const next = formReducer(state, { type: 'submit' }, deps);
    dispatch({ type: 'submit' });
    if (next.status !== 'submitting') {
      focusFirstInvalid(next.errors);
      return;
    }
    inFlight.current = true;
    try {
      const outcome = await sendForm({
        formId,
        values: state.values,
        honeypot: honeypotRef.current?.value ?? '',
        elapsedMs: Date.now() - mountedAt.current,
        submissionId: state.submissionId,
        locale,
      });
      if (outcome.kind === 'redirect') {
        try {
          storage()?.removeItem(draftKey(formId));
        } catch {
          // see above
        }
        // Stay in `submitting` (the button keeps its loading state) until the page changes.
        window.location.assign(outcome.to);
        return;
      }
      if (outcome.kind === 'message') {
        dispatch({ type: 'success', message: outcome.message || settings.successMessage });
        return;
      }
      if (outcome.kind === 'invalid') {
        dispatch({ type: 'failure', formError: outcome.formError, fieldErrors: outcome.fieldErrors });
        focusFirstInvalid(outcome.fieldErrors);
        return;
      }
      dispatch({ type: 'failure', formError: outcome.formError });
    } finally {
      inFlight.current = false;
    }
  };

  const runtime: FormRuntime = { formId, fields, fieldsByNode, state, dispatch, hydrated };
  const domProps = stripFormConfigProps(nodeDomProps(node));

  return (
    <FormRuntimeContext.Provider value={runtime}>
      <form
        {...(domProps as any)}
        method="post"
        action={SUBMIT_PATH}
        noValidate={hydrated || undefined}
        onSubmit={onSubmit}
        aria-describedby={state.formError ? formErrorId : undefined}
        aria-busy={state.status === 'submitting' || undefined}
        data-form-id={formId}
      >
        <style>{SPIN_CSS}</style>
        <input type="hidden" name={TRANSPORT_FIELDS.formId} value={formId} />
        <input type="hidden" name={TRANSPORT_FIELDS.renderedAt} value={String(renderedAt)} />
        {/* The honeypot: invisible to people (off-screen, out of the tab order, hidden from assistive technology). */}
        <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px', top: 'auto', width: '1px', height: '1px', overflow: 'hidden' }}>
          <label htmlFor={`${formErrorId}-hp`}>{HONEYPOT_LABEL}</label>
          <input ref={honeypotRef} id={`${formErrorId}-hp`} type="text" name={TRANSPORT_FIELDS.honeypot} tabIndex={-1} autoComplete="off" defaultValue="" />
        </div>
        {state.status === 'success' ? (
          <div ref={successRef} role="status" tabIndex={-1} data-form-success="" style={{ outline: 'none' }}>
            <p style={{ margin: '0 0 12px' }}>{state.successMessage || settings.successMessage}</p>
            <button
              type="button"
              onClick={() => dispatch({ type: 'reset' })}
              style={{ font: 'inherit', background: 'none', border: 'none', padding: 0, textDecoration: 'underline', cursor: 'pointer', color: 'inherit' }}
            >
              {SEND_ANOTHER[locale]}
            </button>
          </div>
        ) : (
          (node.children ?? []).map((child, i) => renderComponentNode(child, scope, child.id ?? i))
        )}
        <p
          id={formErrorId}
          role="alert"
          style={state.formError ? { color: '#b91c1c', margin: '12px 0 0', fontSize: '0.95em' } : { margin: 0 }}
        >
          {state.formError ?? ''}
        </p>
      </form>
    </FormRuntimeContext.Provider>
  );
}

/** A field on the published page: the live control when inside a form, a static one otherwise. */
export function FormFieldIsland({ node }: { node: ComponentNode }) {
  const runtime = useContext(FormRuntimeContext);
  const wrapperProps = stripFormConfigProps(nodeDomProps(node));
  const appearance = readFieldAppearance(node.props as Record<string, unknown>);
  const spec = (node.id && runtime?.fieldsByNode.get(node.id)) || null;
  if (!runtime || !spec) {
    // A field outside a form (or past the field limit) cannot be sent: shown, disabled.
    const orphan = readFieldSpec(node as any, 0);
    return <FormFieldView formId="orphan" field={orphan} appearance={appearance} wrapperProps={wrapperProps} mode="live" disabled />;
  }
  const { state, dispatch } = runtime;
  return (
    <FormFieldView
      formId={runtime.formId}
      field={spec}
      appearance={appearance}
      wrapperProps={wrapperProps}
      mode="live"
      value={state.values[spec.key]}
      error={state.errors[spec.key]?.message ?? null}
      disabled={state.status === 'submitting'}
      onChange={(value: FieldValue) => dispatch({ type: 'change', key: spec.key, value })}
      onBlur={() => dispatch({ type: 'blur', key: spec.key })}
    />
  );
}

/** The submit button: disabled with the loading label and a spinner while sending. */
export function FormSubmitIsland({ node }: { node: ComponentNode }) {
  const runtime = useContext(FormRuntimeContext);
  const domProps = stripFormConfigProps(nodeDomProps(node));
  const label = typeof (node.props as any)?.children === 'string' ? ((node.props as any).children as string) : 'Send';
  const loadingLabel =
    typeof (node.props as any)?.loadingLabel === 'string' && (node.props as any).loadingLabel.trim()
      ? ((node.props as any).loadingLabel as string)
      : 'Sending...';
  const submitting = runtime?.state.status === 'submitting';
  return (
    <button
      {...(domProps as any)}
      type="submit"
      disabled={!runtime || submitting || undefined}
      aria-disabled={submitting || undefined}
      data-loading={submitting ? '' : undefined}
      style={{ ...((domProps as any).style ?? {}), ...(submitting ? { cursor: 'progress', opacity: 0.8 } : {}) }}
    >
      {submitting ? (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
          <span
            data-form-spinner=""
            aria-hidden="true"
            style={{
              width: '1em',
              height: '1em',
              border: '2px solid currentColor',
              borderRightColor: 'transparent',
              borderRadius: '50%',
              display: 'inline-block',
              animation: 'fc-form-spin 0.8s linear infinite',
            }}
          />
          {loadingLabel}
        </span>
      ) : (
        label
      )}
    </button>
  );
}

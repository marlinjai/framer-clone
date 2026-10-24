// src/lib/forms/sendForm.ts
//
// The island's one network call: POST the values as JSON to the published
// site's own /api/forms/submit and turn every answer into one of four
// outcomes the state machine understands. Never throws: a network failure or
// an unreadable answer is a `failure` with a message the visitor can act on.
// Client-safe; `fetchImpl` is injectable for tests.

import type { FieldError, FieldValue, FormLocale } from './validation';

export const SUBMIT_PATH = '/api/forms/submit';

export interface SendFormInput {
  formId: string;
  values: Record<string, FieldValue>;
  honeypot: string;
  elapsedMs: number;
  submissionId: string;
  locale: FormLocale;
}

export type SendFormOutcome =
  | { kind: 'redirect'; to: string }
  | { kind: 'message'; message: string }
  | { kind: 'invalid'; formError: string; fieldErrors: Record<string, FieldError> }
  | { kind: 'failure'; formError: string };

const COPY = {
  en: {
    network: 'Your message could not be sent. Check your connection and try again.',
    failed: 'Your message could not be sent. Please try again in a moment.',
    invalid: 'Some fields need your attention.',
    rateLimited: 'Too many messages were sent in a short time. Please try again in a few minutes.',
    gone: 'This form is no longer available. Please reload the page.',
  },
  de: {
    network: 'Ihre Nachricht konnte nicht gesendet werden. Prüfen Sie Ihre Verbindung und versuchen Sie es erneut.',
    failed: 'Ihre Nachricht konnte nicht gesendet werden. Bitte versuchen Sie es gleich noch einmal.',
    invalid: 'Einige Felder benötigen Ihre Aufmerksamkeit.',
    rateLimited: 'In kurzer Zeit wurden zu viele Nachrichten gesendet. Bitte versuchen Sie es in einigen Minuten erneut.',
    gone: 'Dieses Formular ist nicht mehr verfügbar. Bitte laden Sie die Seite neu.',
  },
} as const;

/** A same-site path only: the island never navigates off the site on the server's word. */
function isSitePath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\');
}

export async function sendForm(input: SendFormInput, fetchImpl: typeof fetch = fetch): Promise<SendFormOutcome> {
  const copy = COPY[input.locale];
  let res: Response;
  try {
    res = await fetchImpl(SUBMIT_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        formId: input.formId,
        values: input.values,
        website: input.honeypot,
        elapsedMs: Math.max(0, Math.round(input.elapsedMs)),
        submissionId: input.submissionId,
        locale: input.locale,
      }),
    });
  } catch {
    return { kind: 'failure', formError: copy.network };
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const b = (body ?? {}) as { ok?: boolean; redirectTo?: unknown; message?: unknown; error?: { code?: string; message?: string; fieldErrors?: Record<string, unknown> } };

  if (res.ok && b.ok === true) {
    if (isSitePath(b.redirectTo)) return { kind: 'redirect', to: b.redirectTo };
    return { kind: 'message', message: typeof b.message === 'string' ? b.message : '' };
  }
  const serverMessage = typeof b.error?.message === 'string' ? b.error.message : null;
  if (res.status === 422 && b.error?.fieldErrors && typeof b.error.fieldErrors === 'object') {
    const fieldErrors: Record<string, FieldError> = {};
    for (const [key, message] of Object.entries(b.error.fieldErrors)) {
      if (typeof message === 'string') fieldErrors[key] = { code: 'type', message };
    }
    return { kind: 'invalid', formError: serverMessage ?? copy.invalid, fieldErrors };
  }
  if (res.status === 429) return { kind: 'failure', formError: serverMessage ?? copy.rateLimited };
  if (res.status === 404 || res.status === 403) return { kind: 'failure', formError: copy.gone };
  return { kind: 'failure', formError: res.status >= 500 ? copy.failed : serverMessage ?? copy.failed };
}

import 'server-only';

// src/server/forms/submit.ts
//
// POST /api/forms/submit, the one write a visitor makes through a form on a
// published site (published site essentials, decision 4). The route module
// (src/app/api/forms/submit/route.ts) only wires the real dependencies; the
// whole flow lives here so it is testable with fakes.
//
// The tenant AND the gate are the request HOST, exactly like the storefront
// order write (src/app/api/commerce/orders/route.ts): it must resolve to a
// PUBLISHED site (403 otherwise) with a provisioned commerce schema (404
// otherwise). A session cookie is never read.
//
// The form is never described by the request. The body names only the form's
// component id (the island cannot name the page: the published tree carries no
// page id); the server searches the site's PUBLISHED pages for that form and collects its fields with the same code the island
// rendered them with (src/lib/forms/definition.ts), then validates every value
// with the same rules (src/lib/forms/validation.ts). A field the published form
// does not have is ignored, never stored.
//
// Spam protection, no third-party service, in this order:
//   1. a body of at most 64 KiB (413), read as a stream;
//   2. per-IP flood limit on every POST (429);
//   3. the honeypot: a hidden `_website` input people never see; a filled one
//      answers like a success and stores nothing;
//   4. the minimum fill time: a form sent less than MIN_FILL_MS after the page
//      rendered (the island sends the elapsed time, a plain HTML post carries
//      the server's render time) answers like a success and stores nothing; a
//      post carrying no timing at all is treated the same way. Both values come
//      from the browser, so this is the weak leg: it stops scripted posts that
//      do not load the page, not a determined bot;
//   5. per-IP and per-form limits on accepted submissions (429).
//
// Two ways in:
//   - JSON (the island, `Accept: application/json`): answers JSON, the island
//     shows errors inline and navigates to `redirectTo` itself.
//   - A plain HTML form post (`application/x-www-form-urlencoded`, a browser
//     without JavaScript): a success with a thank-you page answers 303 to that
//     page; an inline success, a validation error or a refusal answers a small
//     self-contained HTML page with the message and a link back (the browser's
//     back button keeps what was typed). Decided so the page route stays
//     untouched: rendering errors into the page itself would need the request's
//     query threaded through the published renderer.
//
// Storage: one row in the company's `form_submission` table, no IP address
// (src/server/commerce/migrations/tenant/017_form_submissions.ts). No email is
// sent: the app has no mail transport yet (no Lumitra Mail client, Resend or
// SMTP module exists in this repository), so the owner reads submissions in the
// editor's "Form submissions" view.

import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import type { CommerceDB } from '@/server/commerce/db-types';
import type { PublishedSite } from '@/server/sites/publicResolver';
import { boundedText } from '@/server/books/http/boundedBody';
import { jsonError } from '@/lib/api/respond';
import { snapshotToComponentNode } from '@/lib/renderer/server/snapshotToComponentNode';
import {
  FORM_LIMITS,
  TRANSPORT_FIELDS,
  collectFormFields,
  findFormNode,
  readFormSettings,
  type FormTreeNode,
} from '@/lib/forms/definition';
import { displayPathOfSlug, linkPathOfSlug } from '@/lib/forms/paths';
import {
  localeFromAcceptLanguage,
  localeOf,
  toStoredFields,
  validateSubmission,
  type FormLocale,
} from '@/lib/forms/validation';
import type { NewFormSubmission } from './repository';
import { clientIpOf, type FormRateLimiter } from './rateLimit';

/** Faster than this after the page rendered is not a person filling in a form. */
export const MIN_FILL_MS = 3_000;

export type ResolvedSite =
  | { ok: true; site: PublishedSite; tenantGroupId: string; db: Kysely<CommerceDB> }
  | { ok: false; response: Response };

export interface SubmitDeps {
  resolveSite(host: string | null): Promise<ResolvedSite>;
  store(db: Kysely<CommerceDB>, row: NewFormSubmission): Promise<boolean>;
  limiter: FormRateLimiter;
  now(): number;
  newId(): string;
  log(level: 'info' | 'warn' | 'error', message: string, err?: unknown): void;
}

const jsonBodySchema = z
  .object({
    formId: z.string().min(1).max(200),
    values: z.record(z.string().max(200), z.union([z.string().max(20_000), z.boolean()])),
    website: z.string().max(2000).optional(),
    elapsedMs: z.number().finite().nonnegative().optional(),
    submissionId: z.string().uuid().optional(),
    locale: z.string().max(35).optional(),
  })
  .strict();

interface ParsedSubmission {
  formId: string;
  values: Record<string, unknown>;
  honeypot: string;
  /** Milliseconds between render and send, or null when the request carried no timing. */
  elapsedMs: number | null;
  submissionId: string | null;
  locale: FormLocale;
}

type Mode = 'json' | 'html';

function modeOf(req: Request): Mode | null {
  const type = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (type === 'application/json') return 'json';
  if (type === 'application/x-www-form-urlencoded') return 'html';
  return null;
}

function parseJson(text: string, acceptLanguage: string | null): ParsedSubmission | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = jsonBodySchema.safeParse(raw);
  if (!parsed.success) return null;
  const b = parsed.data;
  if (Object.keys(b.values).length > FORM_LIMITS.maxFields * 2) return null;
  return {
    formId: b.formId,
    values: b.values,
    honeypot: b.website ?? '',
    elapsedMs: b.elapsedMs ?? null,
    submissionId: b.submissionId ?? null,
    locale: b.locale ? localeOf(b.locale) : localeFromAcceptLanguage(acceptLanguage),
  };
}

function parseUrlEncoded(text: string, now: number, acceptLanguage: string | null): ParsedSubmission | null {
  const params = new URLSearchParams(text);
  const formId = params.get(TRANSPORT_FIELDS.formId)?.trim() ?? '';
  if (!formId || formId.length > 200) return null;
  const values: Record<string, unknown> = {};
  let count = 0;
  for (const [key, value] of params) {
    if (key.startsWith('_')) continue;
    if (Object.prototype.hasOwnProperty.call(values, key)) continue; // first value wins
    if (++count > FORM_LIMITS.maxFields * 2) return null;
    values[key] = value;
  }
  const rendered = Number(params.get(TRANSPORT_FIELDS.renderedAt));
  const elapsedMs = Number.isFinite(rendered) && rendered > 0 ? now - rendered : null;
  return {
    formId,
    values,
    honeypot: params.get(TRANSPORT_FIELDS.honeypot) ?? '',
    elapsedMs,
    submissionId: null,
    locale: localeFromAcceptLanguage(acceptLanguage),
  };
}

interface LocatedForm {
  pageId: string;
  pageSlug: string;
  form: FormTreeNode;
}

/** The form in the published site, on whichever page holds it (component ids are unique; first match). */
export function locateForm(site: Pick<PublishedSite, 'pages'>, formId: string): LocatedForm | null {
  for (const page of site.pages) {
    const root = snapshotToComponentNode(page.snapshot).root;
    const form = findFormNode<FormTreeNode>(root as FormTreeNode | null, formId);
    if (form) return { pageId: page.pageId, pageSlug: page.slug, form };
  }
  return null;
}

// ---------- the no-JavaScript answers ----------

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const HTML_COPY = {
  en: { errorTitle: 'Please check the form', back: 'Back to the form', sentTitle: 'Sent', home: 'Back to the page' },
  de: { errorTitle: 'Bitte prüfen Sie das Formular', back: 'Zurück zum Formular', sentTitle: 'Gesendet', home: 'Zurück zur Seite' },
} as const;

/** A small self-contained page (charset first, no external resources). */
export function htmlAnswer(input: {
  status: number;
  locale: FormLocale;
  title: string;
  message: string;
  items?: string[];
  backHref: string;
  backLabel: string;
  headers?: Record<string, string>;
}): Response {
  const items = input.items && input.items.length > 0
    ? `<ul>${input.items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`
    : '';
  const body = `<!doctype html>
<html lang="${input.locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(input.title)}</title>
<style>
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#fafafa;color:#111827;line-height:1.5}
main{max-width:560px;margin:10vh auto;padding:0 16px}
h1{font-size:24px;margin:0 0 12px}
ul{padding-left:20px}
a{color:inherit;font-weight:600}
</style>
</head>
<body>
<main>
<h1>${escapeHtml(input.title)}</h1>
<p role="${input.status >= 400 ? 'alert' : 'status'}">${escapeHtml(input.message)}</p>
${items}
<p><a href="${escapeHtml(input.backHref)}">${escapeHtml(input.backLabel)}</a></p>
</main>
</body>
</html>`;
  return new Response(body, {
    status: input.status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...(input.headers ?? {}) },
  });
}

const MESSAGES = {
  en: {
    tooLarge: 'The form is too large to send.',
    badBody: 'The form could not be read. Please reload the page and try again.',
    notFound: 'This form is no longer available. Please reload the page.',
    rateLimited: 'Too many messages were sent in a short time. Please try again in a few minutes.',
    invalid: 'Some fields need your attention.',
    failed: 'Your message could not be sent. Please try again in a moment.',
  },
  de: {
    tooLarge: 'Das Formular ist zu groß zum Senden.',
    badBody: 'Das Formular konnte nicht gelesen werden. Bitte laden Sie die Seite neu und versuchen Sie es erneut.',
    notFound: 'Dieses Formular ist nicht mehr verfügbar. Bitte laden Sie die Seite neu.',
    rateLimited: 'In kurzer Zeit wurden zu viele Nachrichten gesendet. Bitte versuchen Sie es in einigen Minuten erneut.',
    invalid: 'Einige Felder benötigen Ihre Aufmerksamkeit.',
    failed: 'Ihre Nachricht konnte nicht gesendet werden. Bitte versuchen Sie es gleich noch einmal.',
  },
} as const;

/** Same-site path the visitor came from, for the "back" link of the HTML answer. */
function backHrefOf(req: Request, fallback: string): string {
  const referer = req.headers.get('referer');
  const host = req.headers.get('host');
  if (referer && host) {
    try {
      const url = new URL(referer);
      if (url.host === host) return `${url.pathname}${url.search}`;
    } catch {
      // fall through
    }
  }
  return fallback;
}

// ---------- the handler ----------

export async function handleFormSubmit(req: Request, deps: SubmitDeps): Promise<Response> {
  const now = deps.now();
  const acceptLanguage = req.headers.get('accept-language');
  const mode = modeOf(req);
  const early = localeFromAcceptLanguage(acceptLanguage);

  const refuse = (status: number, code: string, locale: FormLocale, message: string, backHref = '/', extra?: Record<string, unknown>, headers?: Record<string, string>) => {
    if (mode === 'html') {
      return htmlAnswer({ status, locale, title: HTML_COPY[locale].errorTitle, message, backHref, backLabel: HTML_COPY[locale].back, headers });
    }
    const response = jsonError(code, message, status, extra);
    for (const [k, v] of Object.entries(headers ?? {})) response.headers.set(k, v);
    response.headers.set('cache-control', 'no-store');
    return response;
  };

  if (!mode) {
    return jsonError('unsupported_media_type', 'send the form as JSON or as a form post', 415);
  }

  // 2. Flood limit before any work that costs a database round trip.
  const ip = clientIpOf(req.headers);
  const flood = deps.limiter.flood(ip, now);
  if (!flood.ok) {
    return refuse(429, 'rate_limited', early, MESSAGES[early].rateLimited, backHrefOf(req, '/'), { retryAfterSec: flood.retryAfterSec }, { 'retry-after': String(flood.retryAfterSec) });
  }

  // 1. Bounded body.
  const text = await boundedText(req, FORM_LIMITS.maxBodyBytes);
  if (text === null) return refuse(413, 'too_large', early, MESSAGES[early].tooLarge, backHrefOf(req, '/'));
  const parsed = mode === 'json' ? parseJson(text, acceptLanguage) : parseUrlEncoded(text, now, acceptLanguage);
  if (!parsed) return refuse(400, 'bad_body', early, MESSAGES[early].badBody, backHrefOf(req, '/'));
  const locale = parsed.locale;
  const copy = MESSAGES[locale];

  // The site, from the host only.
  let resolved: ResolvedSite;
  try {
    resolved = await deps.resolveSite(req.headers.get('host'));
  } catch (err) {
    deps.log('error', '[forms] resolving the site for a submission failed', err);
    return refuse(500, 'submit_failed', locale, copy.failed, backHrefOf(req, '/'));
  }
  if (!resolved.ok) {
    if (mode === 'json') return resolved.response;
    return refuse(resolved.response.status, 'forbidden', locale, copy.notFound, backHrefOf(req, '/'));
  }
  const { site, tenantGroupId, db } = resolved;

  const located = locateForm(site, parsed.formId);
  if (!located) return refuse(404, 'form_not_found', locale, copy.notFound, backHrefOf(req, '/'));
  const pagePath = linkPathOfSlug(located.pageSlug) ?? '/';
  const back = backHrefOf(req, pagePath);
  const settings = readFormSettings(located.form.props);
  const fields = collectFormFields(located.form);

  const successTarget = (): string | null =>
    settings.successBehavior === 'redirect' && settings.redirectPageId
      ? (() => {
          const page = site.pages.find((p) => p.pageId === settings.redirectPageId);
          return page ? linkPathOfSlug(page.slug) : null;
        })()
      : null;

  const success = (submissionId: string) => {
    const redirectTo = successTarget();
    if (mode === 'json') {
      return Response.json(
        redirectTo ? { ok: true, submissionId, redirectTo } : { ok: true, submissionId, message: settings.successMessage },
        { headers: { 'cache-control': 'no-store' } },
      );
    }
    if (redirectTo) return new Response(null, { status: 303, headers: { location: redirectTo, 'cache-control': 'no-store' } });
    return htmlAnswer({ status: 200, locale, title: HTML_COPY[locale].sentTitle, message: settings.successMessage, backHref: back, backLabel: HTML_COPY[locale].home });
  };

  // 3 + 4. Honeypot and fill time: answer like a success, store nothing.
  const tooFast = parsed.elapsedMs === null || parsed.elapsedMs < MIN_FILL_MS;
  if (parsed.honeypot.trim() !== '' || tooFast) {
    deps.log('warn', `[forms] site ${site.siteId} form ${located.form.id ?? parsed.formId}: dropped a submission as spam (${parsed.honeypot.trim() !== '' ? 'honeypot' : 'fill time'})`);
    return success(parsed.submissionId ?? deps.newId());
  }

  // Validation with the island's rules.
  const check = validateSubmission(fields, parsed.values, locale);
  if (!check.ok) {
    const fieldErrors = Object.fromEntries(Object.entries(check.errors).map(([k, e]) => [k, e.message]));
    if (mode === 'html') {
      const items = fields.filter((f) => check.errors[f.key]).map((f) => `${f.label}: ${check.errors[f.key].message}`);
      return htmlAnswer({ status: 422, locale, title: HTML_COPY[locale].errorTitle, message: copy.invalid, items, backHref: back, backLabel: HTML_COPY[locale].back });
    }
    return refuse(422, 'invalid_fields', locale, copy.invalid, back, { fieldErrors });
  }

  // 5. Accepted-submission limits.
  const formKey = `${site.siteId}:${located.form.id ?? parsed.formId}`;
  const accepted = deps.limiter.accept(ip, formKey, now);
  if (!accepted.ok) {
    return refuse(429, 'rate_limited', locale, copy.rateLimited, back, { retryAfterSec: accepted.retryAfterSec }, { 'retry-after': String(accepted.retryAfterSec) });
  }

  const submissionId = parsed.submissionId ?? deps.newId();
  try {
    const stored = await deps.store(db, {
      id: submissionId,
      tenantId: tenantGroupId,
      workspaceId: site.workspaceId,
      siteId: site.siteId,
      pageId: located.pageId,
      pagePath: displayPathOfSlug(located.pageSlug),
      formId: located.form.id ?? parsed.formId,
      formName: settings.name,
      fields: toStoredFields(fields, check.values),
    });
    if (!stored) deps.log('info', `[forms] site ${site.siteId}: submission ${submissionId} was sent again, kept the first`);
  } catch (err) {
    deps.log('error', `[forms] site ${site.siteId}: storing a submission failed`, err);
    return refuse(500, 'submit_failed', locale, copy.failed, back);
  }
  return success(submissionId);
}

/** The default id factory (a UUID, also the idempotency key the island sends). */
export function newSubmissionId(): string {
  return randomUUID();
}

// POST /api/forms/submit through handleFormSubmit with fakes for the site
// resolution and the storage: the host gate, validation against the PUBLISHED
// form, the honeypot, the fill time, the rate limits, the size limit, storage
// (idempotent on the id, no IP stored), storage failure, and both ways in
// (JSON from the island, a plain HTML form post without JavaScript).

import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';

import { FORM_KIND_ATTR } from '@/lib/forms/definition';
import type { CommerceDB } from '@/server/commerce/db-types';
import type { PublishedSite } from '@/server/sites/publicResolver';
import { MIN_FILL_MS, handleFormSubmit, locateForm, type SubmitDeps } from '../submit';
import { createFormRateLimiter, clientIpOf } from '../rateLimit';
import type { NewFormSubmission } from '../repository';

const TG = '018f9c10-0000-7000-8000-0000000000f1';
const NOW = 1_800_000_000_000;

function formSnapshot(props: Record<string, unknown> = {}) {
  return {
    id: 'form-1',
    type: 'div',
    props: { [FORM_KIND_ATTR]: 'form', formName: 'Booking', successMessage: 'Thanks, see you soon.', ...props },
    children: [
      { id: 'f-name', type: 'div', props: { [FORM_KIND_ATTR]: 'form-field', fieldType: 'text', name: 'name', label: 'Name', required: true } },
      { id: 'f-email', type: 'div', props: { [FORM_KIND_ATTR]: 'form-field', fieldType: 'email', name: 'email', label: 'Email', required: true } },
      { id: 'f-consent', type: 'div', props: { [FORM_KIND_ATTR]: 'form-field', fieldType: 'consent', name: 'consent', label: 'I agree' } },
      { id: 'submit', type: 'button', props: { [FORM_KIND_ATTR]: 'form-submit', children: 'Send' } },
    ],
  };
}

function site(formProps: Record<string, unknown> = {}): PublishedSite {
  const page = (pageId: string, slug: string, children: unknown[]) => ({
    pageId,
    slug,
    snapshot: { id: pageId, slug, metadata: {}, canvasNodes: {}, appComponentTree: { id: `root-${pageId}`, type: 'div', props: {}, children } } as never,
  });
  return {
    siteId: 'site-1',
    workspaceId: 'ws-1',
    tenantGroupId: TG,
    name: 'Bakery',
    analyticsProjectId: null,
    ingestionEndpoint: null,
    apiKeyRef: null,
    lumitraEnabled: false,
    pages: [page('p-home', '', []), page('p-contact', 'kontakt', [formSnapshot(formProps)]), page('p-thanks', 'danke', [])],
    redirects: [],
  } as unknown as PublishedSite;
}

interface Harness {
  deps: SubmitDeps;
  stored: NewFormSubmission[];
  logs: string[];
}

function harness(over: Partial<SubmitDeps> & { site?: PublishedSite } = {}): Harness {
  const stored: NewFormSubmission[] = [];
  const logs: string[] = [];
  const deps: SubmitDeps = {
    resolveSite: async () => ({ ok: true, site: over.site ?? site(), tenantGroupId: TG, db: {} as Kysely<CommerceDB> }),
    store: async (_db, row) => {
      if (stored.some((r) => r.id === row.id)) return false;
      stored.push(row);
      return true;
    },
    limiter: createFormRateLimiter(),
    now: () => NOW,
    newId: () => randomUUID(),
    log: (_level, message) => logs.push(message),
    ...over,
  };
  return { deps, stored, logs };
}

const VALID = { name: 'Ana', email: 'ana@example.com', consent: true };

function jsonPost(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new Request('https://bakery.sites.example/api/forms/submit', {
    method: 'POST',
    headers: { host: 'bakery.sites.example', 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7', ...headers },
    body: JSON.stringify(body),
  });
}

function htmlPost(fields: Record<string, string>, headers: Record<string, string> = {}) {
  return new Request('https://bakery.sites.example/api/forms/submit', {
    method: 'POST',
    headers: {
      host: 'bakery.sites.example',
      'content-type': 'application/x-www-form-urlencoded',
      'x-forwarded-for': '203.0.113.8',
      referer: 'https://bakery.sites.example/kontakt',
      ...headers,
    },
    body: new URLSearchParams(fields).toString(),
  });
}

const body = (extra: Record<string, unknown> = {}) => ({ formId: 'form-1', values: VALID, elapsedMs: 8000, submissionId: randomUUID(), ...extra });

describe('JSON (the island)', () => {
  it('stores a valid submission with the published fields, no IP, and answers the inline message', async () => {
    const h = harness();
    const res = await handleFormSubmit(jsonPost(body({ values: { ...VALID, injected: 'nope' } })), h.deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, message: 'Thanks, see you soon.' });
    expect(h.stored).toHaveLength(1);
    const row = h.stored[0];
    expect(row).toMatchObject({ tenantId: TG, workspaceId: 'ws-1', siteId: 'site-1', pageId: 'p-contact', pagePath: '/kontakt', formId: 'form-1', formName: 'Booking' });
    expect(row.fields).toEqual([
      { key: 'name', label: 'Name', type: 'text', value: 'Ana' },
      { key: 'email', label: 'Email', type: 'email', value: 'ana@example.com' },
      { key: 'consent', label: 'I agree', type: 'consent', value: true },
    ]);
    expect(JSON.stringify(row)).not.toContain('203.0.113.7');
    expect(JSON.stringify(row)).not.toContain('injected');
  });

  it('answers the thank-you page path for a redirect form', async () => {
    const h = harness({ site: site({ successBehavior: 'redirect', redirectPageId: 'p-thanks' }) });
    const res = await handleFormSubmit(jsonPost(body()), h.deps);
    expect(await res.json()).toMatchObject({ ok: true, redirectTo: '/danke' });
  });

  it('a redirect to a page that is gone falls back to the message', async () => {
    const h = harness({ site: site({ successBehavior: 'redirect', redirectPageId: 'p-deleted' }) });
    const res = await handleFormSubmit(jsonPost(body()), h.deps);
    expect(await res.json()).toMatchObject({ ok: true, message: 'Thanks, see you soon.' });
  });

  it('refuses invalid values with the same rules and messages as the island (422), storing nothing', async () => {
    const h = harness();
    const res = await handleFormSubmit(jsonPost(body({ values: { name: '', email: 'x', consent: false } }), { 'accept-language': 'de' }), h.deps);
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error.code).toBe('invalid_fields');
    expect(Object.keys(json.error.fieldErrors).sort()).toEqual(['consent', 'email', 'name']);
    expect(h.stored).toHaveLength(0);
  });

  it('a filled honeypot and a too-fast or untimed send look like success but store nothing', async () => {
    for (const extra of [{ website: 'http://spam.example' }, { elapsedMs: MIN_FILL_MS - 1 }, { elapsedMs: undefined }]) {
      const h = harness();
      const res = await handleFormSubmit(jsonPost(body(extra)), h.deps);
      expect(res.status).toBe(200);
      expect((await res.json()).ok).toBe(true);
      expect(h.stored).toHaveLength(0);
      expect(h.logs.join('\n')).toMatch(/spam/);
    }
  });

  it('the same submission id sent twice is stored once and both answers succeed', async () => {
    const h = harness();
    const b = body();
    expect((await handleFormSubmit(jsonPost(b), h.deps)).status).toBe(200);
    expect((await handleFormSubmit(jsonPost(b), h.deps)).status).toBe(200);
    expect(h.stored).toHaveLength(1);
  });

  it('rate limits accepted submissions per IP (429 with Retry-After), other visitors go through', async () => {
    const h = harness({ limiter: createFormRateLimiter({ flood: { max: 100, windowMs: 60_000 }, ip: { max: 2, windowMs: 600_000 }, form: { max: 100, windowMs: 3_600_000 } }) });
    expect((await handleFormSubmit(jsonPost(body()), h.deps)).status).toBe(200);
    expect((await handleFormSubmit(jsonPost(body()), h.deps)).status).toBe(200);
    const limited = await handleFormSubmit(jsonPost(body()), h.deps);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await limited.json()).error.code).toBe('rate_limited');
    expect((await handleFormSubmit(jsonPost(body(), { 'x-forwarded-for': '198.51.100.1' }), h.deps)).status).toBe(200);
    expect(h.stored).toHaveLength(3);
  });

  it('rate limits one form across visitors, and floods before touching the database', async () => {
    const perForm = harness({ limiter: createFormRateLimiter({ flood: { max: 100, windowMs: 60_000 }, ip: { max: 100, windowMs: 600_000 }, form: { max: 1, windowMs: 3_600_000 } }) });
    expect((await handleFormSubmit(jsonPost(body()), perForm.deps)).status).toBe(200);
    expect((await handleFormSubmit(jsonPost(body(), { 'x-forwarded-for': '198.51.100.2' }), perForm.deps)).status).toBe(429);

    const resolveSite = vi.fn(harness().deps.resolveSite);
    const flood = harness({ resolveSite, limiter: createFormRateLimiter({ flood: { max: 1, windowMs: 60_000 }, ip: { max: 100, windowMs: 600_000 }, form: { max: 100, windowMs: 3_600_000 } }) });
    expect((await handleFormSubmit(jsonPost(body()), flood.deps)).status).toBe(200);
    expect((await handleFormSubmit(jsonPost(body()), flood.deps)).status).toBe(429);
    expect(resolveSite).toHaveBeenCalledTimes(1);
  });

  it('refuses a body over 64 KiB (413), a malformed body (400) and another media type (415)', async () => {
    const h = harness();
    const big = await handleFormSubmit(jsonPost(body({ values: { name: 'x'.repeat(20_000), email: 'y'.repeat(20_000), consent: 'z'.repeat(20_000), more: 'w'.repeat(10_000) } })), h.deps);
    expect(big.status).toBe(413);
    const bad = await handleFormSubmit(jsonPost({ formId: 'form-1', values: VALID, price: 1 }), h.deps);
    expect(bad.status).toBe(400);
    const other = await handleFormSubmit(
      new Request('https://bakery.sites.example/api/forms/submit', { method: 'POST', headers: { host: 'x', 'content-type': 'text/plain' }, body: 'hi' }),
      h.deps,
    );
    expect(other.status).toBe(415);
    expect(h.stored).toHaveLength(0);
  });

  it('an unknown form answers 404 and a host that is no published site keeps its 403', async () => {
    const h = harness();
    expect((await handleFormSubmit(jsonPost(body({ formId: 'nope' })), h.deps)).status).toBe(404);
    const blocked = harness({ resolveSite: async () => ({ ok: false, response: Response.json({ error: { code: 'forbidden' } }, { status: 403 }) }) });
    expect((await handleFormSubmit(jsonPost(body()), blocked.deps)).status).toBe(403);
  });

  it('a storage failure is a loud 500 with a generic message, logged', async () => {
    const h = harness({
      store: async () => {
        throw new Error('connection refused');
      },
    });
    const res = await handleFormSubmit(jsonPost(body()), h.deps);
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error.code).toBe('submit_failed');
    expect(json.error.message).not.toMatch(/connection refused/);
    expect(h.logs.join('\n')).toMatch(/storing a submission failed/);
  });
});

describe('a plain HTML form post (no JavaScript)', () => {
  const fields = (extra: Record<string, string> = {}) => ({
    _form: 'form-1',
    _rendered: String(NOW - 10_000),
    _website: '',
    name: 'Ana',
    email: 'ana@example.com',
    consent: 'on',
    ...extra,
  });

  it('stores and redirects (303) to the thank-you page', async () => {
    const h = harness({ site: site({ successBehavior: 'redirect', redirectPageId: 'p-thanks' }) });
    const res = await handleFormSubmit(htmlPost(fields()), h.deps);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/danke');
    expect(h.stored).toHaveLength(1);
  });

  it('an inline success answers a small page with the message and a link back', async () => {
    const h = harness();
    const res = await handleFormSubmit(htmlPost(fields()), h.deps);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const html = await res.text();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('Thanks, see you soon.');
    expect(html).toContain('href="/kontakt"');
  });

  it('errors answer a page listing each field problem (422), escaped, storing nothing', async () => {
    const h = harness();
    const res = await handleFormSubmit(htmlPost(fields({ email: '<script>', consent: '' })), h.deps);
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain('Email:');
    expect(html).toContain('I agree:');
    expect(html).not.toContain('<script>');
    expect(h.stored).toHaveLength(0);
  });

  it('a post without the render time counts as too fast', async () => {
    const h = harness();
    const { _rendered: _omit, ...rest } = fields();
    void _omit;
    const res = await handleFormSubmit(htmlPost(rest), h.deps);
    expect(res.status).toBe(200);
    expect(h.stored).toHaveLength(0);
  });
});

describe('helpers', () => {
  it('locateForm finds the form on whichever page holds it', () => {
    expect(locateForm(site(), 'form-1')?.pageId).toBe('p-contact');
    expect(locateForm(site(), 'missing')).toBeNull();
  });

  it('clientIpOf takes the proxy headers in order', () => {
    expect(clientIpOf(new Headers({ 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2' }))).toBe('1.1.1.1');
    expect(clientIpOf(new Headers({ 'x-forwarded-for': '2.2.2.2, 10.0.0.1' }))).toBe('2.2.2.2');
    expect(clientIpOf(new Headers())).toBe('unknown');
  });
});

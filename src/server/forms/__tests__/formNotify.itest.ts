// The owner's email about a form submission (docs/plans/2026-10-23-published-site-essentials.md, "Form notification
// emails"; migration 031_form_notification), against real Postgres with a fake Lumitra Mail. The four paths of the
// stateful-flow standard:
//
//   1. forward: a submission through POST /api/forms/submit writes its row and its job in one transaction, the job
//      sends one letter from the company's own connection, frozen and then emptied; the job payload holds no
//      visitor data; a repeated post of the same submission id changes nothing;
//   2. backtrack: nothing sent while the company is not connected (the row says why, and a connection made later
//      plus "send again" sends it in a new round), no recipient is not resendable, a refusal is failed and
//      resendable, a reconnect to another workspace builds the letter again there, an old connection without the
//      template installs it itself;
//   3. resume: Lumitra Mail down, the job waits and sends the letter unchanged though the site changed meanwhile;
//      three days of failures end it as failed;
//   4. re-entry: a deleted submission takes its notification and a pending retry ends quietly; a second company of
//      the same tenant group never reaches another's connection or rows.
// All data is synthetic.

import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import { tenantDb, type TenantGroupId } from '@marlinjai/tenant-db';

vi.mock('server-only', () => ({}));

import type { CommerceDB } from '@/server/commerce/db-types';
import { FORM_KIND_ATTR } from '@/lib/forms/definition';
import { DEMO_COMPANY_ID } from '@/lib/renderer/server/demoTenant';
import {
  createPublishedSite,
  openCommerceAppBase,
  openStorefrontFixtures,
  provisionCommerceTenant,
  type StorefrontFixtures,
} from '@/server/commerce/__tests__/storefrontFixtures';
import { runJobNow, type JobRunOptions } from '@/server/commerce/jobs/run';
import { seal } from '@/server/commerce/mail/seal';
import { MailRefused, MailRetryLater } from '@/server/commerce/mail/lumitraMail';
import type { OutboxDeps } from '@/server/commerce/mail/outbox';
import { fakeMail, type FakeMail } from '@/server/commerce/mail/__tests__/support';
import { POST } from '@/app/api/forms/submit/route';
import { __resetFormRateLimiterForTests } from '../rateLimit';
import { deleteFormSubmission, insertFormSubmission, listFormSubmissions, type NewFormSubmission } from '../repository';
import { deliverFormNotification, resendFormNotification, writeFormNotification } from '../notify';

const SEAL_KEY = randomBytes(32);
const FORM_ID = 'form-1';

let fx: StorefrontFixtures;
let appBase: Kysely<CommerceDB>;
let tgId: TenantGroupId;
let schema: string;
let appDb: Kysely<CommerceDB>;
let site: { host: string; siteId: string; workspaceId: string };

const FORM_TREE = {
  id: FORM_ID,
  type: 'div',
  componentType: 'host',
  props: { [FORM_KIND_ATTR]: 'form', formName: 'Contact', successMessage: 'Thanks!', notifyEmail: 'owner@bakery.example' },
  children: [
    { id: 'f-name', type: 'div', componentType: 'host', props: { [FORM_KIND_ATTR]: 'form-field', fieldType: 'text', name: 'name', label: 'Name', required: true } },
    { id: 'f-email', type: 'div', componentType: 'host', props: { [FORM_KIND_ATTR]: 'form-field', fieldType: 'email', name: 'email', label: 'Email', required: true } },
    { id: 'send', type: 'button', componentType: 'host', props: { [FORM_KIND_ATTR]: 'form-submit', children: 'Send' } },
  ],
};

beforeAll(async () => {
  fx = openStorefrontFixtures();
  appBase = openCommerceAppBase();
  const tenant = await provisionCommerceTenant(fx, 'formnotify');
  tgId = tenant.tgId;
  schema = tenant.schema;
  appDb = tenantDb(appBase, tgId);
  site = await createPublishedSite(fx, tgId, 'formnotify');
  await fx.prisma.sitePage.create({
    data: {
      siteId: site.siteId,
      workspaceId: site.workspaceId,
      tenantGroupId: tgId,
      pageId: 'p-contact',
      slug: 'kontakt',
      snapshot: { id: 'p-contact', slug: 'kontakt', metadata: { title: 'Kontakt' }, canvasNodes: {}, appComponentTree: { id: 'root', type: 'div', componentType: 'host', props: {}, children: [FORM_TREE] } },
    },
  });
}, 120_000);

afterAll(async () => {
  await appBase?.destroy();
  await fx?.close();
});

// ---------- a company with a Lumitra Mail connection, as the owner left it ----------

interface Company {
  id: string;
  workspaceId: string;
  providerId: string;
  mail: FakeMail;
  clock: { now: Date };
  siteInfo: { name: string; language: string };
  outbox: OutboxDeps;
}

let company: Company;

function newCompany(id: string = DEMO_COMPANY_ID): Company {
  const workspaceId = randomUUID();
  const providerId = randomUUID();
  const clock = { now: new Date('2026-11-12T09:30:00Z') };
  const mail = fakeMail({ workspaces: [], senders: {} });
  const siteInfo = { name: 'Bakery', language: 'de' };
  const outbox: OutboxDeps = {
    db: appDb,
    tenantGroupId: tgId,
    mail,
    sealKey: SEAL_KEY,
    linkKey: null,
    linkBase: 'https://app.example',
    siteInfo: async () => ({ ...siteInfo }),
    now: () => clock.now,
  };
  return { id, workspaceId, providerId, mail, clock, siteInfo, outbox };
}

async function connect(c: Company, opts: { templateIds?: Record<string, string>; workspaceId?: string } = {}) {
  const row = {
    tenant_id: c.id,
    workspace_id: opts.workspaceId ?? c.workspaceId,
    workspace_name: 'Bakery',
    provider_id: c.providerId,
    sender: 'Bakery <hello@bakery.example>',
    api_key_id: randomUUID(),
    api_key_sealed: seal(SEAL_KEY, `fake-send-key-${c.id}`),
    template_ids: opts.templateIds ?? { order_confirmation: 't1', late_refund: 't2', form_notification: 'tpl-form' },
    templates_version: 'old',
    connected_by: 'owner',
    updated_at: c.clock.now,
  };
  await fx.owner`
    INSERT INTO ${fx.owner(schema)}.shop_mail_connection
      (tenant_id, workspace_id, workspace_name, provider_id, sender, api_key_id, api_key_sealed, template_ids, templates_version, connected_by, updated_at)
    VALUES (${row.tenant_id}, ${row.workspace_id}, ${row.workspace_name}, ${row.provider_id}, ${row.sender}, ${row.api_key_id}, ${row.api_key_sealed}, ${fx.owner.json(row.template_ids)}, ${row.templates_version}, ${row.connected_by}, ${row.updated_at})
    ON CONFLICT (tenant_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id, template_ids = EXCLUDED.template_ids`;
}

const worker = (c: Company): JobRunOptions => ({ mailDeps: () => c.outbox, now: () => c.clock.now });

/** Run every `form_mail` job of the company due on its clock, as the poller would. Answers the outcomes. */
async function drain(c: Company): Promise<string[]> {
  const due = await fx.owner<{ id: string }[]>`
    SELECT id FROM ${fx.owner(schema)}.commerce_job
     WHERE tenant_id = ${c.id} AND kind = 'form_mail' AND status = 'pending' AND run_at <= ${c.clock.now}`;
  const outcomes: string[] = [];
  for (const job of due) outcomes.push((await runJobNow({ id: tgId, db: appDb }, c.id, job.id, worker(c)))?.outcome ?? 'none');
  return outcomes;
}

const notificationOf = async (id: string) =>
  (await fx.owner`SELECT * FROM ${fx.owner(schema)}.form_notification WHERE submission_id = ${id}`)[0];
const jobsOf = async (id: string) =>
  fx.owner`SELECT * FROM ${fx.owner(schema)}.commerce_job WHERE kind = 'form_mail' AND dedupe_key LIKE ${`formmail:${id}:%`} ORDER BY dedupe_key`;

function submission(over: Partial<NewFormSubmission> = {}, recipient: string | null = 'owner@bakery.example'): NewFormSubmission {
  return {
    id: randomUUID(),
    tenantId: tgId,
    workspaceId: site.workspaceId,
    siteId: site.siteId,
    pageId: 'p-contact',
    pagePath: '/kontakt',
    formId: FORM_ID,
    formName: 'Contact',
    fields: [
      { key: 'name', label: 'Name', type: 'text', value: 'Ana Beispiel' },
      { key: 'message', label: 'Message', type: 'textarea', value: 'Ein Brot bitte' },
    ],
    notification: { companyId: company.id, recipient, at: company.clock.now },
    ...over,
  };
}

beforeEach(async () => {
  __resetFormRateLimiterForTests();
  await fx.owner`DELETE FROM ${fx.owner(schema)}.form_submission`;
  await fx.owner`DELETE FROM ${fx.owner(schema)}.commerce_job WHERE kind = 'form_mail'`;
  await fx.owner`DELETE FROM ${fx.owner(schema)}.shop_mail_connection`;
  company = newCompany();
});

describe('031_form_notification', () => {
  it('lives in the tenant schema, the app role may use it, and its foreign key cascades', async () => {
    const privs = await fx.owner<{ p: string }[]>`
      SELECT privilege_type AS p FROM information_schema.role_table_grants
       WHERE table_schema = ${schema} AND table_name = 'form_notification' AND grantee = 'commerce_app' ORDER BY 1`;
    expect(privs.map((r) => r.p)).toEqual(expect.arrayContaining(['DELETE', 'INSERT', 'SELECT', 'UPDATE']));
    const fk = await fx.owner<{ confdeltype: string }[]>`
      SELECT confdeltype FROM pg_constraint WHERE conname = 'form_notification_submission_fkey' AND connamespace = ${schema}::regnamespace`;
    expect(fk[0].confdeltype).toBe('c');
  });

  it('refuses a status outside its set and a foreign tenant group id', async () => {
    const s = submission();
    await insertFormSubmission(appDb, s);
    await expect(
      fx.owner`UPDATE ${fx.owner(schema)}.form_notification SET status = 'weird' WHERE submission_id = ${s.id}`,
    ).rejects.toThrow();
    await expect(
      fx.owner`INSERT INTO ${fx.owner(schema)}.form_notification (submission_id, tenant_id, company_id, updated_at) VALUES (${randomUUID()}, 'not-a-uuid', 'c', now())`,
    ).rejects.toThrow();
  });
});

describe('1. forward', () => {
  const post = (body: Record<string, unknown>) =>
    POST(
      new Request(`https://${site.host}/api/forms/submit`, {
        method: 'POST',
        headers: { host: site.host, 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 200)}` },
        body: JSON.stringify(body),
      }),
    );

  it('a post stores the submission, its notification and its job together, then one job sends one letter', async () => {
    await connect(company);
    const submissionId = randomUUID();
    const body = { formId: FORM_ID, values: { name: 'Ana Beispiel', email: 'ana@example.com' }, elapsedMs: 9000, submissionId };
    expect((await post(body)).status).toBe(200);
    // A repeat of a lost answer changes nothing.
    expect((await post(body)).status).toBe(200);

    expect(await notificationOf(submissionId)).toMatchObject({ status: 'pending', round: 1, recipient: 'owner@bakery.example', company_id: DEMO_COMPANY_ID });
    const jobs = await jobsOf(submissionId);
    expect(jobs).toHaveLength(1);
    // The payload is the submission id and nothing else: no visitor data waits in the job table.
    expect(jobs[0].payload).toEqual({ submissionId });
    expect(JSON.stringify(jobs[0])).not.toContain('ana@example.com');

    // The route stamps the job with the real clock; the worker runs a minute later.
    company.clock.now = new Date(Date.now() + 60_000);
    expect(await drain(company)).toEqual(['done']);
    expect(company.mail.sent).toHaveLength(1);
    const letter = company.mail.sent[0];
    expect(letter).toMatchObject({ kind: 'form_notification', to: 'owner@bakery.example', locale: 'de', templateId: 'tpl-form', providerId: company.providerId });
    expect(letter.key).toBe(`form:${company.id}:${submissionId}:1:${company.workspaceId}`);
    expect(letter.merge).toMatchObject({ site_name: 'Bakery', form_name: 'Contact', page_path: '/kontakt', inbox_url: `https://app.example/projects/${site.siteId}` });
    expect(letter.merge.summary_text).toContain('Name: Ana Beispiel');
    // Sent with the company's own sealed key.
    expect(company.mail.calls.find((c) => c.op === 'send')?.args[0]).toBe(`fake-send-key-${company.id}`);

    const settled = await notificationOf(submissionId);
    expect(settled).toMatchObject({ status: 'sent', last_error: null });
    // The frozen letter held the visitor's words: it is emptied once settled.
    expect(settled.letter).toBeNull();
    // A second run of the same job sends nothing more.
    expect(await drain(company)).toEqual([]);
    expect(company.mail.sent).toHaveLength(1);
  });

  it('the editor list carries each submission with its email status', async () => {
    await connect(company);
    const sent = submission();
    const skipped = submission({}, null);
    await insertFormSubmission(appDb, sent);
    await insertFormSubmission(appDb, skipped);
    await drain(company);
    const { submissions } = await listFormSubmissions(appDb, { tenantId: tgId, siteId: site.siteId });
    const byId = new Map(submissions.map((s) => [s.id, s.notification]));
    expect(byId.get(sent.id)).toEqual({ status: 'sent', reason: null, recipient: 'owner@bakery.example' });
    expect(byId.get(skipped.id)).toEqual({ status: 'skipped', reason: 'no_recipient', recipient: null });
  });
});

describe('2. backtrack', () => {
  it('a company that is not connected sends nothing, says so, and "send again" works once it is connected', async () => {
    const s = submission();
    await insertFormSubmission(appDb, s);
    expect(await notificationOf(s.id)).toMatchObject({ status: 'skipped', last_error: 'not_connected' });
    expect(await jobsOf(s.id)).toHaveLength(0);
    // Still not connected: refused with a reason the panel shows.
    expect(await resendFormNotification(appDb, { tenantGroupId: tgId, siteId: site.siteId, submissionId: s.id }, company.clock.now)).toBe('not_connected');

    await connect(company);
    expect(await resendFormNotification(appDb, { tenantGroupId: tgId, siteId: site.siteId, submissionId: s.id }, company.clock.now)).toBe('queued');
    expect(await notificationOf(s.id)).toMatchObject({ status: 'pending', round: 2, last_error: null });
    expect(await drain(company)).toEqual(['done']);
    expect(company.mail.sent.map((l) => l.key)).toEqual([`form:${company.id}:${s.id}:2:${company.workspaceId}`]);
    // Sent: nothing to resend.
    expect(await resendFormNotification(appDb, { tenantGroupId: tgId, siteId: site.siteId, submissionId: s.id }, company.clock.now)).toBe('not_resendable');
  });

  it('no recipient is skipped; "send again" waits for an address the live form names, then sends to it; another site cannot resend it', async () => {
    await connect(company);
    const s = submission({}, null);
    await insertFormSubmission(appDb, s);
    const ref = { tenantGroupId: tgId, siteId: site.siteId, submissionId: s.id };
    // Nothing is named yet, neither stored nor live.
    expect(await resendFormNotification(appDb, ref, company.clock.now)).toBe('no_recipient');
    expect(await resendFormNotification(appDb, ref, company.clock.now, async () => null)).toBe('no_recipient');
    expect(await resendFormNotification(appDb, { ...ref, siteId: 'another-site' }, company.clock.now, async () => 'x@y.example')).toBe('not_found');
    // The owner set an address in the form and published: the live address is asked for the submission's form.
    const asked: string[] = [];
    expect(await resendFormNotification(appDb, ref, company.clock.now, async (formId) => (asked.push(formId), 'fixed@bakery.example'))).toBe('queued');
    expect(asked).toEqual([FORM_ID]);
    expect(await notificationOf(s.id)).toMatchObject({ status: 'pending', round: 2, recipient: 'fixed@bakery.example' });
    expect(await drain(company)).toEqual(['done']);
    expect(company.mail.sent[0].to).toBe('fixed@bakery.example');
  });

  it('a wrong address the owner has since fixed is not sent to again: the resend reads the live one', async () => {
    await connect(company);
    const s = submission({}, 'typo@bakery.example');
    await insertFormSubmission(appDb, s);
    company.mail.failNext('send', new MailRefused('recipient_refused', 'Lumitra Mail did not accept the recipient of the form_notification letter.'));
    expect(await drain(company)).toEqual(['dead']);
    const ref = { tenantGroupId: tgId, siteId: site.siteId, submissionId: s.id };
    expect(await resendFormNotification(appDb, ref, company.clock.now, async () => 'right@bakery.example')).toBe('queued');
    expect(await drain(company)).toEqual(['done']);
    expect(company.mail.sent.map((l) => l.to)).toEqual(['right@bakery.example']);
  });

  it('with no live answer (the site is not published any more) the stored address stays', async () => {
    await connect(company);
    const s = submission({}, 'stored@bakery.example');
    await insertFormSubmission(appDb, s);
    company.mail.failNext('send', new MailRefused('other', 'nope'));
    await drain(company);
    expect(await resendFormNotification(appDb, { tenantGroupId: tgId, siteId: site.siteId, submissionId: s.id }, company.clock.now, async () => null)).toBe('queued');
    expect((await notificationOf(s.id)).recipient).toBe('stored@bakery.example');
  });

  it('a refusal is failed with its reason, the job dead and the letter emptied; "send again" starts a new round that sends', async () => {
    await connect(company);
    const s = submission();
    await insertFormSubmission(appDb, s);
    company.mail.failNext('send', new MailRefused('key_revoked', 'Lumitra Mail refused sending: api_key_revoked (401).'));
    expect(await drain(company)).toEqual(['dead']);
    const failed = await notificationOf(s.id);
    expect(failed).toMatchObject({ status: 'failed' });
    expect(failed.last_error).toContain('api_key_revoked');
    expect(failed.letter).toBeNull();
    expect((await jobsOf(s.id))[0]).toMatchObject({ status: 'dead' });

    expect(await resendFormNotification(appDb, { tenantGroupId: tgId, siteId: site.siteId, submissionId: s.id }, company.clock.now)).toBe('queued');
    expect(await drain(company)).toEqual(['done']);
    expect(await notificationOf(s.id)).toMatchObject({ status: 'sent', round: 2 });
    expect(await jobsOf(s.id)).toHaveLength(2);
    expect(company.mail.sent).toHaveLength(1);
  });

  it('a blocked address is blocked and done; once another address is set, "send again" goes there', async () => {
    await connect(company);
    company.mail.blocked.add('owner@bakery.example');
    const s = submission();
    await insertFormSubmission(appDb, s);
    expect(await drain(company)).toEqual(['done']);
    expect(await notificationOf(s.id)).toMatchObject({ status: 'blocked' });
    expect(await resendFormNotification(appDb, { tenantGroupId: tgId, siteId: site.siteId, submissionId: s.id }, company.clock.now, async () => 'other@bakery.example')).toBe('queued');
    expect(await drain(company)).toEqual(['done']);
    // The fake records the blocked letter too; the last one is the new round's.
    expect(company.mail.sent.at(-1)?.to).toBe('other@bakery.example');
  });

  it('a connection from before the notice existed gets the template installed by the first notification', async () => {
    await connect(company, { templateIds: { order_confirmation: 't1', late_refund: 't2' } });
    const s = submission();
    await insertFormSubmission(appDb, s);
    expect(await drain(company)).toEqual(['done']);
    expect(company.mail.calls.filter((c) => c.op === 'installTemplates')).toHaveLength(1);
    expect(company.mail.sent[0].templateId).toBe('tpl-form');
    const [conn] = await fx.owner`SELECT template_ids FROM ${fx.owner(schema)}.shop_mail_connection WHERE tenant_id = ${company.id}`;
    expect(conn.template_ids).toMatchObject({ form_notification: 'tpl-form' });
    // The next one finds it and installs nothing.
    const t = submission();
    await insertFormSubmission(appDb, t);
    await drain(company);
    expect(company.mail.calls.filter((c) => c.op === 'installTemplates')).toHaveLength(1);
  });

  it('a template install that fails keeps the notification pending and retried, not lost', async () => {
    await connect(company, { templateIds: { order_confirmation: 't1', late_refund: 't2' } });
    const s = submission();
    await insertFormSubmission(appDb, s);
    company.mail.failNext('installTemplates', new MailRetryLater('Lumitra Mail could not be reached while installing the shop mails.'));
    expect(await drain(company)).toEqual(['retry']);
    expect(await notificationOf(s.id)).toMatchObject({ status: 'pending' });
    company.clock.now = new Date(company.clock.now.getTime() + 2 * 60 * 1000);
    expect(await drain(company)).toEqual(['done']);
    expect(company.mail.sent).toHaveLength(1);
  });

  it('a reconnect to another workspace builds the letter again there, under a key of that workspace', async () => {
    await connect(company);
    const s = submission();
    await insertFormSubmission(appDb, s);
    company.mail.failNext('send', new MailRetryLater('Lumitra Mail did not answer in time while sending the form_notification letter.'));
    expect(await drain(company)).toEqual(['retry']);
    expect((await notificationOf(s.id)).letter).toMatchObject({ workspaceId: company.workspaceId });

    const other = randomUUID();
    await connect(company, { workspaceId: other });
    company.clock.now = new Date(company.clock.now.getTime() + 2 * 60 * 1000);
    expect(await drain(company)).toEqual(['done']);
    expect(company.mail.sent[0].key).toBe(`form:${company.id}:${s.id}:1:${other}`);
  });
});

describe('a failure writing the notice never costs the submission', () => {
  it('a notification the database refuses is rolled back alone: the submission is stored, without it', async () => {
    await connect(company);
    // A recipient past the column bound: its CHECK refuses the notification row.
    const s = submission({}, `${'a'.repeat(300)}@bakery.example`);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await insertFormSubmission(appDb, s)).toBe(true);
    logged.mockRestore();
    const { submissions } = await listFormSubmissions(appDb, { tenantId: tgId, siteId: site.siteId });
    expect(submissions.map((x) => x.id)).toEqual([s.id]);
    expect(submissions[0].notification).toBeNull();
    expect(await jobsOf(s.id)).toHaveLength(0);
  });
});

describe('3. resume', () => {
  it('Lumitra Mail down: the job waits and sends the letter as first built, though the site changed meanwhile', async () => {
    await connect(company);
    const s = submission();
    await insertFormSubmission(appDb, s);
    company.mail.failNext('send', new MailRetryLater('Lumitra Mail could not be reached while creating the form_notification letter.'));
    expect(await drain(company)).toEqual(['retry']);
    const waiting = await notificationOf(s.id);
    expect(waiting.status).toBe('pending');
    expect(waiting.last_error).toContain('could not be reached');
    // Nothing is due yet.
    expect(await drain(company)).toEqual([]);

    company.siteInfo.name = 'Renamed Bakery';
    company.siteInfo.language = 'en';
    company.clock.now = new Date(company.clock.now.getTime() + 2 * 60 * 1000);
    expect(await drain(company)).toEqual(['done']);
    expect(company.mail.sent).toHaveLength(1);
    expect(company.mail.sent[0].merge.site_name).toBe('Bakery');
    expect(company.mail.sent[0].locale).toBe('de');
    expect(await notificationOf(s.id)).toMatchObject({ status: 'sent', last_error: null });
  });

  it('two overlapping attempts at one letter send one', async () => {
    await connect(company);
    const s = submission();
    await insertFormSubmission(appDb, s);
    const [a, b] = await Promise.all([deliverFormNotification(company.outbox, company.id, s.id), deliverFormNotification(company.outbox, company.id, s.id)].map((p) => p.catch(() => 'retry')));
    expect([a, b]).toContain('sent');
    expect(company.mail.sent).toHaveLength(1);
  });

  it('three days of failures end it as failed, the job dead, and the owner can send it again', async () => {
    await connect(company);
    const s = submission();
    await insertFormSubmission(appDb, s);
    company.mail.failNext('send', new MailRetryLater('Lumitra Mail is down.'));
    expect(await drain(company)).toEqual(['retry']);
    company.clock.now = new Date(company.clock.now.getTime() + 3 * 24 * 60 * 60 * 1000 + 60_000);
    company.mail.failNext('send', new MailRetryLater('Lumitra Mail is down.'));
    expect(await drain(company)).toEqual(['dead']);
    expect(await notificationOf(s.id)).toMatchObject({ status: 'failed' });
    expect(await resendFormNotification(appDb, { tenantGroupId: tgId, siteId: site.siteId, submissionId: s.id }, company.clock.now)).toBe('queued');
    // The new round has its own three days.
    expect(await drain(company)).toEqual(['done']);
  });

  it('a send that finishes after the three days ran out on another attempt still settles as sent, never failed', async () => {
    await connect(company);
    const s = submission();
    await insertFormSubmission(appDb, s);
    await fx.owner`UPDATE ${fx.owner(schema)}.form_notification SET status = 'failed', last_error = 'gave_up' WHERE submission_id = ${s.id}`;
    // An attempt that began while the row was pending: it read the row before the other attempt wrote failed.
    await fx.owner`UPDATE ${fx.owner(schema)}.form_notification SET status = 'pending' WHERE submission_id = ${s.id}`;
    const original = company.mail.send.bind(company.mail);
    company.mail.send = async (apiKey, letter) => {
      await fx.owner`UPDATE ${fx.owner(schema)}.form_notification SET status = 'failed', last_error = 'gave_up' WHERE submission_id = ${s.id}`;
      return original(apiKey, letter);
    };
    expect(await deliverFormNotification(company.outbox, company.id, s.id)).toBe('sent');
    expect(await notificationOf(s.id)).toMatchObject({ status: 'sent' });
  });

  it('Lumitra Mail not configured on the platform keeps it pending', async () => {
    await connect(company);
    const s = submission();
    await insertFormSubmission(appDb, s);
    const unconfigured = { ...company.outbox, mail: null };
    await expect(deliverFormNotification(unconfigured, company.id, s.id)).rejects.toMatchObject({ name: 'JobRetryLater' });
    expect(await notificationOf(s.id)).toMatchObject({ status: 'pending' });
  });
});

describe('4. re-entry', () => {
  it('deleting a submission takes its notification, and a pending retry ends quietly', async () => {
    await connect(company);
    const s = submission();
    await insertFormSubmission(appDb, s);
    company.mail.failNext('send', new MailRetryLater('Lumitra Mail could not be reached while creating the form_notification letter.'));
    expect(await drain(company)).toEqual(['retry']);
    expect(await deleteFormSubmission(appDb, { tenantId: tgId, siteId: site.siteId }, s.id)).toBe(true);
    expect(await notificationOf(s.id)).toBeUndefined();
    company.clock.now = new Date(company.clock.now.getTime() + 2 * 60 * 1000);
    expect(await drain(company)).toEqual(['done']);
    expect(company.mail.sent).toHaveLength(0);
  });

  it('a second company of the same tenant group never reaches another company: not its connection, not its rows', async () => {
    const other = newCompany(randomUUID());
    await connect(company);
    await connect(other);
    const mine = submission();
    await insertFormSubmission(appDb, mine);
    // The other company's worker is handed this submission id: the row is not its own.
    expect(await deliverFormNotification(other.outbox, other.id, mine.id)).toBe('none');
    expect(other.mail.sent).toHaveLength(0);
    expect(company.mail.sent).toHaveLength(0);
    // Its own job still sends from its own connection and key.
    expect(await drain(company)).toEqual(['done']);
    expect(company.mail.calls.find((c) => c.op === 'send')?.args[0]).toBe(`fake-send-key-${company.id}`);
    // The other company has no write path into this row either.
    expect(await notificationOf(mine.id)).toMatchObject({ company_id: company.id, status: 'sent' });
  });

  it('the project delete and a delete by site take the notifications with the rows', async () => {
    await connect(company);
    const s = submission();
    await insertFormSubmission(appDb, s);
    const { deleteSiteSubmissions } = await import('../repository');
    expect(await deleteSiteSubmissions(appDb, { tenantId: tgId, siteId: site.siteId })).toBe(1);
    expect(await notificationOf(s.id)).toBeUndefined();
  });

  it('writeFormNotification alone is idempotent per submission', async () => {
    await connect(company);
    const s = submission({ notification: undefined });
    await insertFormSubmission(appDb, s);
    await appDb.transaction().execute(async (trx) => {
      await writeFormNotification(trx, tgId, s.id, { companyId: company.id, recipient: 'owner@bakery.example', at: company.clock.now });
      await writeFormNotification(trx, tgId, s.id, { companyId: company.id, recipient: 'someone@else.example', at: company.clock.now });
    });
    expect((await notificationOf(s.id)).recipient).toBe('owner@bakery.example');
    expect(await jobsOf(s.id)).toHaveLength(1);
  });
});

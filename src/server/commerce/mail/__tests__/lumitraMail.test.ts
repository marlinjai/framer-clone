// @vitest-environment node
//
// The shop's calls to Lumitra Mail (lumitraMail.ts) over SDK clients that answer like Lumitra Mail: the three
// calls of a letter with their idempotency keys, a letter an earlier attempt already started, the block check
// after sending (only bounces, complaints and manual blocks on every topic stop a transactional letter), how
// errors map to "try again" or "refused", the template install and the languages.
import { describe, expect, it, vi } from 'vitest';
import { MailApiError, MailNetworkError, MailTimeoutError, type MailClient } from '@marlinjai/mail-sdk';

vi.mock('server-only', () => ({}));

import { MailRefused, MailRetryLater, lumitraMailOver, toMailError, type Letter } from '../lumitraMail';
import { SHOP_MAIL_KINDS, templateName } from '../templates';

const LETTER: Letter = {
  key: 'shop:t:o:order_confirmation:w',
  kind: 'order_confirmation',
  locale: 'de',
  templateId: 'tpl-1',
  providerId: 'prov-1',
  to: 'Alex@Example.com',
  merge: { order_number: 'ORD-1' },
};

const apiError = (code: string, status: number, details?: Record<string, unknown>) =>
  new MailApiError({ code: code as never, status, message: code, details });

type Calls = { op: string; args: unknown[] }[];

/** A workspace-key client: mailings and suppressions as Lumitra Mail answers them, with overrides. */
function keyClient(calls: Calls, opts: { create?: () => unknown; add?: () => unknown; send?: () => unknown; blocks?: unknown[]; templates?: unknown[] } = {}) {
  const record = (op: string, args: unknown[], fn?: () => unknown, fallback?: unknown) => {
    calls.push({ op, args });
    return fn ? Promise.resolve().then(fn) : Promise.resolve(fallback);
  };
  return {
    mailings: {
      create: (body: unknown, o: unknown) => record('mailings.create', [body, o], opts.create, { id: 'mailing-1' }),
      addRecipients: (id: string, body: unknown, o: unknown) => record('mailings.addRecipients', [id, body, o], opts.add, { rejected: [] }),
      send: (id: string, o: unknown) => record('mailings.send', [id, o], opts.send, {}),
    },
    templates: {
      create: (body: { name: string }) => record('templates.create', [body], undefined, { id: `new-${body.name}` }),
      get: (id: string) => record('templates.get', [id], undefined, { id, locale: 'de', version: 3, archived_at: null }),
      update: (id: string, body: unknown) => record('templates.update', [id, body], undefined, {}),
      declareInputs: (id: string, body: unknown) => record('templates.declareInputs', [id, body], undefined, {}),
    },
    async *paginate(op: string, args: unknown) {
      calls.push({ op, args: [args] });
      const items = op === 'suppressions.list' ? (opts.blocks ?? []) : op === 'templates.list' ? (opts.templates ?? []) : [];
      for (const item of items) yield item;
    },
  } as unknown as MailClient;
}

function mailWith(client: MailClient, person?: MailClient) {
  return lumitraMailOver(() => person ?? client, () => client);
}

describe('sending one letter', () => {
  it('creates a transactional letter, adds its one recipient and sends it, each call with its own key', async () => {
    const calls: Calls = [];
    const result = await mailWith(keyClient(calls)).send('key', LETTER);
    expect(result).toEqual({ mailingId: 'mailing-1', delivery: 'sent' });
    expect(calls.map((c) => c.op)).toEqual(['mailings.create', 'mailings.addRecipients', 'mailings.send', 'suppressions.list']);
    expect(calls[0].args).toEqual([
      { name: 'Shop: order_confirmation', template_id: 'tpl-1', provider_id: 'prov-1', transactional: true, template_locale: 'de', metadata: { kind: 'order_confirmation' } },
      { idempotencyKey: 'shop:t:o:order_confirmation:w:create' },
    ]);
    expect(calls[1].args[1]).toEqual({ recipients: [{ email: 'Alex@Example.com', merge: { order_number: 'ORD-1' } }] });
    expect((calls[1].args[2] as { idempotencyKey: string }).idempotencyKey).toBe('shop:t:o:order_confirmation:w:recipients');
    expect((calls[2].args[1] as { idempotencyKey: string }).idempotencyKey).toBe('shop:t:o:order_confirmation:w:send');
  });

  it('a letter an earlier attempt already started counts as sent', async () => {
    const started = () => {
      throw apiError('mailing_invalid_state', 409, { status: 'sending' });
    };
    expect((await mailWith(keyClient([], { add: started, send: started })).send('key', LETTER)).delivery).toBe('sent');
    // A mailing in another state is a refusal, not a success.
    const draftState = () => {
      throw apiError('mailing_invalid_state', 409, { status: 'cancelled' });
    };
    await expect(mailWith(keyClient([], { send: draftState })).send('key', LETTER)).rejects.toBeInstanceOf(MailRefused);
  });

  it('is blocked only by a bounce, a complaint or a manual block on every topic', async () => {
    const block = (reason: string, topic: string | null = null) => ({ email: 'alex@example.com', reason, topic });
    for (const reason of ['bounced', 'complained', 'manual']) {
      expect((await mailWith(keyClient([], { blocks: [block(reason)] })).send('key', LETTER)).delivery).toBe('blocked');
    }
    expect((await mailWith(keyClient([], { blocks: [block('unsubscribed')] })).send('key', LETTER)).delivery).toBe('sent');
    expect((await mailWith(keyClient([], { blocks: [block('bounced', 'news')] })).send('key', LETTER)).delivery).toBe('sent');
  });

  it('a missing template is refused as such, a rejected recipient as such', async () => {
    const missing = () => {
      throw apiError('not_found', 404);
    };
    await expect(mailWith(keyClient([], { create: missing })).send('key', LETTER)).rejects.toMatchObject({ reason: 'template_missing' });
    await expect(mailWith(keyClient([], { add: () => ({ rejected: [{ email: 'x' }] }) })).send('key', LETTER)).rejects.toMatchObject({
      reason: 'recipient_refused',
    });
  });
});

describe('what an error means', () => {
  it('try again for an outage, a limit or a call in flight; refused for what will keep failing', () => {
    expect(toMailError(apiError('internal', 500), 'x')).toBeInstanceOf(MailRetryLater);
    expect(toMailError(apiError('rate_limited', 429), 'x')).toBeInstanceOf(MailRetryLater);
    expect(toMailError(apiError('conflict', 409), 'x')).toBeInstanceOf(MailRetryLater);
    expect(toMailError(new MailNetworkError('down', null), 'x')).toBeInstanceOf(MailRetryLater);
    expect(toMailError(new MailTimeoutError(10_000), 'x')).toBeInstanceOf(MailRetryLater);
    expect(toMailError(apiError('insufficient_role', 403), 'x')).toMatchObject({ reason: 'role_too_low' });
    expect(toMailError(apiError('forbidden', 403), 'x')).toMatchObject({ reason: 'not_a_member' });
    expect(toMailError(apiError('api_key_revoked', 401), 'x')).toMatchObject({ reason: 'key_revoked' });
    expect(toMailError(apiError('idempotency_key_reused', 422), 'x')).toMatchObject({ reason: 'other' });
  });
});

describe('connecting', () => {
  it('adds only the languages the workspace lacks, and nothing when it has both', async () => {
    const updates: unknown[] = [];
    const person = { workspace: { update: async (body: unknown) => updates.push(body) } } as unknown as MailClient;
    const mail = lumitraMailOver(() => person, () => person);
    await mail.ensureLanguages('s', { id: 'w', name: 'W', role: 'owner', companyId: 'c', locales: ['de'] });
    await mail.ensureLanguages('s', { id: 'w', name: 'W', role: 'owner', companyId: 'c', locales: ['DE', 'en'] });
    expect(updates).toEqual([{ settings: { locales: ['de', 'en'] } }]);
  });

  it('installs both templates: creates a missing one, updates an existing one, and declares the inputs of both', async () => {
    const calls: Calls = [];
    const existing = { id: 'tpl-existing', name: templateName('late_refund'), archived_at: null };
    const ids = await mailWith(keyClient(calls, { templates: [existing] })).installTemplates('key');
    expect(ids).toEqual({ order_confirmation: `new-${templateName('order_confirmation')}`, late_refund: 'tpl-existing' });
    expect(calls.filter((c) => c.op === 'templates.create')).toHaveLength(1);
    expect(calls.find((c) => c.op === 'templates.update')?.args[0]).toBe('tpl-existing');
    expect(calls.filter((c) => c.op === 'templates.declareInputs')).toHaveLength(SHOP_MAIL_KINDS.length);
  });

  it('takes the live template over an archived one of the same name, and brings back an archived one when none is live', async () => {
    const calls: Calls = [];
    const listed = [
      { id: 'old', name: templateName('order_confirmation'), archived_at: '2026-10-01T00:00:00.000Z' },
      { id: 'live', name: templateName('order_confirmation'), archived_at: null },
      { id: 'archived-only', name: templateName('late_refund'), archived_at: '2026-10-01T00:00:00.000Z' },
    ];
    expect(await mailWith(keyClient(calls, { templates: listed })).installTemplates('key')).toEqual({ order_confirmation: 'live', late_refund: 'archived-only' });
    expect(calls.filter((c) => c.op === 'templates.create')).toHaveLength(0);
  });

  it('refuses a workspace holding two live templates of one name', async () => {
    const twice = [
      { id: 'a', name: templateName('order_confirmation'), archived_at: null },
      { id: 'b', name: templateName('order_confirmation'), archived_at: null },
    ];
    await expect(mailWith(keyClient([], { templates: twice })).installTemplates('key')).rejects.toBeInstanceOf(MailRefused);
  });
});

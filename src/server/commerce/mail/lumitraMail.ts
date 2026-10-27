import 'server-only';

// src/server/commerce/mail/lumitraMail.ts
//
// Everything the shop asks of Lumitra Mail (docs/plans/2026-10-27-shop-receipt-email.md), behind one interface
// so every test runs against a fake. Two credentials, never mixed:
//
//   - the service token (`sites`, a trusted application there) with the signed-in owner's auth-brain subject,
//     for connecting and disconnecting only: list the person's workspaces, read the sending accounts, add the
//     two languages, create the shop's `send` key, revoke it;
//   - that `send` key, for installing the templates and sending the letters.
//
// A letter is a mailing with no topic and one recipient, made in three calls (create, add the recipient, send),
// each carrying an idempotency key derived from the shop's own key for the letter, so the outbox may repeat a
// letter after a failure at any point and one mail goes out (the pattern of Lumitra Booking's gateway).
//
// Failures come back as one of two errors: MailRetryLater (Lumitra Mail unreachable, busy or failing; try again)
// and MailRefused (it will keep saying no: a missing template, a revoked key, a refused recipient). Neither the
// token nor a key is ever logged or put into an error.

import { createHash } from 'node:crypto';
import { IDEMPOTENCY_KEY_MAX_LENGTH, TRANSACTIONAL_BLOCKING_REASONS, type Template } from '@marlinjai/mail-contract';
import {
  MailApiError,
  MailNetworkError,
  MailResponseValidationError,
  MailTimeoutError,
  createDashboardMailClient,
  createMailClient,
  type MailClient,
} from '@marlinjai/mail-sdk';

import type { ShopMailConfig } from './config';
import {
  DECLARING_APP,
  MAIN_LOCALE,
  MAIL_INPUTS,
  SHOP_MAIL_KINDS,
  TEMPLATE_LOCALES,
  templateCreate,
  templateName,
  type ShopMailKind,
  type ShopMailLocale,
} from './templates';

const TIMEOUT_MS = 10_000;
const MAX_RETRIES = 1;
/** States in which a mailing has left the caller's hands. */
const STARTED_STATUSES = ['sending', 'paused', 'sent', 'partially_failed'];

/** Lumitra Mail could not answer now (down, busy, a conflict in flight): the outbox tries again later. */
export class MailRetryLater extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailRetryLater';
  }
}

/** Lumitra Mail refused, and will again: `reason` is a stable code the payments page and the outbox show. */
export class MailRefused extends Error {
  constructor(
    readonly reason:
      | 'not_a_member'
      | 'role_too_low'
      | 'not_found'
      | 'key_revoked'
      | 'template_missing'
      | 'recipient_refused'
      | 'languages'
      | 'other',
    message: string,
  ) {
    super(message);
    this.name = 'MailRefused';
  }
}

export interface MailWorkspace {
  id: string;
  name: string;
  role: string;
  companyId: string | null;
  locales: string[];
}

export interface MailSender {
  id: string;
  label: string;
}

export interface Letter {
  /** The shop's own key for this letter (`<tenant>:<order>:<kind>`): repeats send one mail. */
  key: string;
  kind: ShopMailKind;
  locale: ShopMailLocale;
  templateId: string;
  providerId: string;
  to: string;
  merge: Record<string, string>;
}

export interface LumitraMail {
  workspaces(subject: string): Promise<MailWorkspace[]>;
  senders(subject: string, workspaceId: string): Promise<MailSender[]>;
  /** Adds the languages the templates are written in, when the workspace lacks one. */
  ensureLanguages(subject: string, workspace: MailWorkspace): Promise<void>;
  createKey(subject: string, workspaceId: string, attempt: string): Promise<{ id: string; key: string }>;
  revokeKey(subject: string, workspaceId: string, keyId: string): Promise<void>;
  /** Creates or updates the two templates and declares their inputs; answers their ids. */
  installTemplates(apiKey: string): Promise<Record<ShopMailKind, string>>;
  /** Sends one letter: `blocked` when the address is blocked for transactional mail (bounce, complaint, by hand). */
  send(apiKey: string, letter: Letter): Promise<{ mailingId: string; delivery: 'sent' | 'blocked' }>;
}

/** Whatever Lumitra Mail threw, as one of the two errors. `what` names the call, for the log. */
export function toMailError(error: unknown, what: string): MailRetryLater | MailRefused {
  if (error instanceof MailRetryLater || error instanceof MailRefused) return error;
  if (error instanceof MailApiError) {
    const message = `Lumitra Mail refused ${what}: ${error.code} (${error.status}). ${error.message}`;
    if (error.status >= 500 || error.code === 'rate_limited' || error.code === 'conflict') return new MailRetryLater(message);
    if (error.code === 'insufficient_role') return new MailRefused('role_too_low', message);
    if (error.code === 'forbidden') return new MailRefused('not_a_member', message);
    if (error.code === 'not_found') return new MailRefused('not_found', message);
    if (error.code === 'api_key_revoked' || error.code === 'invalid_api_key' || error.code === 'unauthenticated') {
      return new MailRefused('key_revoked', message);
    }
    return new MailRefused('other', message);
  }
  if (error instanceof MailTimeoutError) return new MailRetryLater(`Lumitra Mail did not answer in time while ${what}.`);
  if (error instanceof MailNetworkError) return new MailRetryLater(`Lumitra Mail could not be reached while ${what}.`);
  if (error instanceof MailResponseValidationError) {
    return new MailRefused('other', `Lumitra Mail answered ${what} (${error.operationId}) in a shape its contract does not describe.`);
  }
  return new MailRetryLater(`An unexpected ${error instanceof Error ? error.name : typeof error} while ${what}.`);
}

/** The key of one call: Lumitra Mail takes 1 to 255 printable characters; a longer key is replaced by its digest. */
export function callKey(letterKey: string, step: string): string {
  const key = `${letterKey}:${step}`;
  if (key.length <= IDEMPOTENCY_KEY_MAX_LENGTH && /^[\x21-\x7e]+$/.test(key)) return key;
  return `sha256:${createHash('sha256').update(letterKey).digest('hex')}:${step}`;
}

function sameLanguage(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function statusOf(error: MailApiError): string | undefined {
  const status = error.details?.status;
  return typeof status === 'string' ? status : undefined;
}

export function createLumitraMail(config: ShopMailConfig): LumitraMail {
  const dashboard = createDashboardMailClient({
    baseUrl: config.serviceUrl,
    serviceToken: config.serviceToken,
    timeoutMs: TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
  });
  const asPerson = (subject: string, workspaceId?: string): MailClient =>
    dashboard.forUser(workspaceId === undefined ? { subject } : { subject, workspaceId });
  const withKey = (apiKey: string): MailClient =>
    createMailClient({ baseUrl: config.serviceUrl, apiKey, timeoutMs: TIMEOUT_MS, maxRetries: MAX_RETRIES });
  return lumitraMailOver(asPerson, withKey);
}

/**
 * The shop's calls over two SDK clients: one acting for a person (the service token), one for a workspace key.
 * Tests pass clients that answer like Lumitra Mail to exercise the real calls, keys and error handling.
 */
export function lumitraMailOver(
  asPerson: (subject: string, workspaceId?: string) => MailClient,
  withKey: (apiKey: string) => MailClient,
): LumitraMail {
  async function call<T>(what: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw toMailError(error, what);
    }
  }

  /** One template, found by name and brought to what this repository holds; answers its id. */
  async function installOne(client: MailClient, kind: ShopMailKind, existing: Map<string, string[]>): Promise<string> {
    const wanted = templateCreate(kind);
    const ids = existing.get(templateName(kind)) ?? [];
    if (ids.length > 1) {
      throw new MailRefused('other', `The mail workspace holds ${ids.length} templates named "${templateName(kind)}": keep one, then connect again.`);
    }
    let id: string;
    if (ids.length === 0) {
      id = (await client.templates.create(wanted)).id;
    } else {
      id = ids[0];
      const current: Template = await client.templates.get(id);
      if (!sameLanguage(current.locale, wanted.locale ?? MAIN_LOCALE)) {
        throw new MailRefused('other', `The template "${templateName(kind)}" has ${current.locale} as its main language: delete it, then connect again.`);
      }
      await client.templates.update(id, {
        base_version: current.version,
        name: wanted.name,
        description: wanted.description ?? null,
        subject: wanted.subject ?? null,
        preheader: wanted.preheader ?? null,
        document: wanted.document,
        insertions: wanted.insertions,
        translations: wanted.translations,
        ...(current.archived_at === null ? {} : { archived: false }),
      });
    }
    await client.templates.declareInputs(id, { app: DECLARING_APP, app_version: createHash('sha256').update(JSON.stringify(MAIL_INPUTS[kind])).digest('hex').slice(0, 12), inputs: MAIL_INPUTS[kind] });
    return id;
  }

  return {
    workspaces: (subject) =>
      call('listing the workspaces of the person', async () => {
        const found: MailWorkspace[] = [];
        for await (const ws of asPerson(subject).paginate('workspaces.list', { query: {} })) {
          found.push({ id: ws.id, name: ws.name, role: ws.role, companyId: ws.company_id, locales: [...ws.settings.locales] });
        }
        return found;
      }),

    senders: (subject, workspaceId) =>
      call('listing the sending accounts of the workspace', async () => {
        const found: MailSender[] = [];
        for await (const provider of asPerson(subject, workspaceId).paginate('providers.list', { query: {} })) {
          found.push({ id: provider.id, label: `${provider.from_name} <${provider.from_email}>` });
        }
        return found;
      }),

    ensureLanguages: (subject, workspace) =>
      call('adding the languages of the shop mails', async () => {
        const missing = TEMPLATE_LOCALES.filter((locale) => !workspace.locales.some((tag) => sameLanguage(tag, locale)));
        if (missing.length === 0) return;
        await asPerson(subject, workspace.id).workspace.update({ settings: { locales: [...workspace.locales, ...missing] } });
      }),

    createKey: (subject, workspaceId, attempt) =>
      call('creating the key of the shop', async () => {
        const created = await asPerson(subject, workspaceId).apiKeys.create({ name: 'Lumitra Sites shop', scope: 'send' }, { idempotencyKey: attempt });
        return { id: created.api_key.id, key: created.key };
      }),

    revokeKey: (subject, workspaceId, keyId) =>
      call('revoking the key of the shop', async () => {
        await asPerson(subject, workspaceId).apiKeys.revoke(keyId);
      }),

    installTemplates: (apiKey) =>
      call('installing the shop mails', async () => {
        const client = withKey(apiKey);
        // By name: the live templates, or the archived ones when none is live (an install brings one back).
        const live = new Map<string, string[]>();
        const archived = new Map<string, string[]>();
        for await (const summary of client.paginate('templates.list', { query: {} })) {
          const into = summary.archived_at === null ? live : archived;
          into.set(summary.name, [...(into.get(summary.name) ?? []), summary.id]);
        }
        const existing = new Map<string, string[]>([...archived].map(([name, ids]) => [name, ids.slice(0, 1)]));
        for (const [name, ids] of live) existing.set(name, ids);
        const ids = {} as Record<ShopMailKind, string>;
        for (const kind of SHOP_MAIL_KINDS) ids[kind] = await installOne(client, kind, existing);
        return ids;
      }),

    async send(apiKey, letter) {
      const client = withKey(apiKey);
      let mailingId: string;
      try {
        const mailing = await client.mailings.create(
          {
            name: `Shop: ${letter.kind}`,
            template_id: letter.templateId,
            provider_id: letter.providerId,
            // No topic and transactional: a letter that answers what its reader did, written from one language.
            transactional: true,
            template_locale: letter.locale,
            metadata: { kind: letter.kind },
          },
          { idempotencyKey: callKey(letter.key, 'create') },
        );
        mailingId = mailing.id;
      } catch (error) {
        if (error instanceof MailApiError && error.code === 'not_found') {
          throw new MailRefused('template_missing', `The mail workspace has no template or sending account for ${letter.kind}: connect the shop again.`);
        }
        throw toMailError(error, `creating the ${letter.kind} letter`);
      }
      try {
        const added = await client.mailings.addRecipients(
          mailingId,
          { recipients: [{ email: letter.to, merge: letter.merge }] },
          { idempotencyKey: callKey(letter.key, 'recipients') },
        );
        if (added.rejected.length > 0) throw new MailRefused('recipient_refused', `Lumitra Mail did not accept the recipient of the ${letter.kind} letter.`);
      } catch (error) {
        const started = error instanceof MailApiError && error.code === 'mailing_invalid_state' && STARTED_STATUSES.includes(statusOf(error) ?? '');
        if (!started) throw toMailError(error, `adding the recipient of the ${letter.kind} letter`);
      }
      try {
        await client.mailings.send(mailingId, { idempotencyKey: callKey(letter.key, 'send') });
      } catch (error) {
        const started = error instanceof MailApiError && error.code === 'mailing_invalid_state' && STARTED_STATUSES.includes(statusOf(error) ?? '');
        if (!started) throw toMailError(error, `sending the ${letter.kind} letter`);
      }
      // Lumitra Mail decides a block in its send worker, after `send` answered: ask for it, by the contract's reasons.
      const blocked = await call('reading the blocks of the recipient', async () => {
        const address = letter.to.trim().toLowerCase();
        const stops: readonly string[] = TRANSACTIONAL_BLOCKING_REASONS;
        for await (const block of client.paginate('suppressions.list', { query: { email: address } })) {
          if (block.topic === null && block.email.toLowerCase() === address && stops.includes(block.reason)) return true;
        }
        return false;
      });
      return { mailingId, delivery: blocked ? 'blocked' : 'sent' };
    },
  };
}

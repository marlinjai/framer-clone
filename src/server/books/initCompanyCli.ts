// src/server/books/initCompanyCli.ts
//
// The logic of `pnpm books:init-company` (scripts/books-init-company.ts, which
// documents the flags), kept here so it can be driven end to end in a test with
// its own argv, environment and a stubbed auth-brain. No `server-only` imports:
// the script runs it under tsx.

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { createNodeDb } from '@marlinjai/tenant-db/node';
import { tenantDb } from '@marlinjai/tenant-db';

import type { CommerceDB } from '../commerce/db-types';
import { booksScope } from './scope';
import { initBooksCompany, type InitBooksCompanyResult } from './settings';
import { senderBlockV1Schema, type SenderBlockV1 } from './snapshots';

/** The environment the run reads (process.env in the script, a plain object in tests). */
export type Env = Record<string, string | undefined>;

const SENDER_FIELDS = Object.keys(senderBlockV1Schema.shape) as Array<keyof SenderBlockV1>;

interface AuthBrainTenant {
  id: string;
  legal_name: string | null;
  vat_id: string | null;
  billing_address: { street: string; city: string; postal_code: string; country: string } | null;
}

function fail(message: string): never {
  throw new Error(`books:init-company: ${message}`);
}

/** `invoice={n}:62` -> { docType, format, nextValue }. The format may itself contain ':' only inside {n:W}. */
function parseCounter(spec: string): { docType: 'invoice' | 'credit_note' | 'offer'; format: string; nextValue: number } {
  const m = /^(invoice|credit_note|offer)=(.+):(\d+)$/.exec(spec);
  if (!m) fail(`--counter ${JSON.stringify(spec)}: expected <invoice|credit_note|offer>=<format>:<next value>`);
  return { docType: m[1] as 'invoice' | 'credit_note' | 'offer', format: m[2], nextValue: Number(m[3]) };
}

async function readAuthBrainTenant(
  env: Env,
  tenantGroupId: string,
  tenantId: string,
): Promise<AuthBrainTenant> {
  const base = (env.AUTH_BRAIN_URL ?? 'https://auth.lumitra.co').replace(/\/+$/, '');
  const key = env.AUTH_BRAIN_ADMIN_API_KEY;
  if (!key) fail('AUTH_BRAIN_ADMIN_API_KEY is not set (or pass --sender-file-only)');
  let cursor: string | null = null;
  for (let page = 0; page < 50; page += 1) {
    const url = new URL(`${base}/api/admin/machine/tenants`);
    url.searchParams.set('group_id', tenantGroupId);
    url.searchParams.set('limit', '200');
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await fetch(url, { headers: { authorization: `Bearer ${key}` } });
    if (!res.ok) fail(`auth-brain answered ${res.status} for the tenant list of the group`);
    const body = (await res.json()) as { items: AuthBrainTenant[]; next_cursor: string | null };
    const hit = body.items.find((t) => t.id === tenantId);
    if (hit) return hit;
    if (!body.next_cursor) break;
    cursor = body.next_cursor;
  }
  fail('the company is not a tenant of that tenant group in auth-brain');
}

function emptySender(): SenderBlockV1 {
  return Object.fromEntries(SENDER_FIELDS.map((f) => [f, null])) as SenderBlockV1;
}

/**
 * Run the initialisation for the given argv and environment. Returns the
 * result; `log` receives field names and counters, never sender values.
 */
export async function runBooksInitCompany(
  argv: string[],
  env: Env,
  log: (line: string) => void,
): Promise<InitBooksCompanyResult> {
  const { values } = parseArgs({
    args: argv,
    options: {
      'tenant-group': { type: 'string' },
      tenant: { type: 'string' },
      sender: { type: 'string' },
      'tax-status': { type: 'string' },
      counter: { type: 'string', multiple: true },
      'payment-terms': { type: 'string' },
      'exemption-note': { type: 'string' },
      'sender-file-only': { type: 'boolean', default: false },
    },
    strict: true,
  });
  const tenantGroupId = values['tenant-group'] ?? fail('--tenant-group is required');
  const tenantId = values.tenant ?? fail('--tenant is required');
  const senderFile = values.sender ?? fail('--sender is required');
  const taxStatus = values['tax-status'];
  if (taxStatus !== 'small_business' && taxStatus !== 'regular') fail('--tax-status must be small_business or regular');
  const counters = (values.counter ?? []).map(parseCounter);
  if (counters.length === 0) fail('at least one --counter is required (formats are company configuration)');

  const fromFile = senderBlockV1Schema.partial().strict().parse(JSON.parse(readFileSync(senderFile, 'utf8')));
  const sender: SenderBlockV1 = { ...emptySender(), ...fromFile };

  if (!values['sender-file-only']) {
    const t = await readAuthBrainTenant(env, tenantGroupId, tenantId);
    const fromAuthBrain: Partial<SenderBlockV1> = {
      legalName: t.legal_name,
      vatId: t.vat_id,
      addressLine1: t.billing_address?.street ?? null,
      postalCode: t.billing_address?.postal_code ?? null,
      city: t.billing_address?.city ?? null,
      countryCode: t.billing_address?.country ?? null,
    };
    for (const [field, value] of Object.entries(fromAuthBrain) as Array<[keyof SenderBlockV1, string | null]>) {
      if (value === null || value.trim() === '') continue;
      if (fromFile[field] != null && fromFile[field] !== value) {
        log(`note: ${field} comes from auth-brain; the file's value is ignored`);
      }
      sender[field] = value;
    }
  }

  const connectionString = env.COMMERCE_APP_DATABASE_URL ?? fail('COMMERCE_APP_DATABASE_URL is not set');
  const base = createNodeDb<CommerceDB>({ connectionString, max: 1 });
  try {
    const scope = booksScope(tenantDb(base, tenantGroupId), tenantGroupId, tenantId);
    const result = await initBooksCompany(scope, {
      taxStatus,
      exemptionNote: values['exemption-note'],
      senderBlock: sender,
      defaultPaymentTermsDays: values['payment-terms'] ? Number(values['payment-terms']) : undefined,
      counters,
    });
    const filled = SENDER_FIELDS.filter((f) => result.settings.senderBlock[f] != null);
    log(`settings: tax status ${result.settings.taxStatus}, payment terms ${result.settings.defaultPaymentTermsDays} days`);
    log(`sender fields set: ${filled.join(', ')}`);
    for (const c of result.counters) {
      log(`counter ${c.docType}: format ${c.format}, next ${c.nextValue}${c.created ? ' (created)' : ' (existing, unchanged)'}`);
    }
    return result;
  } finally {
    await base.destroy();
  }
}


// src/server/books/__tests__/booksFixtures.ts
//
// Shared fixtures for the Books integration suites (Books plan P1.10). Not a
// test file itself (no `.test` / `.itest` suffix). They run on the shared
// Dockerized Postgres of the integration globalSetup: each suite provisions its
// own tenant group through the PRODUCTION provisioning options (the full tenant
// migration set, the commerce_app grants and the append-only REVOKE seed), and
// connects the repository as the low-privilege `commerce_app` role, exactly as
// the app does. An owner-scoped handle is kept for seeding and for proving that
// the freeze triggers bind the owner too.
//
// All data is synthetic: invented names, addresses and amounts.

import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { tenantDb, type TenantGroupId } from '@marlinjai/tenant-db';

import type { CommerceDB } from '../../commerce/db-types';
import {
  openCommerceAppBase,
  openStorefrontFixtures,
  provisionCommerceTenant,
  type StorefrontFixtures,
} from '../../commerce/__tests__/storefrontFixtures';
import { createCustomer, type Customer } from '../repository/customers';
import { contactIdentityKey } from '@marlinjai/contacts-core';

import type { ContactBook, NewContactInput } from '../contactBook';
import { BooksError } from '../errors';
import type { RecipientContact, RecipientDirectory } from '../recipients';
import { booksScope, type BooksScope } from '../scope';
import { initBooksCompany } from '../settings';
import type { SenderBlockV1 } from '../snapshots';

export interface BooksEnv {
  fx: StorefrontFixtures;
  tgId: TenantGroupId;
  schema: string;
  /** Owner-scoped handle into tg_<id> (seeding, owner-role assertions). */
  ownerDb: Kysely<CommerceDB>;
  /** The commerce_app base the repository runs on. */
  appBase: Kysely<CommerceDB>;
  /** commerce_app-scoped handle into tg_<id>. */
  appDb: Kysely<CommerceDB>;
  close(): Promise<void>;
}

export async function openBooksEnv(slug: string): Promise<BooksEnv> {
  const fx = openStorefrontFixtures();
  const tenant = await provisionCommerceTenant(fx, slug);
  const appBase = openCommerceAppBase();
  return {
    fx,
    tgId: tenant.tgId,
    schema: tenant.schema,
    ownerDb: tenant.db,
    appBase,
    appDb: tenantDb(appBase, tenant.tgId),
    async close() {
      await appBase.destroy();
      await fx.close();
    },
  };
}

/** Provision one more tenant group on the same fixtures. */
export async function provisionAnotherGroup(env: BooksEnv, slug: string) {
  const t = await provisionCommerceTenant(env.fx, slug);
  return { tgId: t.tgId, schema: t.schema, ownerDb: t.db, appDb: tenantDb(env.appBase, t.tgId) };
}

/** A fake contacts directory: contacts per company, and a switch to make it fail. */
export class FakeDirectory implements RecipientDirectory {
  private readonly contacts = new Map<string, { tenantId: string; contact: RecipientContact }>();
  failing = false;
  calls = 0;

  add(tenantId: string, overrides: Partial<RecipientContact> = {}): RecipientContact {
    const contact: RecipientContact = {
      id: randomUUID(),
      kind: 'organization',
      name: 'Sample Customer GmbH',
      companyOrRole: '',
      legalForm: 'GmbH',
      addressLine1: 'Beispielweg 2',
      addressLine2: null,
      postalCode: '20095',
      city: 'Hamburg',
      country: 'DE',
      vatId: null,
      customerNumber: null,
      archived: false,
      ...overrides,
    };
    this.contacts.set(contact.id, { tenantId, contact });
    return contact;
  }

  update(contactId: string, patch: Partial<RecipientContact>): void {
    const entry = this.contacts.get(contactId);
    if (!entry) throw new Error('FakeDirectory: no such contact');
    entry.contact = { ...entry.contact, ...patch };
  }

  async getContact(tenantId: string, contactId: string): Promise<RecipientContact | null> {
    this.calls += 1;
    if (this.failing) throw new Error('synthetic contacts outage');
    const entry = this.contacts.get(contactId);
    return entry && entry.tenantId === tenantId ? { ...entry.contact } : null;
  }

  /** The company's contacts (tests only). */
  contactsOf(tenantId: string): RecipientContact[] {
    return [...this.contacts.values()].filter((e) => e.tenantId === tenantId).map((e) => ({ ...e.contact }));
  }
}

/**
 * The contact book over the fake directory (create, getMany, search,
 * findSame), with the package's identity rule: one contact per kind and
 * normalized name (plus company or role for a person) and company.
 */
export class FakeContactBook implements ContactBook {
  constructor(private readonly dir: FakeDirectory) {}
  readonly created: RecipientContact[] = [];
  private outage(): void {
    // As the production book does: any failure of the database is RECIPIENT_UNAVAILABLE.
    if (this.dir.failing) throw new BooksError('RECIPIENT_UNAVAILABLE', 'synthetic contacts outage');
  }
  /** As the package does: the company's contacts whose name contains the search (case ignored), archived left out. */
  async search(tenantId: string, opts: { search?: string; limit: number } = { limit: 50 }): Promise<RecipientContact[]> {
    this.outage();
    const needle = (opts.search ?? '').trim().toLowerCase();
    return this.dir
      .contactsOf(tenantId)
      .filter((c) => !c.archived && (needle === '' || c.name.toLowerCase().includes(needle)))
      .slice(0, opts.limit);
  }
  async getMany(tenantId: string, ids: readonly string[]): Promise<RecipientContact[]> {
    this.outage();
    const out: RecipientContact[] = [];
    for (const id of ids) {
      const c = await this.dir.getContact(tenantId, id);
      if (c) out.push(c);
    }
    return out;
  }
  async findSame(
    tenantId: string,
    identity: { kind: 'person' | 'organization'; name: string; companyOrRole?: string | null },
  ): Promise<RecipientContact | null> {
    this.outage();
    const key = contactIdentityKey(identity.kind, identity.name, identity.companyOrRole ?? '');
    return (
      this.dir.contactsOf(tenantId).find((c) => c.kind === identity.kind && contactIdentityKey(c.kind, c.name, c.companyOrRole) === key) ?? null
    );
  }
  async create(tenantId: string, input: NewContactInput): Promise<RecipientContact> {
    this.outage();
    const same = await this.findSame(tenantId, { kind: input.kind, name: input.name, companyOrRole: input.companyOrRole ?? '' });
    if (same) {
      throw new BooksError('DUPLICATE_CONTACT', 'DUPLICATE_CONTACT: a contact with this name already exists', {
        existingContactId: same.id,
      });
    }
    const c = this.dir.add(tenantId, {
      kind: input.kind,
      name: input.name,
      companyOrRole: input.companyOrRole ?? '',
      legalForm: input.legalForm ?? null,
      addressLine1: input.addressLine1 ?? null,
      addressLine2: input.addressLine2 ?? null,
      postalCode: input.postalCode ?? null,
      city: input.city ?? null,
      country: input.country ?? null,
      vatId: input.vatId ?? null,
    });
    this.created.push({ ...c, tenantId } as RecipientContact);
    return c;
  }
}

export function newTenantId(): string {
  return randomUUID();
}

export function scopeFor(db: Kysely<CommerceDB>, tgId: string, tenantId: string, dir: RecipientDirectory): BooksScope {
  return booksScope(db, tgId, tenantId, { recipients: dir });
}

export function syntheticSender(overrides: Partial<SenderBlockV1> = {}): SenderBlockV1 {
  return {
    legalName: 'Example Studio',
    addressLine1: 'Musterstrasse 1',
    addressLine2: null,
    postalCode: '10115',
    city: 'Berlin',
    countryCode: 'DE',
    taxNumber: '12/345/67890',
    // A synthetic VAT id, so a regular company can also issue reverse-charge invoices.
    vatId: 'DE123456789',
    smallBusinessId: null,
    email: 'billing@example.invalid',
    phone: null,
    website: null,
    bankName: 'Example Bank',
    iban: null,
    bic: null,
    registerCourt: null,
    registerNumber: null,
    managingDirector: null,
    ...overrides,
  };
}

/** Initialise a company: invoice `{n}` from `invoiceNext` (default 62), credit notes `GS-{n}` from 1. */
export async function initCompany(
  scope: BooksScope,
  opts: { taxStatus?: 'small_business' | 'regular'; invoiceNext?: number; exemptionNote?: string } = {},
) {
  return initBooksCompany(scope, {
    taxStatus: opts.taxStatus ?? 'small_business',
    exemptionNote: opts.exemptionNote,
    senderBlock: syntheticSender(),
    counters: [
      { docType: 'invoice', format: '{n}', nextValue: opts.invoiceNext ?? 62 },
      { docType: 'credit_note', format: 'GS-{n}', nextValue: 1 },
      { docType: 'offer', format: 'ANG-{n}', nextValue: 1 },
    ],
  });
}

/** A contact in the fake directory plus its customer row. */
export async function newCustomer(
  scope: BooksScope,
  dir: FakeDirectory,
  opts: {
    customerType?: 'b2c' | 'b2b';
    vatId?: string | null;
    countryCode?: string;
    contact?: Partial<RecipientContact>;
  } = {},
): Promise<{ customer: Customer; contact: RecipientContact }> {
  const contact = dir.add(scope.tenantId, {
    kind: opts.customerType === 'b2c' ? 'person' : 'organization',
    legalForm: opts.customerType === 'b2c' ? null : 'GmbH',
    ...opts.contact,
  });
  const customer = await createCustomer(scope, {
    contactId: contact.id,
    customerType: opts.customerType ?? 'b2b',
    vatId: opts.vatId ?? null,
    countryCode: opts.countryCode ?? 'DE',
  });
  return { customer, contact };
}

/** Today's calendar day in Europe/Berlin (the default issue date). */
export { berlinToday } from '../numbering';

/** The SQLSTATE a promise rejects with (fails the test when it resolves). */
export async function rejectionCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? code : `no code: ${String(err)}`;
  }
  throw new Error('expected a rejection, the promise resolved');
}

export const ACTOR = '0190a000-0000-7000-8000-00000000a11c';

// src/server/books/scope.ts
//
// The scope every Books function takes first (Books plan P1.1, layer 3 of the
// tenant enforcement). It carries the scoped handle of one tenant group's schema
// (`commerceTenantDb(tgId)`, the schema wall) and the auth-brain company id the
// rows belong to: every query filters `tenant_id = scope.tenantId` and every
// insert writes it, so a row of another company in the same schema reads as
// NOT_FOUND, never as a permission error that would confirm it exists.
//
// Phase 2's routes build the scope once per request from the session's active
// company after the `books` grant check; phase 1 takes it as an argument.

import type { Kysely } from 'kysely';
import { assertTenantGroupId, type TenantGroupId } from '@marlinjai/tenant-db';

import type { CommerceDB } from '../commerce/db-types';
import { BooksError } from './errors';
import type { RecipientDirectory } from './recipients';

export interface BooksScope {
  /** The scoped handle into `tg_<id>` (never the base handle). */
  readonly db: Kysely<CommerceDB>;
  readonly tgId: TenantGroupId;
  /** The auth-brain company id (a lowercase uuid). */
  readonly tenantId: string;
  /**
   * Where the recipients' names and addresses come from. Defaults to the shared
   * contacts database (opened lazily on first use); tests pass a fake.
   */
  readonly recipients?: RecipientDirectory;
}

const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Build the scope for one company. The tenant group id goes through the
 * tenant-db chokepoint; the company id must be a lowercase uuid (the shape the
 * `tenant_id` CHECK enforces).
 */
export function booksScope(
  db: Kysely<CommerceDB>,
  tgId: string,
  tenantId: string,
  options: { recipients?: RecipientDirectory } = {},
): BooksScope {
  const group = assertTenantGroupId(tgId);
  if (typeof tenantId !== 'string' || !TENANT_ID.test(tenantId)) {
    throw new BooksError('INVALID_INPUT', 'INVALID_INPUT: tenantId', {
      issues: [{ path: 'tenantId', message: 'expected a lowercase uuid' }],
    });
  }
  return Object.freeze({ db, tgId: group, tenantId, recipients: options.recipients });
}

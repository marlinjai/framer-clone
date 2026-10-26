// src/server/catalog/scope.ts
//
// The scope every catalogue function takes first: the scoped handle of one
// tenant group's schema (`commerceTenantDb(tgId)`, the schema wall) and the
// auth-brain company the rows belong to. Every query filters
// `tenant_id = scope.tenantId` and every insert writes it, so a product of
// another company in the same schema reads as NOT_FOUND, never as a
// permission error that would confirm it exists (the Books' rule, 020's
// composite foreign keys underneath).

import type { Kysely } from 'kysely';
import { assertTenantGroupId, type TenantGroupId } from '@marlinjai/tenant-db';

import type { CommerceDB } from '../commerce/db-types';
import { invalidField } from './errors';

export interface CatalogScope {
  /** The scoped handle into `tg_<id>` (never the base handle). */
  readonly db: Kysely<CommerceDB>;
  readonly tgId: TenantGroupId;
  /** The auth-brain company id (a lowercase uuid). */
  readonly tenantId: string;
}

const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Build the scope for one company (the tenant group through the tenant-db chokepoint). */
export function catalogScope(db: Kysely<CommerceDB>, tgId: string, tenantId: string): CatalogScope {
  const group = assertTenantGroupId(tgId);
  if (typeof tenantId !== 'string' || !TENANT_ID.test(tenantId)) {
    throw invalidField('tenantId', 'expected a lowercase uuid');
  }
  return Object.freeze({ db, tgId: group, tenantId });
}

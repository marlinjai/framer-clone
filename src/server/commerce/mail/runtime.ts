import 'server-only';

// src/server/commerce/mail/runtime.ts
//
// The shop mail as the running server uses it (docs/plans/2026-10-27-shop-receipt-email.md): the outbox's
// dependencies for one tenant group, the first attempt after a payment (started, never awaited: the payment
// never waits for it), and the sweep every minute over every tenant group that has a site.

import type { Kysely } from 'kysely';

import { getPrismaClient } from '@/server/db';
import { normalizeSiteSettings, effectiveSiteName } from '@/lib/site/siteSettings';
import { commerceTenantDb, isCommerceTenantNotProvisioned } from '../db';
import type { CommerceDB } from '../db-types';
import { receiptLinkBase, receiptLinkKey, shopMailConfig } from './config';
import { createLumitraMail, type LumitraMail } from './lumitraMail';
import { deliverShopMail, sweepShopMail, type OutboxDeps, type SiteInfo } from './outbox';
import type { ShopMailKind } from './templates';

const SWEEP_EVERY_MS = 60_000;

const globalForShopMail = globalThis as unknown as { __shopMailClient?: LumitraMail | null; __shopMailSweep?: NodeJS.Timeout };

/** The Lumitra Mail client of this platform, or null while it is not configured. */
export function platformLumitraMail(): LumitraMail | null {
  if (globalForShopMail.__shopMailClient === undefined) {
    const config = shopMailConfig();
    globalForShopMail.__shopMailClient = config ? createLumitraMail(config) : null;
  }
  return globalForShopMail.__shopMailClient;
}

/** The published site's name and language, for the letter. */
export async function siteInfo(siteId: string): Promise<SiteInfo | null> {
  const site = await getPrismaClient().site.findUnique({ where: { id: siteId }, select: { name: true, siteSettings: true } });
  if (!site) return null;
  const settings = normalizeSiteSettings(site.siteSettings);
  return { name: effectiveSiteName(settings, site.name), language: settings.language };
}

export function outboxDeps(db: Kysely<CommerceDB>, tenantGroupId: string): OutboxDeps {
  return {
    db,
    tenantGroupId,
    mail: platformLumitraMail(),
    sealKey: shopMailConfig()?.sealKey ?? null,
    linkKey: receiptLinkKey(),
    linkBase: receiptLinkBase(),
    siteInfo,
  };
}

/**
 * After a payment: start the first attempt at the letter the payment wrote, and return at once. The payment never
 * waits for Lumitra Mail; whatever this attempt cannot send, the sweep sends.
 */
export function deliverShopMailSoon(
  db: Kysely<CommerceDB>,
  tenantGroupId: string,
  tenantId: string,
  orderId: string,
  kind: ShopMailKind,
): void {
  void deliverShopMail(outboxDeps(db, tenantGroupId), tenantId, orderId, kind).catch((err: unknown) => {
    console.error(`[shop-mail] ${kind} of order ${orderId} could not be attempted:`, err);
  });
}

/** One pass over every tenant group that has a site. */
export async function sweepAllShopMail(): Promise<void> {
  const groups = await getPrismaClient().site.findMany({ distinct: ['tenantGroupId'], select: { tenantGroupId: true } });
  for (const { tenantGroupId } of groups) {
    try {
      await sweepShopMail(outboxDeps(commerceTenantDb(tenantGroupId), tenantGroupId));
    } catch (err) {
      // A tenant group without its schema yet has nothing to send; anything else is logged and the next pass tries.
      if (isCommerceTenantNotProvisioned(err) || /relation "[^"]*shop_mail" does not exist/.test(String(err))) continue;
      console.error(`[shop-mail] the sweep of tenant group ${tenantGroupId} failed:`, err);
    }
  }
}

/** Start the sweep once per server process (instrumentation.ts), only when Lumitra Mail is configured. */
export function startShopMailSweep(): void {
  if (globalForShopMail.__shopMailSweep || !platformLumitraMail()) return;
  let running = false;
  globalForShopMail.__shopMailSweep = setInterval(() => {
    if (running) return;
    running = true;
    sweepAllShopMail()
      .catch((err: unknown) => console.error('[shop-mail] the sweep failed:', err))
      .finally(() => {
        running = false;
      });
  }, SWEEP_EVERY_MS);
  globalForShopMail.__shopMailSweep.unref?.();
}

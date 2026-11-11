import 'server-only';

// src/server/commerce/mail/runtime.ts
//
// The shop mail as the running server uses it (docs/plans/2026-10-27-shop-receipt-email.md): the outbox's
// dependencies for one tenant group, which the job worker hands to the `shop_mail` handler (jobs/run.ts).

import type { Kysely } from 'kysely';

import { getPrismaClient } from '@/server/db';
import { parseRevisionDocument } from '@/server/sites/revision';
import { normalizeSiteSettings, effectiveSiteName } from '@/lib/site/siteSettings';
import type { CommerceDB } from '../db-types';
import { receiptLinkBase, receiptLinkKey, shopMailConfig } from './config';
import { createLumitraMail, type LumitraMail } from './lumitraMail';
import type { OutboxDeps, SiteInfo } from './outbox';

const globalForShopMail = globalThis as unknown as { __shopMailClient?: LumitraMail | null };

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
  const site = await getPrismaClient().site.findUnique({
    where: { id: siteId },
    select: { name: true, siteSettings: true, publishedRevision: { select: { document: true } } },
  });
  if (!site) return null;
  // What visitors see, never a saved setting that was not published. A site with no revision yet serves its rows.
  const frozen = site.publishedRevision ? parseRevisionDocument(site.publishedRevision.document) : null;
  const settings = frozen?.siteSettings ?? normalizeSiteSettings(site.siteSettings);
  return { name: effectiveSiteName(settings, frozen?.name ?? site.name), language: settings.language };
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

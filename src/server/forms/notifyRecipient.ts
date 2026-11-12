import 'server-only';

// src/server/forms/notifyRecipient.ts
//
// Who is emailed about a form's submissions, from a published site: the form's own address, else the site's contact email
// (docs/plans/2026-10-23-published-site-essentials.md, "Form notification emails"). One rule for the two places that ask:
// the submit endpoint when a submission arrives (submit.ts) and the owner's "send again" (the resend route), so a fix the
// owner published reaches a submission sent before it.

import { chooseNotifyRecipient, readFormSettings } from '@/lib/forms/definition';
import { resolvePublishedSiteById, type PublishedSite } from '@/server/sites/publicResolver';
import { locateForm } from './submit';

type SiteForRecipient = Pick<PublishedSite, 'pages' | 'components'> & Partial<Pick<PublishedSite, 'siteId' | 'revision'>> & {
  siteSettings: { business: { email: string } };
};

/** The address for one form of a published site, or null when neither the form nor the site names one. */
export function recipientFor(site: SiteForRecipient, formId: string): string | null {
  const located = locateForm(site, formId);
  const own = located ? readFormSettings(located.form.props).notifyEmail : '';
  return chooseNotifyRecipient(own, site.siteSettings.business.email);
}

/** The address a form's notifications go to NOW, from the live published site (null: none, or the site is not published). */
export async function currentRecipient(siteId: string, formId: string): Promise<string | null> {
  const site = await resolvePublishedSiteById(siteId);
  return site ? recipientFor(site as unknown as SiteForRecipient, formId) : null;
}

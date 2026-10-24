// src/lib/site/siteSettings.ts
//
// The Site settings object (plan docs/plans/2026-10-23-published-site-essentials.md,
// decision 1): one per project, everything a published site needs to say about
// itself that is not a page. PURE: no MST, no Prisma, no React, so the editor,
// the save path, the published renderer, the generator and the tests share one
// shape and one parser.
//
// Where it lives:
//   - MST: ProjectModel.siteSettings, a frozen value replaced as a whole by
//     ProjectModel.updateSiteSettings (one undo step per dialog save).
//   - Database: the `sites.site_settings` JSONB column (one column for the whole
//     object, so a new field never needs a migration).
//   - Yjs: one JSON blob under YJS_PROJECT_KEYS.siteSettings.
//   - Published: PublishedSite.siteSettings, always normalized.
//
// Adding a field: add it to SiteSettings, to DEFAULT_SITE_SETTINGS and to
// normalizeSiteSettings (and, when it has rules, to validateSiteSettings).
// Nothing else in the persistence chain changes.
//
// Every stored value goes through normalizeSiteSettings on the way in AND on the
// way out, so a blob written by an older or newer build (missing fields, wrong
// types, unknown keys) never reaches the renderer in a shape it cannot handle.

/** Days in schema.org order, used by the opening-hours rows. */
export const WEEKDAYS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** One opening-hours row: these days, from `opens` to `closes` (24h "HH:MM"). */
export interface OpeningHoursRow {
  days: Weekday[];
  opens: string;
  closes: string;
}

/** The business and contact data (Impressum, footer, JSON-LD, generator). */
export interface BusinessInfo {
  /** The registered name, e.g. "Bäckerei Müller GmbH". */
  legalName: string;
  street: string;
  postalCode: string;
  city: string;
  /** ISO 3166-1 alpha-2, uppercase ("DE"). */
  country: string;
  phone: string;
  email: string;
  openingHours: OpeningHoursRow[];
  /** Umsatzsteuer-Identifikationsnummer / VAT ID. */
  vatId: string;
  /** Commercial register entry, e.g. "Amtsgericht München, HRB 12345". */
  registerEntry: string;
  managingDirectors: string[];
}

export const TWITTER_CARDS = ['summary_large_image', 'summary'] as const;
export type TwitterCard = (typeof TWITTER_CARDS)[number];

export interface SiteSettings {
  /**
   * The public name of the site (title template, Open Graph site name, JSON-LD,
   * 404 page). Blank means "use the project title": the project title is what
   * the dashboard and the rename flow own, this is only an override for when
   * the public brand differs from the working title.
   */
  siteName: string;
  /** BCP 47 language tag: `<html lang>` and the generator's copy language. */
  language: string;
  /** https URL of the favicon (PNG, SVG or ICO). Blank: no site icon. */
  faviconUrl: string;
  /** https URL of the default Open Graph image (a page's own image wins). */
  ogImageUrl: string;
  twitterCard: TwitterCard;
  /**
   * Browser title template, `%s` standing for the page title. Blank means the
   * default "%s | <site name>".
   */
  titleTemplate: string;
  /** The page served (with status 404) for unknown paths. Blank: the default 404. */
  notFoundPageId: string;
  business: BusinessInfo;
  /**
   * Lenis smooth scrolling on the preview and the published pages (never the
   * editor canvas). Off by default and always off for visitors who ask for
   * reduced motion. See docs/plans/2026-10-23-motion-effects.md.
   */
  smoothScroll: boolean;
}

/** The input to persistence and to ProjectModel: any subset, normalized on read. */
export type SiteSettingsInput = Partial<Omit<SiteSettings, 'business'>> & {
  business?: Partial<BusinessInfo>;
};

/**
 * Projects saved before Site settings existed load with `en`, the language
 * every published page has always declared (the root layout hardcoded it), so
 * nothing changes for them. New projects start with `de` (see
 * NEW_PROJECT_SITE_SETTINGS): the product is built for German businesses first.
 */
export const DEFAULT_LANGUAGE = 'en';

export const DEFAULT_TITLE_TEMPLATE_TOKEN = '%s';

export const EMPTY_BUSINESS: BusinessInfo = {
  legalName: '',
  street: '',
  postalCode: '',
  city: '',
  country: '',
  phone: '',
  email: '',
  openingHours: [],
  vatId: '',
  registerEntry: '',
  managingDirectors: [],
};

export const DEFAULT_SITE_SETTINGS: SiteSettings = {
  siteName: '',
  language: DEFAULT_LANGUAGE,
  faviconUrl: '',
  ogImageUrl: '',
  twitterCard: 'summary_large_image',
  titleTemplate: '',
  notFoundPageId: '',
  business: EMPTY_BUSINESS,
  smoothScroll: false,
};

/** What a project created from now on starts with. */
export const NEW_PROJECT_SITE_SETTINGS: SiteSettingsInput = { language: 'de' };

/** Caps, so a stored blob can never grow without bound. */
export const SITE_SETTINGS_LIMITS = {
  text: 200,
  url: 2048,
  openingHoursRows: 14,
  managingDirectors: 10,
} as const;

function str(value: unknown, max: number = SITE_SETTINGS_LIMITS.text): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeHours(value: unknown): OpeningHoursRow[] {
  if (!Array.isArray(value)) return [];
  const rows: OpeningHoursRow[] = [];
  for (const raw of value.slice(0, SITE_SETTINGS_LIMITS.openingHoursRows)) {
    if (!isRecord(raw)) continue;
    const days = Array.isArray(raw.days)
      ? WEEKDAYS.filter((d) => (raw.days as unknown[]).includes(d))
      : [];
    rows.push({ days, opens: str(raw.opens, 5), closes: str(raw.closes, 5) });
  }
  return rows;
}

function normalizeBusiness(value: unknown): BusinessInfo {
  const b = isRecord(value) ? value : {};
  return {
    legalName: str(b.legalName),
    street: str(b.street),
    postalCode: str(b.postalCode, 20),
    city: str(b.city),
    country: str(b.country, 2).toUpperCase(),
    phone: str(b.phone, 40),
    email: str(b.email),
    openingHours: normalizeHours(b.openingHours),
    vatId: str(b.vatId, 40),
    registerEntry: str(b.registerEntry),
    managingDirectors: Array.isArray(b.managingDirectors)
      ? b.managingDirectors
          .map((n) => str(n))
          .filter((n) => n.length > 0)
          .slice(0, SITE_SETTINGS_LIMITS.managingDirectors)
      : [],
  };
}

/**
 * Any stored or submitted value -> a complete SiteSettings. Wrong types fall
 * back to the defaults, unknown keys are dropped, strings are trimmed and
 * capped. It never throws. Values are NOT validated here (an invalid URL stays
 * a string): validation is validateSiteSettings, and every renderer re-checks
 * what it emits (isHttpsUrl) so a bad value is left out, never printed.
 */
export function normalizeSiteSettings(raw: unknown): SiteSettings {
  const s = isRecord(raw) ? raw : {};
  const language = str(s.language, 35);
  const twitterCard = TWITTER_CARDS.includes(s.twitterCard as TwitterCard)
    ? (s.twitterCard as TwitterCard)
    : DEFAULT_SITE_SETTINGS.twitterCard;
  return {
    siteName: str(s.siteName),
    language: language || DEFAULT_LANGUAGE,
    faviconUrl: str(s.faviconUrl, SITE_SETTINGS_LIMITS.url),
    ogImageUrl: str(s.ogImageUrl, SITE_SETTINGS_LIMITS.url),
    twitterCard,
    titleTemplate: str(s.titleTemplate),
    notFoundPageId: str(s.notFoundPageId),
    business: normalizeBusiness(s.business),
    smoothScroll: s.smoothScroll === true,
  };
}

// ---------------------------------------------------------------------------
// Validation (the dialog and ProjectModel.updateSiteSettings)
// ---------------------------------------------------------------------------

/** A BCP 47 tag in the common shape: language, optional script, optional region. */
const BCP47 = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|\d{3}))?$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[0-9 ()/.-]{5,40}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const COUNTRY = /^[A-Z]{2}$/;

/** True for an absolute https URL (what a favicon or Open Graph image must be). */
export function isHttpsUrl(value: string): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.length > 0;
  } catch {
    return false;
  }
}

/** True when `tag` is a usable BCP 47 language tag ("de", "en-GB", "zh-Hant-TW"). */
export function isLanguageTag(tag: string): boolean {
  return BCP47.test(tag);
}

/** Field path -> message. Keys: `language`, `business.email`, `business.openingHours.0`, ... */
export type SiteSettingsErrors = Record<string, string>;

/** Every problem with a settings object, in plain language. Empty when valid. */
export function validateSiteSettings(settings: SiteSettings): SiteSettingsErrors {
  const errors: SiteSettingsErrors = {};
  if (!isLanguageTag(settings.language)) {
    errors.language = 'Use a language code like de, en or en-GB.';
  }
  if (settings.faviconUrl && !isHttpsUrl(settings.faviconUrl)) {
    errors.faviconUrl = 'Enter a full https:// address of an image.';
  }
  if (settings.ogImageUrl && !isHttpsUrl(settings.ogImageUrl)) {
    errors.ogImageUrl = 'Enter a full https:// address of an image.';
  }
  if (settings.titleTemplate) {
    const count = settings.titleTemplate.split(DEFAULT_TITLE_TEMPLATE_TOKEN).length - 1;
    if (count !== 1) errors.titleTemplate = 'Include %s exactly once, where the page title goes.';
  }

  const b = settings.business;
  if (b.email && !EMAIL.test(b.email)) errors['business.email'] = 'Enter an email address like hello@example.com.';
  if (b.phone && !PHONE.test(b.phone)) {
    errors['business.phone'] = 'Use digits, spaces and + ( ) / - only, like +49 89 1234567.';
  }
  if (b.country && !COUNTRY.test(b.country)) {
    errors['business.country'] = 'Use the two-letter country code, like DE or AT.';
  }
  // An address is all or nothing: a half address in the footer or in the
  // search engine data is worse than none.
  const addressParts = [b.street, b.postalCode, b.city, b.country];
  if (addressParts.some(Boolean) && !addressParts.every(Boolean)) {
    if (!b.street) errors['business.street'] = 'Add the street to complete the address.';
    if (!b.postalCode) errors['business.postalCode'] = 'Add the postcode to complete the address.';
    if (!b.city) errors['business.city'] = 'Add the city to complete the address.';
    if (!b.country) errors['business.country'] = 'Add the country to complete the address.';
  }
  b.openingHours.forEach((row, i) => {
    const key = `business.openingHours.${i}`;
    if (row.days.length === 0) errors[key] = 'Pick at least one day.';
    else if (!TIME.test(row.opens) || !TIME.test(row.closes)) errors[key] = 'Use times like 09:00 and 18:00.';
    else if (row.closes <= row.opens) errors[key] = 'Closing time must be after opening time.';
  });
  return errors;
}

// ---------------------------------------------------------------------------
// Helpers the renderer and the generator share
// ---------------------------------------------------------------------------

/** The public site name: the override, else the project title. */
export function effectiveSiteName(settings: SiteSettings, projectTitle: string): string {
  return settings.siteName || projectTitle.trim();
}

/**
 * The title template Next's metadata uses (`%s` is the page title): the
 * custom one, else "%s | <site name>", else just the page title.
 */
export function effectiveTitleTemplate(settings: SiteSettings, siteName: string): string {
  if (settings.titleTemplate) return settings.titleTemplate;
  return siteName ? `%s | ${siteName}` : '%s';
}

/** Apply a template to a page title (used where Next does not, e.g. tests and Open Graph). */
export function applyTitleTemplate(template: string, pageTitle: string): string {
  return template.replace(DEFAULT_TITLE_TEMPLATE_TOKEN, pageTitle);
}

/** True when the business has a complete postal address. */
export function hasAddress(b: BusinessInfo): boolean {
  return Boolean(b.street && b.postalCode && b.city && b.country);
}

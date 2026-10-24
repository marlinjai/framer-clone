import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SITE_SETTINGS,
  applyTitleTemplate,
  effectiveSiteName,
  effectiveTitleTemplate,
  hasAddress,
  isHttpsUrl,
  isLanguageTag,
  normalizeSiteSettings,
  validateSiteSettings,
  type SiteSettings,
} from '../siteSettings';

function settings(over: Partial<SiteSettings> = {}, business: Partial<SiteSettings['business']> = {}): SiteSettings {
  const base = normalizeSiteSettings({});
  return { ...base, ...over, business: { ...base.business, ...business } };
}

describe('normalizeSiteSettings', () => {
  it('turns anything that is not an object into the defaults', () => {
    for (const raw of [undefined, null, 42, 'x', [], true]) {
      expect(normalizeSiteSettings(raw)).toEqual(DEFAULT_SITE_SETTINGS);
    }
  });

  it('defaults the language to en (existing projects keep what they always declared)', () => {
    expect(normalizeSiteSettings({}).language).toBe('en');
    expect(normalizeSiteSettings({ language: '   ' }).language).toBe('en');
    expect(normalizeSiteSettings({ language: 'de' }).language).toBe('de');
  });

  it('drops wrong types and unknown keys, trims and caps strings', () => {
    const out = normalizeSiteSettings({
      siteName: '  Bäckerei Müller  ',
      faviconUrl: 12,
      twitterCard: 'player',
      unknown: 'x',
      business: {
        country: 'de',
        managingDirectors: ['Anna', '', 7, '  Ben '],
        openingHours: [
          { days: ['Monday', 'Funday', 'Friday'], opens: '09:00', closes: '18:00' },
          'nonsense',
        ],
        legalName: 'x'.repeat(500),
      },
    });
    expect(out.siteName).toBe('Bäckerei Müller');
    expect(out.faviconUrl).toBe('');
    expect(out.twitterCard).toBe('summary_large_image');
    expect('unknown' in out).toBe(false);
    expect(out.business.country).toBe('DE');
    expect(out.business.managingDirectors).toEqual(['Anna', 'Ben']);
    expect(out.business.openingHours).toEqual([
      { days: ['Monday', 'Friday'], opens: '09:00', closes: '18:00' },
    ]);
    expect(out.business.legalName).toHaveLength(200);
  });

  it('is idempotent', () => {
    const once = normalizeSiteSettings({ siteName: 'A', business: { city: 'Berlin' } });
    expect(normalizeSiteSettings(once)).toEqual(once);
  });
});

describe('validateSiteSettings', () => {
  it('accepts the defaults', () => {
    expect(validateSiteSettings(settings())).toEqual({});
  });

  it('checks the language tag', () => {
    expect(isLanguageTag('de')).toBe(true);
    expect(isLanguageTag('en-GB')).toBe(true);
    expect(isLanguageTag('zh-Hant-TW')).toBe(true);
    expect(isLanguageTag('German')).toBe(false);
    expect(validateSiteSettings(settings({ language: 'deutsch' })).language).toMatch(/language code/);
  });

  it('accepts only https image addresses', () => {
    expect(isHttpsUrl('https://cdn.example.com/icon.png')).toBe(true);
    expect(isHttpsUrl('http://cdn.example.com/icon.png')).toBe(false);
    expect(isHttpsUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpsUrl('/icon.png')).toBe(false);
    const errors = validateSiteSettings(settings({ faviconUrl: 'http://x.test/a.png', ogImageUrl: 'nope' }));
    expect(errors.faviconUrl).toBeDefined();
    expect(errors.ogImageUrl).toBeDefined();
  });

  it('needs exactly one %s in a custom title template', () => {
    expect(validateSiteSettings(settings({ titleTemplate: 'Bakery' })).titleTemplate).toBeDefined();
    expect(validateSiteSettings(settings({ titleTemplate: '%s %s' })).titleTemplate).toBeDefined();
    expect(validateSiteSettings(settings({ titleTemplate: '%s · Bakery' })).titleTemplate).toBeUndefined();
  });

  it('checks email, phone and country', () => {
    const errors = validateSiteSettings(settings({}, { email: 'not-an-email', phone: 'call me', country: 'DEU' }));
    expect(errors['business.email']).toBeDefined();
    expect(errors['business.phone']).toBeDefined();
    expect(errors['business.country']).toBeDefined();
    expect(
      validateSiteSettings(settings({}, { email: 'hallo@baeckerei.de', phone: '+49 (89) 123-456' })),
    ).toEqual({});
  });

  it('wants an address complete or not at all', () => {
    const errors = validateSiteSettings(settings({}, { street: 'Hauptstr. 1' }));
    expect(Object.keys(errors).sort()).toEqual(['business.city', 'business.country', 'business.postalCode']);
    const full = settings({}, { street: 'Hauptstr. 1', postalCode: '80331', city: 'München', country: 'DE' });
    expect(validateSiteSettings(full)).toEqual({});
    expect(hasAddress(full.business)).toBe(true);
  });

  it('checks every opening-hours row', () => {
    const errors = validateSiteSettings(
      settings({}, {
        openingHours: [
          { days: [], opens: '09:00', closes: '17:00' },
          { days: ['Monday'], opens: '9', closes: '17:00' },
          { days: ['Tuesday'], opens: '18:00', closes: '09:00' },
          { days: ['Saturday'], opens: '10:00', closes: '14:00' },
        ],
      }),
    );
    expect(errors['business.openingHours.0']).toMatch(/day/);
    expect(errors['business.openingHours.1']).toMatch(/times/);
    expect(errors['business.openingHours.2']).toMatch(/after/);
    expect(errors['business.openingHours.3']).toBeUndefined();
  });
});

describe('name and title helpers', () => {
  it('uses the override, else the project title', () => {
    expect(effectiveSiteName(settings({ siteName: 'Müller' }), 'Redesign v2')).toBe('Müller');
    expect(effectiveSiteName(settings(), ' Redesign v2 ')).toBe('Redesign v2');
  });

  it('builds the default template from the site name', () => {
    expect(effectiveTitleTemplate(settings(), 'Müller')).toBe('%s | Müller');
    expect(effectiveTitleTemplate(settings(), '')).toBe('%s');
    expect(effectiveTitleTemplate(settings({ titleTemplate: '%s · x' }), 'Müller')).toBe('%s · x');
    expect(applyTitleTemplate('%s | Müller', 'Kontakt')).toBe('Kontakt | Müller');
  });
});

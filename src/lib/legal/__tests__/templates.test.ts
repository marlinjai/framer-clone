// Legal page templates: filled from the business data, a marked placeholder
// for anything missing (never an invented value), German and English, and
// platform facts stated only when the project uses them.
import { describe, expect, it } from 'vitest';
import { buildLegalTemplate, factsFromTrees, findPlaceholders, type LegalBlock, type TemplateFacts } from '../templates';
import { EMPTY_BUSINESS, type BusinessInfo } from '@/lib/site/siteSettings';
import { LEGAL_SLUGS, findLegalPage, legalLanguage } from '../legalPages';

const full: BusinessInfo = {
  ...EMPTY_BUSINESS,
  legalName: 'Bäckerei Müller GmbH',
  street: 'Hauptstr. 1',
  postalCode: '80331',
  city: 'München',
  country: 'DE',
  phone: '+49 89 1234567',
  email: 'hallo@mueller.de',
  vatId: 'DE123456789',
  registerEntry: 'Amtsgericht München, HRB 12345',
  managingDirectors: ['Anna Müller'],
};

const none: TemplateFacts = { analytics: false, unsplash: false, forms: false };
const all: TemplateFacts = { analytics: true, unsplash: true, forms: true };
const date = new Date('2026-10-24T12:00:00Z');

const text = (blocks: LegalBlock[]) =>
  blocks.map((b) => (b.kind === 'list' ? b.items.join('\n') : b.text)).join('\n');

describe('Impressum', () => {
  it('fills every field from the business data (German)', () => {
    const t = buildLegalTemplate({ kind: 'impressum', language: 'de', business: full, siteName: 'Müller', facts: none, date });
    const body = text(t.blocks);
    expect(t.title).toBe('Impressum');
    expect(body).toContain('Angaben gemäß § 5 DDG');
    expect(body).toContain('Bäckerei Müller GmbH\nHauptstr. 1\n80331 München\nDeutschland');
    expect(body).toContain('Geschäftsführung: Anna Müller');
    expect(body).toContain('Telefon: +49 89 1234567');
    expect(body).toContain('E-Mail: hallo@mueller.de');
    expect(body).toContain('Amtsgericht München, HRB 12345');
    expect(body).toContain('§ 27 a Umsatzsteuergesetz: DE123456789');
    expect(body).toContain('§ 18 Abs. 2 MStV');
    expect(body).toContain('Anna Müller\nHauptstr. 1');
    // Only the owner-judgement placeholders remain.
    expect(findPlaceholders(body).every((p) => /Prüfen|Falls zutreffend/.test(p))).toBe(true);
  });

  it('marks every missing fact with a placeholder instead of inventing it', () => {
    const t = buildLegalTemplate({ kind: 'impressum', language: 'de', business: EMPTY_BUSINESS, siteName: '', facts: none, date });
    const body = text(t.blocks);
    expect(body).toContain('[Name des Unternehmens bzw. Ihr vollständiger Name]');
    expect(body).toContain('[Straße und Hausnummer]');
    expect(body).toContain('[PLZ und Ort]');
    expect(body).toContain('[Telefonnummer]');
    expect(body).toContain('[E-Mail-Adresse]');
    expect(body).toMatch(/\[Registergericht und Registernummer[^\]]*\]/);
    expect(body).toMatch(/\[Umsatzsteuer-Identifikationsnummer, falls vorhanden[^\]]*\]/);
    expect(body).toContain('[Name und Anschrift der verantwortlichen Person]');
    expect(body).not.toMatch(/\d{5}/);
  });

  it('is English for an English site', () => {
    const t = buildLegalTemplate({ kind: 'impressum', language: 'en-GB', business: { ...full, vatId: '' }, siteName: '', facts: none, date });
    const body = text(t.blocks);
    expect(t.title).toBe('Imprint');
    expect(body).toContain('Bäckerei Müller GmbH\nHauptstr. 1\n80331 München\nGermany');
    expect(body).toContain('[VAT identification number, if you have one; otherwise delete this section]');
  });
});

describe('Privacy policy', () => {
  it('covers controller, hosting, logs, rights, authority and contact', () => {
    const t = buildLegalTemplate({ kind: 'privacy', language: 'de', business: full, siteName: 'Müller', facts: none, date });
    const body = text(t.blocks);
    expect(t.title).toBe('Datenschutzerklärung');
    expect(body).toContain('1. Verantwortlicher');
    expect(body).toContain('Hetzner Online GmbH');
    expect(body).toContain('Server-Logfiles');
    expect(body).toContain('Art. 15 DSGVO');
    expect(body).toContain('Art. 77 DSGVO');
    expect(body).toContain('[Name und Anschrift der Datenschutz-Aufsichtsbehörde Ihres Bundeslandes]');
    expect(body).toContain('hallo@mueller.de');
    expect(body).toContain('Stand: Oktober 2026');
    expect(body).toContain('Schriftarten');
    expect(body).toContain('keine Verbindung zu Google');
  });

  it('without analytics says nothing is stored that needs consent, and names no tracker', () => {
    const body = text(buildLegalTemplate({ kind: 'privacy', language: 'de', business: full, siteName: '', facts: none, date }).blocks);
    expect(body).toContain('setzt keine Cookies');
    expect(body).not.toContain('Lumitra Analytics');
    expect(body).not.toContain('Unsplash');
    expect(body).not.toContain('Kontaktformular');
  });

  it('with analytics, forms and Unsplash explains each, including consent and storage', () => {
    const body = text(buildLegalTemplate({ kind: 'privacy', language: 'de', business: full, siteName: '', facts: all, date }).blocks);
    expect(body).toContain('Lumitra Analytics');
    expect(body).toContain('Art. 6 Abs. 1 lit. a DSGVO und § 25 Abs. 1 TDDDG');
    expect(body).toContain('sessionStorage');
    expect(body).toContain('lumitra_variants_pub');
    expect(body).toContain('"lumitra-consent"');
    expect(body).toContain('Cookie-Einstellungen');
    expect(body).toContain('Kontaktformular');
    expect(body).toContain('IP-Adresse wird dabei nicht gespeichert');
    expect(body).toContain('Unsplash Inc.');
    expect(body).toContain('USA');
    expect(body).not.toContain('setzt keine Cookies');
  });

  it('English variant', () => {
    const t = buildLegalTemplate({ kind: 'privacy', language: 'en', business: EMPTY_BUSINESS, siteName: '', facts: all, date });
    const body = text(t.blocks);
    expect(t.title).toBe('Privacy policy');
    expect(body).toContain('1. Controller');
    expect(body).toContain('[Company name or your full name]');
    expect(body).toContain('Art. 6 (1) (a) GDPR and section 25 (1) TDDDG');
    expect(body).toContain('Last updated: October 2026');
  });
});

describe('Terms', () => {
  it('is a short neutral frame with clear placeholders', () => {
    const t = buildLegalTemplate({ kind: 'terms', language: 'de', business: full, siteName: '', facts: none, date });
    const body = text(t.blocks);
    expect(t.title).toBe('AGB');
    expect(body).toContain('Bäckerei Müller GmbH');
    expect(body).toContain('[Preise, enthaltene Umsatzsteuer, Zahlungsarten und Fälligkeit]');
    expect(findPlaceholders(body).length).toBeGreaterThan(5);
    const en = text(buildLegalTemplate({ kind: 'terms', language: 'en', business: EMPTY_BUSINESS, siteName: '', facts: none, date }).blocks);
    expect(en).toContain('[Company name]');
    expect(en).toContain('Right of withdrawal');
  });
});

describe('typography', () => {
  it('never uses long dashes', () => {
    for (const kind of ['impressum', 'privacy', 'terms'] as const) {
      for (const language of ['de', 'en']) {
        const body = text(buildLegalTemplate({ kind, language, business: EMPTY_BUSINESS, siteName: 'X', facts: all, date }).blocks);
        expect(body).not.toMatch(/[–—]/);
      }
    }
  });
});

describe('facts and slugs', () => {
  it('finds Unsplash images (src or background) and forms in page trees', () => {
    const trees = [
      { props: {}, children: [{ props: { src: 'https://images.unsplash.com/photo-1?w=800' } }] },
      { props: { style: { backgroundImage: 'url("https://images.unsplash.com/photo-2")' } }, children: [{ props: { 'data-form-kind': 'form' } }] },
    ];
    expect(factsFromTrees(trees, true)).toEqual({ analytics: true, unsplash: true, forms: true });
    expect(factsFromTrees([{ props: { src: 'https://example.com/a.jpg' } }], false)).toEqual(none);
  });

  it('uses stable slugs per language and finds an existing page', () => {
    expect(LEGAL_SLUGS.de).toEqual({ impressum: 'impressum', privacy: 'datenschutz', terms: 'agb' });
    expect(LEGAL_SLUGS.en).toEqual({ impressum: 'imprint', privacy: 'privacy', terms: 'terms' });
    expect(legalLanguage('de-CH')).toBe('de');
    expect(legalLanguage('fr')).toBe('en');
    expect(findLegalPage([{ slug: 'imprint' }], 'impressum')?.slug).toBe('imprint');
    expect(findLegalPage([{ slug: 'x', metadata: { legalTemplate: 'privacy' } }], 'privacy')?.slug).toBe('x');
    expect(findLegalPage([{ slug: 'about' }], 'terms')).toBeUndefined();
  });
});

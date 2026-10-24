// src/lib/legal/templates.ts
//
// Legal page templates (plan docs/plans/2026-10-23-published-site-essentials.md,
// decision 5): Impressum (section 5 DDG, formerly TMG, plus section 18 (2)
// MStV), privacy policy (DSGVO) and short neutral terms, in German and
// English. PURE: business data in, a list of content blocks out; ProjectModel
// turns the blocks into an ordinary editable page.
//
// Rules:
//   - Filled from the Site settings business data. Anything missing becomes a
//     visibly marked placeholder in square brackets naming what goes there
//     ("[Registergericht und Registernummer]"), never an invented value.
//   - Facts about the platform are stated only where they are established:
//     hosting on Hetzner servers in Germany, server logs, self-hosted fonts,
//     form submissions stored without IP addresses, Lumitra Analytics only
//     after consent (and what it stores), stock photos hotlinked from Unsplash.
//     The analytics, Unsplash and form sections appear only when the project
//     uses them (TemplateFacts), so the policy never claims what the site does
//     not do.
//   - What the owner must judge (dispute resolution, retention periods, the
//     supervisory authority, a data transfer basis) is a placeholder that says
//     what to check.
//   - They are templates, not legal advice: the editor shows that above each
//     page created from them (never published).

import { hasAddress, type BusinessInfo } from '@/lib/site/siteSettings';
import { CONSENT_STORAGE_KEY } from '@/lib/consent/consent';
import { LEGAL_TITLES, legalLanguage, type LegalKind, type LegalLanguage } from './legalPages';

export type LegalBlock =
  | { kind: 'h1'; text: string }
  | { kind: 'h2'; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'list'; items: string[] };

/** What the project uses, read off its pages and settings when the page is created. */
export interface TemplateFacts {
  /** Lumitra Analytics is enabled (it then loads only after consent). */
  analytics: boolean;
  /** Some image is hotlinked from images.unsplash.com. */
  unsplash: boolean;
  /** Some page has a form (submissions are stored per company, without IP). */
  forms: boolean;
}

export interface LegalTemplateInput {
  kind: LegalKind;
  /** The site language (BCP 47); German for `de*`, English otherwise. */
  language: string;
  business: BusinessInfo;
  /** The public site name (fallback for the business name in prose). */
  siteName: string;
  facts: TemplateFacts;
  /** "Stand" / "Last updated" date; defaults to now. */
  date?: Date;
}

export interface LegalTemplate {
  language: LegalLanguage;
  title: string;
  /** Meta description of the page. */
  description: string;
  blocks: LegalBlock[];
}

/** A visibly marked placeholder. */
export function placeholder(text: string): string {
  return `[${text}]`;
}

/** Every placeholder left in a text (what the owner still has to fill in). */
export function findPlaceholders(text: string): string[] {
  return text.match(/\[[^\]\n]{2,160}\]/g) ?? [];
}

function countryName(code: string, lang: LegalLanguage): string {
  if (!code) return '';
  try {
    return new Intl.DisplayNames([lang], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** The address as lines: street, postcode and city, country (placeholders for gaps). */
function addressLines(b: BusinessInfo, lang: LegalLanguage): string[] {
  if (hasAddress(b)) {
    return [b.street, `${b.postalCode} ${b.city}`, countryName(b.country, lang)];
  }
  return lang === 'de'
    ? [b.street || placeholder('Straße und Hausnummer'), [b.postalCode, b.city].filter(Boolean).join(' ') || placeholder('PLZ und Ort'), b.country ? countryName(b.country, lang) : placeholder('Land')]
    : [b.street || placeholder('Street and number'), [b.postalCode, b.city].filter(Boolean).join(' ') || placeholder('Postcode and city'), b.country ? countryName(b.country, lang) : placeholder('Country')];
}

function monthYear(date: Date, lang: LegalLanguage): string {
  return new Intl.DateTimeFormat(lang === 'de' ? 'de-DE' : 'en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date);
}

const HETZNER = 'Hetzner Online GmbH, Industriestr. 25, 91710 Gunzenhausen';

// ---------------------------------------------------------------------------
// Impressum
// ---------------------------------------------------------------------------

function impressumDe(b: BusinessInfo): LegalBlock[] {
  const name = b.legalName || placeholder('Name des Unternehmens bzw. Ihr vollständiger Name');
  const address = addressLines(b, 'de');
  const blocks: LegalBlock[] = [
    { kind: 'h1', text: 'Impressum' },
    { kind: 'h2', text: 'Angaben gemäß § 5 DDG' },
    { kind: 'p', text: [name, ...address].join('\n') },
    { kind: 'h2', text: 'Vertreten durch' },
    {
      kind: 'p',
      text:
        b.managingDirectors.length > 0
          ? `Geschäftsführung: ${b.managingDirectors.join(', ')}`
          : placeholder('Vertretungsberechtigte Person(en), z. B. Geschäftsführer:in; bei Einzelunternehmen diesen Abschnitt löschen'),
    },
    { kind: 'h2', text: 'Kontakt' },
    {
      kind: 'p',
      text: [`Telefon: ${b.phone || placeholder('Telefonnummer')}`, `E-Mail: ${b.email || placeholder('E-Mail-Adresse')}`].join('\n'),
    },
    { kind: 'h2', text: 'Registereintrag' },
    {
      kind: 'p',
      text: b.registerEntry
        ? `Eintragung im Register. Registergericht und Registernummer: ${b.registerEntry}`
        : placeholder('Registergericht und Registernummer, falls im Handels-, Vereins- oder Partnerschaftsregister eingetragen; sonst diesen Abschnitt löschen'),
    },
    { kind: 'h2', text: 'Umsatzsteuer-ID' },
    {
      kind: 'p',
      text: b.vatId
        ? `Umsatzsteuer-Identifikationsnummer gemäß § 27 a Umsatzsteuergesetz: ${b.vatId}`
        : placeholder('Umsatzsteuer-Identifikationsnummer, falls vorhanden; sonst diesen Abschnitt löschen'),
    },
    { kind: 'p', text: placeholder('Falls zutreffend: Aufsichtsbehörde, Berufsbezeichnung und Kammer, berufsrechtliche Regelungen; sonst diese Zeile löschen') },
    { kind: 'h2', text: 'Verantwortlich für den Inhalt nach § 18 Abs. 2 MStV' },
    {
      kind: 'p',
      text:
        b.managingDirectors.length > 0 && hasAddress(b)
          ? [b.managingDirectors[0], ...address].join('\n')
          : placeholder('Name und Anschrift der verantwortlichen Person'),
    },
    { kind: 'h2', text: 'Verbraucherstreitbeilegung' },
    {
      kind: 'p',
      text: `Wir sind nicht bereit oder verpflichtet, an Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle teilzunehmen. ${placeholder('Prüfen und anpassen, falls Sie teilnehmen')}`,
    },
  ];
  return blocks;
}

function impressumEn(b: BusinessInfo): LegalBlock[] {
  const name = b.legalName || placeholder('Company name or your full name');
  const address = addressLines(b, 'en');
  return [
    { kind: 'h1', text: 'Imprint' },
    { kind: 'h2', text: 'Information according to section 5 DDG (German Digital Services Act)' },
    { kind: 'p', text: [name, ...address].join('\n') },
    { kind: 'h2', text: 'Represented by' },
    {
      kind: 'p',
      text:
        b.managingDirectors.length > 0
          ? `Managing directors: ${b.managingDirectors.join(', ')}`
          : placeholder('Person(s) authorised to represent the company, e.g. managing director; delete this section for a sole trader'),
    },
    { kind: 'h2', text: 'Contact' },
    { kind: 'p', text: [`Phone: ${b.phone || placeholder('Phone number')}`, `Email: ${b.email || placeholder('Email address')}`].join('\n') },
    { kind: 'h2', text: 'Register entry' },
    {
      kind: 'p',
      text: b.registerEntry
        ? `Entered in the register. Register court and number: ${b.registerEntry}`
        : placeholder('Register court and register number, if registered; otherwise delete this section'),
    },
    { kind: 'h2', text: 'VAT ID' },
    {
      kind: 'p',
      text: b.vatId
        ? `VAT identification number according to section 27 a of the German VAT Act: ${b.vatId}`
        : placeholder('VAT identification number, if you have one; otherwise delete this section'),
    },
    { kind: 'p', text: placeholder('If applicable: supervisory authority, professional title and chamber, professional rules; otherwise delete this line') },
    { kind: 'h2', text: 'Responsible for the content according to section 18 (2) MStV' },
    {
      kind: 'p',
      text:
        b.managingDirectors.length > 0 && hasAddress(b)
          ? [b.managingDirectors[0], ...address].join('\n')
          : placeholder('Name and address of the responsible person'),
    },
    { kind: 'h2', text: 'Consumer dispute resolution' },
    {
      kind: 'p',
      text: `We are neither willing nor obliged to take part in dispute resolution proceedings before a consumer arbitration board. ${placeholder('Check and change this if you do take part')}`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Privacy policy
// ---------------------------------------------------------------------------

function privacyDe(b: BusinessInfo, facts: TemplateFacts, date: Date): LegalBlock[] {
  const name = b.legalName || placeholder('Name des Unternehmens bzw. Ihr vollständiger Name');
  const contact = [`Telefon: ${b.phone || placeholder('Telefonnummer')}`, `E-Mail: ${b.email || placeholder('E-Mail-Adresse')}`];
  const blocks: LegalBlock[] = [
    { kind: 'h1', text: 'Datenschutzerklärung' },
    { kind: 'p', text: 'Mit dieser Datenschutzerklärung informieren wir Sie darüber, welche personenbezogenen Daten wir beim Besuch dieser Website verarbeiten, wofür und auf welcher Rechtsgrundlage, und welche Rechte Sie haben.' },
    { kind: 'h2', text: '1. Verantwortlicher' },
    { kind: 'p', text: [name, ...addressLines(b, 'de'), ...contact].join('\n') },
    { kind: 'h2', text: '2. Hosting' },
    {
      kind: 'p',
      text: `Diese Website wird auf der Website-Plattform Lumitra betrieben. Die Server stehen in Deutschland bei der ${HETZNER}. Der Plattformanbieter verarbeitet die Daten in unserem Auftrag auf Grundlage eines Vertrags zur Auftragsverarbeitung nach Art. 28 DSGVO. ${placeholder('Anschrift des Plattformanbieters laut Auftragsverarbeitungsvertrag')}`,
    },
    { kind: 'h2', text: '3. Server-Logfiles' },
    {
      kind: 'p',
      text: 'Beim Aufruf jeder Seite verarbeitet der Server technisch notwendige Daten: Ihre IP-Adresse, Datum und Uhrzeit, die aufgerufene Adresse, die zuvor besuchte Seite (Referrer) sowie Browser und Betriebssystem. Das dient der sicheren und stabilen Auslieferung der Website und der Abwehr von Angriffen. Rechtsgrundlage ist unser berechtigtes Interesse nach Art. 6 Abs. 1 lit. f DSGVO. Die Logdaten werden nur so lange gespeichert, wie es für diese Zwecke erforderlich ist, und anschließend gelöscht.',
    },
  ];
  let n = 4;
  if (facts.analytics) {
    blocks.push(
      { kind: 'h2', text: `${n++}. Einwilligung und Reichweitenmessung (Lumitra Analytics)` },
      {
        kind: 'p',
        text: 'Mit Ihrer Einwilligung messen wir mit Lumitra Analytics, wie diese Website genutzt wird: aufgerufene Seiten, die zuvor besuchte Seite, Gerätetyp, Bildschirmgröße, Klicks und Scrolltiefe. Ohne Ihre Einwilligung wird das Messprogramm nicht geladen und nichts erfasst.',
      },
      {
        kind: 'p',
        text: 'Dafür werden nach Ihrer Einwilligung Daten auf Ihrem Gerät gespeichert: eine zufällige Sitzungskennung und die Zuordnung zu Testvarianten im Sitzungsspeicher Ihres Browsers (sessionStorage, gelöscht beim Schließen des Tabs) sowie ein Cookie mit Testvarianten (lumitra_variants_pub). Rechtsgrundlage ist Ihre Einwilligung nach Art. 6 Abs. 1 lit. a DSGVO und § 25 Abs. 1 TDDDG.',
      },
      {
        kind: 'p',
        text: `Ihre Entscheidung speichern wir im lokalen Speicher Ihres Browsers (localStorage, Eintrag "${CONSENT_STORAGE_KEY}"), damit wir Sie nicht bei jedem Seitenaufruf erneut fragen. Das ist technisch erforderlich (§ 25 Abs. 2 Nr. 2 TDDDG). Sie können Ihre Einwilligung jederzeit mit Wirkung für die Zukunft widerrufen, über den Link "Cookie-Einstellungen" im Seitenfuß.`,
      },
      { kind: 'p', text: `Anbieter von Lumitra Analytics: ${placeholder('Name und Anschrift des Anbieters laut Auftragsverarbeitungsvertrag; Ort der Datenverarbeitung prüfen')}` },
    );
  } else {
    blocks.push(
      { kind: 'h2', text: `${n++}. Cookies und Speicher auf Ihrem Gerät` },
      { kind: 'p', text: 'Diese Website setzt keine Cookies und speichert keine Daten auf Ihrem Gerät, die einer Einwilligung bedürfen. Eine Reichweitenmessung findet nicht statt.' },
    );
  }
  if (facts.forms) {
    blocks.push(
      { kind: 'h2', text: `${n++}. Kontaktformular` },
      {
        kind: 'p',
        text: `Wenn Sie uns über ein Formular auf dieser Website schreiben, verarbeiten wir die Angaben, die Sie eingeben, um Ihre Anfrage zu beantworten. Rechtsgrundlage ist Art. 6 Abs. 1 lit. b DSGVO, wenn die Anfrage einen Vertrag betrifft, sonst unser berechtigtes Interesse an der Beantwortung nach Art. 6 Abs. 1 lit. f DSGVO. Die Angaben werden auf den Servern der Plattform in Deutschland gespeichert; Ihre IP-Adresse wird dabei nicht gespeichert. Wir löschen die Angaben, wenn sie für die Bearbeitung nicht mehr erforderlich sind und keine gesetzlichen Aufbewahrungspflichten bestehen. ${placeholder('Speicherdauer prüfen und ergänzen')}`,
      },
    );
  }
  blocks.push(
    { kind: 'h2', text: `${n++}. Kontakt per E-Mail oder Telefon` },
    { kind: 'p', text: 'Wenn Sie uns per E-Mail oder Telefon kontaktieren, verarbeiten wir Ihre Angaben, um Ihr Anliegen zu bearbeiten (Art. 6 Abs. 1 lit. b bzw. lit. f DSGVO), und löschen sie, wenn sie dafür nicht mehr erforderlich sind und keine Aufbewahrungspflichten bestehen.' },
  );
  if (facts.unsplash) {
    blocks.push(
      { kind: 'h2', text: `${n++}. Bilder von Unsplash` },
      {
        kind: 'p',
        text: `Einige Bilder auf dieser Website werden direkt von den Servern von Unsplash geladen (Unsplash Inc., San Francisco, USA). Dabei erhält Unsplash Ihre IP-Adresse und technische Daten Ihres Browsers, weil Ihr Browser die Bilder dort abruft. Die Nutzungsbedingungen von Unsplash verlangen diese direkte Einbindung. Rechtsgrundlage ist unser berechtigtes Interesse an einer ansprechenden Darstellung nach Art. 6 Abs. 1 lit. f DSGVO. Dabei können Daten in die USA übermittelt werden. ${placeholder('Prüfen, ob Unsplash unter dem EU-US Data Privacy Framework zertifiziert ist, und die Grundlage der Übermittlung ergänzen')} Datenschutzerklärung von Unsplash: https://unsplash.com/privacy`,
      },
    );
  }
  blocks.push(
    { kind: 'h2', text: `${n++}. Schriftarten` },
    { kind: 'p', text: 'Die Schriftarten dieser Website werden von unserem eigenen Server ausgeliefert. Es wird keine Verbindung zu Google oder anderen Schriftanbietern hergestellt.' },
    { kind: 'h2', text: `${n++}. Ihre Rechte` },
    {
      kind: 'list',
      items: [
        'Auskunft über Ihre gespeicherten Daten (Art. 15 DSGVO)',
        'Berichtigung unrichtiger Daten (Art. 16 DSGVO)',
        'Löschung (Art. 17 DSGVO) und Einschränkung der Verarbeitung (Art. 18 DSGVO)',
        'Datenübertragbarkeit (Art. 20 DSGVO)',
        'Widerspruch gegen Verarbeitungen auf Grundlage berechtigter Interessen (Art. 21 DSGVO)',
        'Widerruf einer erteilten Einwilligung mit Wirkung für die Zukunft (Art. 7 Abs. 3 DSGVO)',
        'Beschwerde bei einer Datenschutz-Aufsichtsbehörde (Art. 77 DSGVO)',
      ],
    },
    { kind: 'p', text: `Für Ihre Anliegen genügt eine Nachricht an ${b.email || placeholder('E-Mail-Adresse')}.` },
    { kind: 'h2', text: `${n++}. Zuständige Aufsichtsbehörde` },
    { kind: 'p', text: placeholder('Name und Anschrift der Datenschutz-Aufsichtsbehörde Ihres Bundeslandes') },
    { kind: 'p', text: `Stand: ${monthYear(date, 'de')}` },
  );
  return blocks;
}

function privacyEn(b: BusinessInfo, facts: TemplateFacts, date: Date): LegalBlock[] {
  const name = b.legalName || placeholder('Company name or your full name');
  const contact = [`Phone: ${b.phone || placeholder('Phone number')}`, `Email: ${b.email || placeholder('Email address')}`];
  const blocks: LegalBlock[] = [
    { kind: 'h1', text: 'Privacy policy' },
    { kind: 'p', text: 'This privacy policy explains which personal data we process when you visit this website, for what purpose and on which legal basis, and what rights you have under the General Data Protection Regulation (GDPR).' },
    { kind: 'h2', text: '1. Controller' },
    { kind: 'p', text: [name, ...addressLines(b, 'en'), ...contact].join('\n') },
    { kind: 'h2', text: '2. Hosting' },
    {
      kind: 'p',
      text: `This website runs on the Lumitra website platform. Its servers are located in Germany at ${HETZNER}, Germany. The platform provider processes the data on our behalf under a data processing agreement according to Art. 28 GDPR. ${placeholder('Address of the platform provider as stated in the data processing agreement')}`,
    },
    { kind: 'h2', text: '3. Server log files' },
    {
      kind: 'p',
      text: 'Whenever a page is requested, the server processes technically necessary data: your IP address, date and time, the requested address, the previously visited page (referrer), and your browser and operating system. This serves the secure and stable delivery of the website and the defence against attacks. The legal basis is our legitimate interest according to Art. 6 (1) (f) GDPR. Log data is kept only as long as these purposes require and then deleted.',
    },
  ];
  let n = 4;
  if (facts.analytics) {
    blocks.push(
      { kind: 'h2', text: `${n++}. Consent and audience measurement (Lumitra Analytics)` },
      {
        kind: 'p',
        text: 'With your consent we use Lumitra Analytics to measure how this website is used: pages viewed, the previously visited page, device type, screen size, clicks and scroll depth. Without your consent the measuring script is not loaded and nothing is recorded.',
      },
      {
        kind: 'p',
        text: 'After your consent, data is stored on your device for this: a random session identifier and the assignment to test variants in your browser\'s session storage (sessionStorage, deleted when the tab is closed), and a cookie holding test variants (lumitra_variants_pub). The legal basis is your consent according to Art. 6 (1) (a) GDPR and section 25 (1) TDDDG.',
      },
      {
        kind: 'p',
        text: `We store your choice in your browser's local storage (localStorage, entry "${CONSENT_STORAGE_KEY}") so we do not ask again on every page. This is technically necessary (section 25 (2) no. 2 TDDDG). You can withdraw your consent at any time with effect for the future through the "Cookie settings" link in the footer.`,
      },
      { kind: 'p', text: `Provider of Lumitra Analytics: ${placeholder('Name and address of the provider as stated in the data processing agreement; check where the data is processed')}` },
    );
  } else {
    blocks.push(
      { kind: 'h2', text: `${n++}. Cookies and storage on your device` },
      { kind: 'p', text: 'This website sets no cookies and stores no data on your device that requires consent. No audience measurement takes place.' },
    );
  }
  if (facts.forms) {
    blocks.push(
      { kind: 'h2', text: `${n++}. Contact form` },
      {
        kind: 'p',
        text: `When you write to us through a form on this website, we process the details you enter to answer your request. The legal basis is Art. 6 (1) (b) GDPR where the request concerns a contract, otherwise our legitimate interest in answering it according to Art. 6 (1) (f) GDPR. The details are stored on the platform's servers in Germany; your IP address is not stored. We delete the details when they are no longer needed for the request and no statutory retention periods apply. ${placeholder('Check and add the retention period')}`,
      },
    );
  }
  blocks.push(
    { kind: 'h2', text: `${n++}. Contact by email or phone` },
    { kind: 'p', text: 'When you contact us by email or phone, we process your details to handle your request (Art. 6 (1) (b) or (f) GDPR) and delete them when they are no longer needed for it and no retention periods apply.' },
  );
  if (facts.unsplash) {
    blocks.push(
      { kind: 'h2', text: `${n++}. Images from Unsplash` },
      {
        kind: 'p',
        text: `Some images on this website are loaded directly from the servers of Unsplash (Unsplash Inc., San Francisco, USA). Unsplash receives your IP address and technical data about your browser, because your browser fetches the images from there. Unsplash's terms require this direct embedding. The legal basis is our legitimate interest in an appealing presentation according to Art. 6 (1) (f) GDPR. Data may be transferred to the USA in the process. ${placeholder('Check whether Unsplash is certified under the EU-US Data Privacy Framework and add the basis of the transfer')} Unsplash privacy policy: https://unsplash.com/privacy`,
      },
    );
  }
  blocks.push(
    { kind: 'h2', text: `${n++}. Fonts` },
    { kind: 'p', text: 'The fonts of this website are served from our own server. No connection to Google or any other font provider is made.' },
    { kind: 'h2', text: `${n++}. Your rights` },
    {
      kind: 'list',
      items: [
        'Access to the data stored about you (Art. 15 GDPR)',
        'Rectification of inaccurate data (Art. 16 GDPR)',
        'Erasure (Art. 17 GDPR) and restriction of processing (Art. 18 GDPR)',
        'Data portability (Art. 20 GDPR)',
        'Objection to processing based on legitimate interests (Art. 21 GDPR)',
        'Withdrawal of consent with effect for the future (Art. 7 (3) GDPR)',
        'Complaint to a data protection supervisory authority (Art. 77 GDPR)',
      ],
    },
    { kind: 'p', text: `A message to ${b.email || placeholder('Email address')} is enough for any of these.` },
    { kind: 'h2', text: `${n++}. Supervisory authority` },
    { kind: 'p', text: placeholder('Name and address of the data protection supervisory authority responsible for you') },
    { kind: 'p', text: `Last updated: ${monthYear(date, 'en')}` },
  );
  return blocks;
}

// ---------------------------------------------------------------------------
// Terms
// ---------------------------------------------------------------------------

function termsDe(b: BusinessInfo): LegalBlock[] {
  const name = b.legalName || placeholder('Name des Unternehmens');
  return [
    { kind: 'h1', text: 'Allgemeine Geschäftsbedingungen' },
    { kind: 'p', text: placeholder('Diese Vorlage ist nur ein Gerüst. Allgemeine Geschäftsbedingungen hängen von Ihrem Geschäft ab: lassen Sie sie prüfen, bevor Sie sie veröffentlichen.') },
    { kind: 'h2', text: '§ 1 Geltungsbereich' },
    { kind: 'p', text: `Diese Bedingungen gelten für alle Verträge zwischen ${name} und ihren Kundinnen und Kunden über ${placeholder('Ihre Leistungen oder Produkte')}.` },
    { kind: 'h2', text: '§ 2 Vertragspartner' },
    { kind: 'p', text: [name, ...addressLines(b, 'de'), `E-Mail: ${b.email || placeholder('E-Mail-Adresse')}`].join('\n') },
    { kind: 'h2', text: '§ 3 Vertragsschluss' },
    { kind: 'p', text: placeholder('Wie ein Vertrag zustande kommt, z. B. durch Bestellung, Buchung oder Angebot und Annahme') },
    { kind: 'h2', text: '§ 4 Preise und Zahlung' },
    { kind: 'p', text: placeholder('Preise, enthaltene Umsatzsteuer, Zahlungsarten und Fälligkeit') },
    { kind: 'h2', text: '§ 5 Leistung und Lieferung' },
    { kind: 'p', text: placeholder('Leistungsumfang, Termine, Lieferbedingungen') },
    { kind: 'h2', text: '§ 6 Widerrufsrecht' },
    { kind: 'p', text: placeholder('Widerrufsbelehrung, falls Sie Verträge mit Verbraucherinnen und Verbrauchern im Fernabsatz schließen; sonst diesen Abschnitt löschen') },
    { kind: 'h2', text: '§ 7 Haftung' },
    { kind: 'p', text: placeholder('Haftungsregelung') },
    { kind: 'h2', text: '§ 8 Schlussbestimmungen' },
    { kind: 'p', text: placeholder('Anwendbares Recht, Gerichtsstand (nur gegenüber Unternehmen), salvatorische Klausel') },
  ];
}

function termsEn(b: BusinessInfo): LegalBlock[] {
  const name = b.legalName || placeholder('Company name');
  return [
    { kind: 'h1', text: 'Terms and conditions' },
    { kind: 'p', text: placeholder('This template is only a frame. Terms depend on your business: have them reviewed before you publish them.') },
    { kind: 'h2', text: '1. Scope' },
    { kind: 'p', text: `These terms apply to all contracts between ${name} and its customers for ${placeholder('your services or products')}.` },
    { kind: 'h2', text: '2. Contracting party' },
    { kind: 'p', text: [name, ...addressLines(b, 'en'), `Email: ${b.email || placeholder('Email address')}`].join('\n') },
    { kind: 'h2', text: '3. Conclusion of contract' },
    { kind: 'p', text: placeholder('How a contract is concluded, e.g. by order, booking, or offer and acceptance') },
    { kind: 'h2', text: '4. Prices and payment' },
    { kind: 'p', text: placeholder('Prices, included VAT, payment methods and due dates') },
    { kind: 'h2', text: '5. Services and delivery' },
    { kind: 'p', text: placeholder('Scope of services, dates, delivery terms') },
    { kind: 'h2', text: '6. Right of withdrawal' },
    { kind: 'p', text: placeholder('Withdrawal notice, if you conclude distance contracts with consumers; otherwise delete this section') },
    { kind: 'h2', text: '7. Liability' },
    { kind: 'p', text: placeholder('Liability terms') },
    { kind: 'h2', text: '8. Final provisions' },
    { kind: 'p', text: placeholder('Governing law, place of jurisdiction (businesses only), severability') },
  ];
}

const DESCRIPTIONS: Record<LegalLanguage, Record<LegalKind, (site: string) => string>> = {
  de: {
    impressum: (s) => `Impressum${s ? ` von ${s}` : ''}: Anbieterkennzeichnung nach § 5 DDG.`,
    privacy: (s) => `Datenschutzerklärung${s ? ` von ${s}` : ''}: welche Daten wir verarbeiten und welche Rechte Sie haben.`,
    terms: (s) => `Allgemeine Geschäftsbedingungen${s ? ` von ${s}` : ''}.`,
  },
  en: {
    impressum: (s) => `Imprint${s ? ` of ${s}` : ''}: provider information.`,
    privacy: (s) => `Privacy policy${s ? ` of ${s}` : ''}: which data we process and what rights you have.`,
    terms: (s) => `Terms and conditions${s ? ` of ${s}` : ''}.`,
  },
};

/** Build a legal page template from the business data. */
export function buildLegalTemplate(input: LegalTemplateInput): LegalTemplate {
  const lang = legalLanguage(input.language);
  const date = input.date ?? new Date();
  const b = input.business;
  let blocks: LegalBlock[];
  if (input.kind === 'impressum') blocks = lang === 'de' ? impressumDe(b) : impressumEn(b);
  else if (input.kind === 'privacy') blocks = lang === 'de' ? privacyDe(b, input.facts, date) : privacyEn(b, input.facts, date);
  else blocks = lang === 'de' ? termsDe(b) : termsEn(b);
  return {
    language: lang,
    title: LEGAL_TITLES[lang][input.kind],
    description: DESCRIPTIONS[lang][input.kind](input.siteName.trim()),
    blocks,
  };
}

// ---------------------------------------------------------------------------
// Facts from a project's pages
// ---------------------------------------------------------------------------

interface NodeLike {
  props?: Record<string, unknown> | null;
  children?: NodeLike[] | null;
}

const UNSPLASH = /(^|[("'\s])https:\/\/images\.unsplash\.com\//;

/** Unsplash images and forms anywhere in these page trees (bounded walk). */
export function factsFromTrees(roots: Iterable<NodeLike | null | undefined>, analytics: boolean): TemplateFacts {
  let unsplash = false;
  let forms = false;
  let seen = 0;
  for (const root of roots) {
    const stack: NodeLike[] = root ? [root] : [];
    while (stack.length > 0 && seen < 20000 && !(unsplash && forms)) {
      const node = stack.pop()!;
      seen++;
      const props = node.props ?? {};
      if (props['data-form-kind'] === 'form') forms = true;
      if (!unsplash) {
        const src = props.src;
        const style = props.style as Record<string, unknown> | undefined;
        const bg = style?.backgroundImage;
        const texts = [src, typeof bg === 'object' && bg ? JSON.stringify(bg) : bg];
        if (texts.some((t) => typeof t === 'string' && UNSPLASH.test(t))) unsplash = true;
      }
      if (Array.isArray(node.children)) stack.push(...node.children);
    }
  }
  return { analytics, unsplash, forms };
}

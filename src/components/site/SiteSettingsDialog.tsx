'use client';

// src/components/site/SiteSettingsDialog.tsx
//
// Site settings: everything the published site says about itself that is not
// a page (src/lib/site/siteSettings.ts). Opened from the editor top bar.
//
// - General: public site name (blank uses the project title), language (the
//   published `<html lang>` and the AI generator's copy language), browser
//   title template, and the 404 page.
// - Sharing: favicon and default Open Graph image (https URLs, previewed), and
//   the twitter card type.
// - Motion: site-wide smooth scrolling (Lenis), off by default.
// - Business and contact: legal name, address, phone, email, opening hours as
//   rows, VAT ID, register entry, managing directors. Shown in search engine
//   data (JSON-LD) and handed to the AI generator so it never invents contact
//   details.
// - Legal pages and privacy: create the Impressum, privacy policy and terms
//   from templates filled with the business data (src/lib/legal/templates.ts),
//   or open them once they exist; put their links into every footer; and the
//   consent banner's status. The banner is not a setting: it is shown exactly
//   when something needs consent (analytics on), because turning it off while
//   analytics runs would break the law and turning it off otherwise changes
//   nothing (src/lib/consent/consent.ts).
//
// The form edits a draft; Save runs ProjectModel.updateSiteSettings, ONE MST
// action (one undo step), which validates again and changes nothing on a
// problem. Problems show once a field was left or a save was attempted, the
// first one gets focus, and a live region announces what is wrong.

import React from 'react';
import { observer } from 'mobx-react-lite';
import { ExternalLink, Plus, Settings, Trash2 } from 'lucide-react';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useStore } from '@/hooks/useStore';
import type { ProjectModelType } from '@/models/ProjectModel';
import {
  WEEKDAYS,
  applyTitleTemplate,
  effectiveSiteName,
  effectiveTitleTemplate,
  isHttpsUrl,
  normalizeSiteSettings,
  validateSiteSettings,
  type OpeningHoursRow,
  type SiteSettings,
  type SiteSettingsErrors,
  type Weekday,
} from '@/lib/site/siteSettings';
import { LEGAL_KINDS, LEGAL_TITLES, findLegalPage, legalLanguage, type LegalKind } from '@/lib/legal/legalPages';

const fieldLabel = 'text-[11px] font-semibold uppercase tracking-wide text-muted-foreground';
const inputBase =
  'h-9 w-full rounded-md border bg-background px-3 text-sm outline-none transition-shadow focus-visible:ring-[3px]';
const inputOk = 'border-input focus-visible:border-ring focus-visible:ring-ring/40';
const inputBad = 'border-destructive focus-visible:border-destructive focus-visible:ring-destructive/30';
const sectionTitle = 'text-[13px] font-semibold text-foreground';
const hint = 'text-[11px] text-muted-foreground';

/** Languages offered in the picker; any other BCP 47 tag can be typed under "Other". */
const LANGUAGE_CHOICES: Array<{ tag: string; label: string }> = [
  { tag: 'de', label: 'German (de)' },
  { tag: 'en', label: 'English (en)' },
  { tag: 'fr', label: 'French (fr)' },
  { tag: 'it', label: 'Italian (it)' },
  { tag: 'es', label: 'Spanish (es)' },
  { tag: 'nl', label: 'Dutch (nl)' },
];

const DAY_SHORT: Record<Weekday, string> = {
  Monday: 'Mon',
  Tuesday: 'Tue',
  Wednesday: 'Wed',
  Thursday: 'Thu',
  Friday: 'Fri',
  Saturday: 'Sat',
  Sunday: 'Sun',
};

/** The DOM id of the field an error key belongs to (for focus and aria-describedby). */
function fieldId(key: string): string {
  return `site-settings-${key.replace(/\./g, '-')}`;
}

interface TextFieldProps {
  name: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  hintText?: string;
  placeholder?: string;
  type?: string;
  onBlur: () => void;
  autoComplete?: string;
}

function TextField({ name, label, value, onChange, error, hintText, placeholder, type = 'text', onBlur, autoComplete = 'off' }: TextFieldProps) {
  const id = fieldId(name);
  const describedBy = error ? `${id}-error` : hintText ? `${id}-hint` : undefined;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className={fieldLabel}>
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        autoComplete={autoComplete}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`${inputBase} ${error ? inputBad : inputOk}`}
      />
      {error ? (
        <p id={`${id}-error`} className="text-[11px] text-destructive">
          {error}
        </p>
      ) : hintText ? (
        <p id={`${id}-hint`} className={hint}>
          {hintText}
        </p>
      ) : null}
    </div>
  );
}

/** A small preview of an image URL, with an honest note when it does not load. */
function ImagePreview({ url, label, square }: { url: string; label: string; square?: boolean }) {
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => setFailed(false), [url]);
  if (!isHttpsUrl(url)) return null;
  if (failed) {
    return (
      <p className="text-[11px] text-destructive" data-testid={`preview-failed-${label}`}>
        This image could not be loaded. Check that the address opens the image itself.
      </p>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={`${label} preview`}
      onError={() => setFailed(true)}
      className={`rounded border border-border bg-muted object-contain ${square ? 'h-8 w-8' : 'h-16 w-28'}`}
    />
  );
}

/** Button labels per legal page kind (editor chrome is English). */
const LEGAL_ACTION_NAMES: Record<LegalKind, string> = {
  impressum: 'Impressum',
  privacy: 'privacy policy',
  terms: 'terms',
};

const SiteSettingsForm = observer(({ project, onClose }: { project: ProjectModelType; onClose: () => void }) => {
  const { editorUI } = useStore();
  const [legalStatus, setLegalStatus] = React.useState('');
  const [draft, setDraft] = React.useState<SiteSettings>(() => project.site);
  // Managing directors are typed one per line; split on save.
  const [directorsText, setDirectorsText] = React.useState(() => project.site.business.managingDirectors.join('\n'));
  const [customLanguage, setCustomLanguage] = React.useState(
    () => !LANGUAGE_CHOICES.some((c) => c.tag === project.site.language),
  );
  const [touched, setTouched] = React.useState<Set<string>>(() => new Set());
  const [submitted, setSubmitted] = React.useState(false);
  const [saveErrors, setSaveErrors] = React.useState<SiteSettingsErrors>({});
  const [announcement, setAnnouncement] = React.useState('');

  const candidate: SiteSettings = normalizeSiteSettings({
    ...draft,
    business: {
      ...draft.business,
      managingDirectors: directorsText.split('\n'),
    },
  });
  const errors: SiteSettingsErrors = { ...validateSiteSettings(candidate), ...saveErrors };
  const visible = (key: string) => (submitted || touched.has(key) ? errors[key] : undefined);
  const touch = (key: string) => () => setTouched((t) => new Set(t).add(key));

  const update = (patch: Partial<SiteSettings>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setSaveErrors({});
    setAnnouncement('');
  };
  const updateBusiness = (patch: Partial<SiteSettings['business']>) => {
    setDraft((d) => ({ ...d, business: { ...d.business, ...patch } }));
    setSaveErrors({});
    setAnnouncement('');
  };
  const updateRow = (index: number, patch: Partial<OpeningHoursRow>) => {
    updateBusiness({
      openingHours: draft.business.openingHours.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    });
  };

  const siteName = effectiveSiteName(candidate, project.metadata.title);
  const titlePreview = applyTitleTemplate(effectiveTitleTemplate(candidate, siteName), 'About us');
  const notFoundCandidates = project.pagesArray.filter((p) => p.slug !== '');

  /** Validate and save the draft; on a problem, show it and return false. */
  const save = (): boolean => {
    setSubmitted(true);
    const problems = validateSiteSettings(candidate);
    const result = Object.keys(problems).length > 0 ? { ok: false as const, errors: problems } : project.updateSiteSettings(candidate);
    if (!result.ok) {
      setSaveErrors(result.errors);
      const keys = Object.keys(result.errors);
      setAnnouncement(`Not saved. ${keys.length === 1 ? 'One field needs' : `${keys.length} fields need`} attention: ${result.errors[keys[0]]}`);
      document.getElementById(fieldId(keys[0]))?.focus();
      return false;
    }
    return true;
  };

  const submit = (event?: React.FormEvent) => {
    event?.preventDefault();
    if (save()) onClose();
  };

  // A legal page is filled from the SAVED business data, so the draft is
  // saved first (one undo step for the settings, one for the page); with a
  // problem in the draft nothing is created and the problem shows.
  const openOrCreateLegal = (kind: LegalKind) => {
    if (!save()) return;
    const { page } = project.createLegalPage(kind);
    editorUI.setCurrentPage(page);
    onClose();
  };

  const addFooterLinks = () => {
    const result = project.addLegalLinksToFooters();
    const parts = [
      result.pagesUpdated === 0
        ? 'Every footer already has the links.'
        : `Links added to ${result.pagesUpdated} ${result.pagesUpdated === 1 ? 'page' : 'pages'}.`,
    ];
    if (result.pagesWithoutFooter > 0) {
      parts.push(`${result.pagesWithoutFooter} ${result.pagesWithoutFooter === 1 ? 'page has' : 'pages have'} no footer.`);
    }
    setLegalStatus(parts.join(' '));
  };

  const legalLang = legalLanguage(candidate.language);
  const legalPages = LEGAL_KINDS.map((kind) => ({ kind, page: findLegalPage(project.pagesArray, kind) }));
  const analyticsOn = project.lumitra.enabled;

  const languageSelectValue = customLanguage ? 'other' : draft.language;

  return (
    <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="sr-only" role="status" aria-live="polite" data-testid="site-settings-announcement">
        {announcement}
      </div>
      <DialogBody className="flex flex-col gap-6" data-testid="site-settings-body">
        <section className="flex flex-col gap-4" aria-labelledby="site-settings-general">
          <h3 id="site-settings-general" className={sectionTitle}>General</h3>
          <TextField
            name="siteName"
            label="Site name"
            value={draft.siteName}
            onChange={(v) => update({ siteName: v })}
            onBlur={touch('siteName')}
            placeholder={project.metadata.title}
            hintText="The public name of your business or site. Leave empty to use the project name."
          />
          <div className="flex flex-col gap-1.5">
            <label htmlFor={fieldId('language')} className={fieldLabel}>Language</label>
            <select
              id={customLanguage ? 'site-settings-language-choice' : fieldId('language')}
              value={languageSelectValue}
              onChange={(e) => {
                if (e.target.value === 'other') {
                  setCustomLanguage(true);
                } else {
                  setCustomLanguage(false);
                  update({ language: e.target.value });
                }
              }}
              aria-label={customLanguage ? 'Language choice' : undefined}
              className={`${inputBase} ${inputOk}`}
            >
              {LANGUAGE_CHOICES.map((c) => (
                <option key={c.tag} value={c.tag}>{c.label}</option>
              ))}
              <option value="other">Other language code</option>
            </select>
            {customLanguage && (
              <input
                id={fieldId('language')}
                value={draft.language}
                onChange={(e) => update({ language: e.target.value.trim() })}
                onBlur={touch('language')}
                placeholder="e.g. pt-BR"
                aria-invalid={visible('language') ? true : undefined}
                aria-describedby={visible('language') ? `${fieldId('language')}-error` : undefined}
                className={`${inputBase} ${visible('language') ? inputBad : inputOk} font-mono`}
              />
            )}
            {visible('language') ? (
              <p id={`${fieldId('language')}-error`} className="text-[11px] text-destructive">{visible('language')}</p>
            ) : (
              <p className={hint}>Tells browsers, screen readers and search engines the language of your pages, and the AI writes new copy in it.</p>
            )}
          </div>
          <TextField
            name="titleTemplate"
            label="Browser title"
            value={draft.titleTemplate}
            onChange={(v) => update({ titleTemplate: v })}
            onBlur={touch('titleTemplate')}
            error={visible('titleTemplate')}
            placeholder={siteName ? `%s | ${siteName}` : '%s'}
            hintText={`%s is the page name. A page called "About us" shows as: ${titlePreview}`}
          />
          <div className="flex flex-col gap-1.5">
            <label htmlFor={fieldId('notFoundPageId')} className={fieldLabel}>404 page</label>
            <select
              id={fieldId('notFoundPageId')}
              value={draft.notFoundPageId}
              onChange={(e) => update({ notFoundPageId: e.target.value })}
              aria-invalid={visible('notFoundPageId') ? true : undefined}
              className={`${inputBase} ${visible('notFoundPageId') ? inputBad : inputOk}`}
              disabled={notFoundCandidates.length === 0}
            >
              <option value="">Default page (uses your site name)</option>
              {notFoundCandidates.map((p) => (
                <option key={p.id} value={p.id}>{p.metadata.title}</option>
              ))}
            </select>
            {visible('notFoundPageId') ? (
              <p className="text-[11px] text-destructive">{visible('notFoundPageId')}</p>
            ) : (
              <p className={hint}>
                {notFoundCandidates.length === 0
                  ? 'Add a page and design it as your 404 page, then pick it here.'
                  : 'Shown, with the status 404, when a visitor opens an address that does not exist.'}
              </p>
            )}
          </div>
        </section>

        <section className="flex flex-col gap-4" aria-labelledby="site-settings-sharing">
          <h3 id="site-settings-sharing" className={sectionTitle}>Icon and sharing</h3>
          <div className="flex items-end gap-3">
            <div className="min-w-0 flex-1">
              <TextField
                name="faviconUrl"
                label="Favicon"
                value={draft.faviconUrl}
                onChange={(v) => update({ faviconUrl: v.trim() })}
                onBlur={touch('faviconUrl')}
                error={visible('faviconUrl')}
                placeholder="https://"
                hintText="Address of a square PNG or SVG, at least 180 by 180 pixels. Empty: no site icon."
              />
            </div>
            <ImagePreview url={candidate.faviconUrl} label="Favicon" square />
          </div>
          <div className="flex items-end gap-3">
            <div className="min-w-0 flex-1">
              <TextField
                name="ogImageUrl"
                label="Sharing image"
                value={draft.ogImageUrl}
                onChange={(v) => update({ ogImageUrl: v.trim() })}
                onBlur={touch('ogImageUrl')}
                error={visible('ogImageUrl')}
                placeholder="https://"
                hintText="Shown when a page is shared on social media or in chats, unless the page has its own. 1200 by 630 pixels works everywhere."
              />
            </div>
            <ImagePreview url={candidate.ogImageUrl} label="Sharing image" />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={fieldId('twitterCard')} className={fieldLabel}>Card on X (Twitter)</label>
            <select
              id={fieldId('twitterCard')}
              value={draft.twitterCard}
              onChange={(e) => update({ twitterCard: e.target.value as SiteSettings['twitterCard'] })}
              className={`${inputBase} ${inputOk}`}
            >
              <option value="summary_large_image">Large image</option>
              <option value="summary">Small square image</option>
            </select>
          </div>
        </section>

        {/* Motion (docs/plans/2026-10-23-motion-effects.md): site-wide
            smooth scrolling with Lenis, in the preview and on published pages,
            never on the editor canvas, always off under reduced motion. */}
        <section className="flex flex-col gap-4" aria-labelledby="site-settings-motion">
          <h3 id="site-settings-motion" className={sectionTitle}>Motion</h3>
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-1">
              <label htmlFor={fieldId('smoothScroll')} className={fieldLabel}>Smooth scrolling</label>
              <p id={`${fieldId('smoothScroll')}-hint`} className={hint}>
                Eases the page as visitors scroll, in the preview and on the published site. Visitors who ask their
                device for reduced motion always get normal scrolling. Links to a section on the page keep working.
              </p>
            </div>
            <Switch
              id={fieldId('smoothScroll')}
              aria-describedby={`${fieldId('smoothScroll')}-hint`}
              checked={draft.smoothScroll}
              onCheckedChange={(on) => update({ smoothScroll: on })}
            />
          </div>
        </section>

        <section className="flex flex-col gap-4" aria-labelledby="site-settings-business">
          <div className="flex flex-col gap-1">
            <h3 id="site-settings-business" className={sectionTitle}>Business and contact</h3>
            <p className={hint}>
              Used in search engine data and by the AI for footers and contact sections. Anything left empty is never
              made up: the AI leaves a marked placeholder instead.
            </p>
          </div>
          <TextField name="business.legalName" label="Legal name" value={draft.business.legalName} onChange={(v) => updateBusiness({ legalName: v })} onBlur={touch('business.legalName')} placeholder="Bäckerei Müller GmbH" />
          <TextField name="business.street" label="Street and number" value={draft.business.street} onChange={(v) => updateBusiness({ street: v })} onBlur={touch('business.street')} error={visible('business.street')} autoComplete="off" />
          <div className="grid grid-cols-[120px_minmax(0,1fr)_88px] gap-3">
            <TextField name="business.postalCode" label="Postcode" value={draft.business.postalCode} onChange={(v) => updateBusiness({ postalCode: v })} onBlur={touch('business.postalCode')} error={visible('business.postalCode')} />
            <TextField name="business.city" label="City" value={draft.business.city} onChange={(v) => updateBusiness({ city: v })} onBlur={touch('business.city')} error={visible('business.city')} />
            <TextField name="business.country" label="Country" value={draft.business.country} onChange={(v) => updateBusiness({ country: v.toUpperCase() })} onBlur={touch('business.country')} error={visible('business.country')} placeholder="DE" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <TextField name="business.phone" label="Phone" type="tel" value={draft.business.phone} onChange={(v) => updateBusiness({ phone: v })} onBlur={touch('business.phone')} error={visible('business.phone')} placeholder="+49 89 1234567" />
            <TextField name="business.email" label="Email" type="email" value={draft.business.email} onChange={(v) => updateBusiness({ email: v.trim() })} onBlur={touch('business.email')} error={visible('business.email')} placeholder="hallo@example.de" />
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className={`${fieldLabel} mb-1.5`}>Opening hours</legend>
            {draft.business.openingHours.length === 0 ? (
              <p className={hint} data-testid="opening-hours-empty">
                No opening hours yet. Add a row for each group of days with the same hours.
              </p>
            ) : (
              draft.business.openingHours.map((row, i) => {
                const key = `business.openingHours.${i}`;
                const error = visible(key);
                return (
                  <div key={i} id={fieldId(key)} tabIndex={-1} className="flex flex-col gap-1.5 rounded-md border border-border p-2" data-testid={`opening-hours-row-${i}`}>
                    <div className="flex flex-wrap items-center gap-1" role="group" aria-label={`Days of row ${i + 1}`}>
                      {WEEKDAYS.map((day) => {
                        const on = row.days.includes(day);
                        return (
                          <button
                            key={day}
                            type="button"
                            aria-pressed={on}
                            aria-label={day}
                            onClick={() => {
                              updateRow(i, { days: on ? row.days.filter((d) => d !== day) : WEEKDAYS.filter((d) => d === day || row.days.includes(d)) });
                              touch(key)();
                            }}
                            className={`h-7 rounded px-2 text-[11px] ${on ? 'bg-brand text-white' : 'bg-muted text-muted-foreground hover:text-foreground'}`}
                          >
                            {DAY_SHORT[day]}
                          </button>
                        );
                      })}
                    </div>
                    <div className="flex items-center gap-2">
                      <input type="time" aria-label={`Opens, row ${i + 1}`} value={row.opens} onChange={(e) => updateRow(i, { opens: e.target.value })} onBlur={touch(key)} className={`${inputBase} ${error ? inputBad : inputOk} w-28`} />
                      <span className={hint}>to</span>
                      <input type="time" aria-label={`Closes, row ${i + 1}`} value={row.closes} onChange={(e) => updateRow(i, { closes: e.target.value })} onBlur={touch(key)} className={`${inputBase} ${error ? inputBad : inputOk} w-28`} />
                      <button
                        type="button"
                        aria-label={`Remove row ${i + 1}`}
                        onClick={() => updateBusiness({ openingHours: draft.business.openingHours.filter((_, j) => j !== i) })}
                        className="ml-auto flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                      >
                        <Trash2 size={14} aria-hidden="true" />
                      </button>
                    </div>
                    {error && <p className="text-[11px] text-destructive">{error}</p>}
                  </div>
                );
              })
            )}
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => updateBusiness({ openingHours: [...draft.business.openingHours, { days: [], opens: '09:00', closes: '18:00' }] })}
              >
                <Plus size={14} aria-hidden="true" /> Add opening hours
              </Button>
            </div>
          </fieldset>

          <div className="grid grid-cols-2 gap-3">
            <TextField name="business.vatId" label="VAT ID" value={draft.business.vatId} onChange={(v) => updateBusiness({ vatId: v })} onBlur={touch('business.vatId')} placeholder="DE123456789" />
            <TextField name="business.registerEntry" label="Register entry" value={draft.business.registerEntry} onChange={(v) => updateBusiness({ registerEntry: v })} onBlur={touch('business.registerEntry')} placeholder="Amtsgericht München, HRB 12345" />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={fieldId('business.managingDirectors')} className={fieldLabel}>Managing directors</label>
            <textarea
              id={fieldId('business.managingDirectors')}
              value={directorsText}
              rows={2}
              onChange={(e) => {
                setDirectorsText(e.target.value);
                setAnnouncement('');
              }}
              aria-describedby={`${fieldId('business.managingDirectors')}-hint`}
              className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none transition-shadow focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
            />
            <p id={`${fieldId('business.managingDirectors')}-hint`} className={hint}>One name per line.</p>
          </div>
        </section>

        <section className="flex flex-col gap-4" aria-labelledby="site-settings-legal">
          <div className="flex flex-col gap-1">
            <h3 id="site-settings-legal" className={sectionTitle}>Legal pages and privacy</h3>
            <p className={hint}>
              Templates filled from your business details, in your site language. They are templates, not legal advice:
              review every page before you publish it, and fill in or delete each part in [square brackets].
            </p>
          </div>
          <ul className="flex flex-col gap-2" data-testid="legal-pages">
            {legalPages.map(({ kind, page }) => (
              <li key={kind} className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
                <div className="flex min-w-0 flex-col">
                  <span className="text-sm text-foreground">{LEGAL_TITLES[legalLang][kind]}</span>
                  <span className={hint}>{page ? `/${page.slug}` : 'Not created yet'}</span>
                </div>
                <Button type="button" variant={page ? 'outline' : 'brand'} size="sm" onClick={() => openOrCreateLegal(kind)}>
                  {page ? (
                    <>
                      <ExternalLink size={14} aria-hidden="true" /> Open {LEGAL_ACTION_NAMES[kind]}
                    </>
                  ) : (
                    <>Create {LEGAL_ACTION_NAMES[kind]}</>
                  )}
                </Button>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="outline" size="sm" onClick={addFooterLinks}>
              Add legal links to footers
            </Button>
            <p className={hint} role="status" aria-live="polite" data-testid="legal-links-status">
              {legalStatus || 'Adds the legal pages and the cookie settings link to the footer of every page.'}
            </p>
          </div>
          <div className="flex flex-col gap-1 rounded-md bg-muted px-3 py-2" data-testid="consent-status">
            <span className={fieldLabel}>Consent banner</span>
            <p className="text-[12px] text-foreground">
              {analyticsOn
                ? 'Shown to visitors, because analytics is on (once the deploy has an analytics key configured). The analytics script loads only after a visitor accepts; declining loads nothing. Visitors can change their choice from the cookie settings link in the footer.'
                : 'Not shown: nothing on your site stores data on visitors\' devices that needs consent (analytics is off).'}
            </p>
          </div>
        </section>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" size="sm" onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="brand" size="sm">Save</Button>
      </DialogFooter>
    </form>
  );
});
SiteSettingsForm.displayName = 'SiteSettingsForm';

export interface SiteSettingsDialogProps {
  project: ProjectModelType;
  open: boolean;
  onClose: () => void;
}

export function SiteSettingsDialog({ project, open, onClose }: SiteSettingsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      {open && (
        <DialogContent
          data-testid="site-settings-dialog"
          data-editor-ui="true"
          className="max-w-[600px]"
          // Keep editor shortcuts from firing while typing; Escape still closes.
          onKeyDown={(e) => {
            if (e.key !== 'Escape') e.stopPropagation();
          }}
        >
          <DialogHeader>
            <DialogTitle>Site settings</DialogTitle>
            <DialogDescription>Name, language, icon, sharing image and business details of your site.</DialogDescription>
          </DialogHeader>
          <SiteSettingsForm project={project} onClose={onClose} />
        </DialogContent>
      )}
    </Dialog>
  );
}

/** The top-bar entry: a gear button opening the dialog for the current project. */
const SiteSettingsButton = observer(() => {
  const project = useStore().editorUI.currentProject;
  const [open, setOpen] = React.useState(false);
  if (!project) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Site settings"
        aria-label="Site settings"
        className="mr-2 flex h-8 w-8 items-center justify-center rounded text-foreground hover:bg-accent"
      >
        <Settings size={16} />
      </button>
      <SiteSettingsDialog project={project} open={open} onClose={() => setOpen(false)} />
    </>
  );
});
SiteSettingsButton.displayName = 'SiteSettingsButton';

export default SiteSettingsButton;

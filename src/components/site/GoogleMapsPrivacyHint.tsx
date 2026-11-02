'use client';
// src/components/site/GoogleMapsPrivacyHint.tsx
//
// What the editor tells an owner whose site embeds a Google Map
// (src/lib/mapEmbed/mapEmbed.ts): the map loads only after a visitor consents,
// but Google then receives data, so the privacy policy must name Google Maps.
// Shown in the publish notice when the policy does not (src/components/PublishButton.tsx)
// and always in Site settings. The suggested wording is the privacy template's own
// Google Maps section (GOOGLE_MAPS_PRIVACY), in the site language, ready to copy.

import React from 'react';
import { Button } from '@/components/ui/button';
import { legalLanguage } from '@/lib/legal/legalPages';
import { GOOGLE_MAPS_PRIVACY } from '@/lib/legal/templates';
import type { MapsPrivacyCheck } from '@/lib/legal/publishCheck';

export interface GoogleMapsPrivacyHintProps {
  /** The site language (Site settings): the wording is German for `de*`, English otherwise. */
  language: string;
  check: MapsPrivacyCheck;
  /** Opens the privacy policy page, when the site has one. */
  onOpenPrivacy?: () => void;
  /** Creates the privacy policy from the template, which then holds the Google Maps section. */
  onCreatePrivacy?: () => void;
  className?: string;
}

const STATUS_TEXT: Record<MapsPrivacyCheck['status'], string> = {
  'no-privacy-page':
    'Your site has no privacy policy yet. Create one from the template: it includes a section on Google Maps.',
  'not-named':
    'Your privacy policy does not name Google Maps yet. Add a section on it, for example the wording below, and fill in the part in [square brackets].',
  named: 'Your privacy policy names Google Maps. Check that it still matches the wording below.',
};

/** The suggested section as plain text, heading first. */
export function googleMapsWording(language: string): string {
  const section = GOOGLE_MAPS_PRIVACY[legalLanguage(language)];
  return [section.title, ...section.paragraphs].join('\n\n');
}

export function GoogleMapsPrivacyHint({ language, check, onOpenPrivacy, onCreatePrivacy, className }: GoogleMapsPrivacyHintProps) {
  const [copyStatus, setCopyStatus] = React.useState('');
  const section = GOOGLE_MAPS_PRIVACY[legalLanguage(language)];
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error('no clipboard');
      await navigator.clipboard.writeText(googleMapsWording(language));
      setCopyStatus('Copied.');
    } catch {
      setCopyStatus('Copying is blocked here: select the text above and copy it.');
    }
  };
  return (
    <div className={`flex flex-col gap-2 ${className ?? ''}`} data-testid="google-maps-privacy-hint" data-status={check.status}>
      <p className="text-[12px] font-semibold">Your site embeds Google Maps</p>
      <p className="text-[12px]">
        A map loads only after a visitor consents, and Google then receives data such as the visitor&apos;s IP address.
        Your privacy policy must name Google Maps. {STATUS_TEXT[check.status]}
      </p>
      <details className="text-[12px]">
        <summary className="cursor-pointer font-medium">Suggested wording</summary>
        <div className="mt-1.5 flex flex-col gap-1.5 rounded-md border border-border p-2" data-testid="google-maps-wording">
          <p className="font-semibold">{section.title}</p>
          {section.paragraphs.map((text) => (
            <p key={text}>{text}</p>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
              Copy wording
            </Button>
            <span role="status" aria-live="polite">{copyStatus}</span>
          </div>
        </div>
      </details>
      {check.status === 'no-privacy-page' && onCreatePrivacy ? (
        <div>
          <Button type="button" variant="outline" size="sm" onClick={onCreatePrivacy}>
            Create privacy policy
          </Button>
        </div>
      ) : check.status !== 'named' && check.privacyPageId && onOpenPrivacy ? (
        <div>
          <Button type="button" variant="outline" size="sm" onClick={onOpenPrivacy}>
            Open {check.privacyTitle || 'privacy policy'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

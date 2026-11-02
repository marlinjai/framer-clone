'use client';
// src/components/sidebars/right/sections/MapEmbedSection.tsx
//
// The properties panel's section for the Google Maps embed
// (src/lib/mapEmbed/mapEmbed.ts): the embed address (or the embed code Google's
// "Share, Embed a map" dialog gives), the address text the placeholder shows, and
// the frame's accessible name. The box itself is sized and styled with the
// normal sections.
//
// The embed address is checked as it is typed: what does not parse is shown as
// an error and never stored; what does is stored rebuilt, so the prop never holds
// a pasted snippet. readMapEmbed checks it again at render time on every surface.

import React, { useEffect, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { MapPin } from 'lucide-react';
import type { ComponentInstance } from '@/models/ComponentModel';
import { CollapsibleSection, PropertyRow, TextInput } from '../primitives';
import { parseMapEmbed, readMapEmbed } from '@/lib/mapEmbed/mapEmbed';

interface MapEmbedSectionProps {
  component: ComponentInstance;
  breakpointId?: string;
}

const HINT = 'text-[11px] leading-snug text-muted-foreground';
const ERROR = 'text-[11px] leading-snug text-destructive';

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export const MapEmbedSection = observer(({ component }: MapEmbedSectionProps) => {
  const props = component.props as Record<string, unknown>;
  const url = str(props.mapUrl);
  const address = str(props.mapAddress);
  const title = str(props.mapTitle);
  // The field keeps what is typed or pasted; the prop only takes a rebuilt address.
  const [draftUrl, setDraftUrl] = useState(url);
  useEffect(() => setDraftUrl(url), [url]);
  const parsed = draftUrl.trim() === '' ? null : parseMapEmbed(draftUrl);
  const view = readMapEmbed(props);

  return (
    <CollapsibleSection title="Google Map" icon={<MapPin size={14} />} normalOnly>
      <p className={HINT}>
        On the published site the map loads only after the visitor consents (a &quot;Load map&quot; button and the
        consent banner); until then a placeholder shows the address and an &quot;Open in Google Maps&quot; link. The
        editor and the preview never load it. Name Google Maps in your privacy policy.
      </p>
      <PropertyRow label="Address">
        <TextInput
          value={address}
          maxLength={200}
          placeholder="Hauptstraße 1, 10115 Berlin"
          onChange={(e) => {
            const next = e.target.value;
            // Kept as typed (a space mid-word must survive); readMapEmbed cleans it on every render.
            component.setProps({ mapAddress: next.trim() === '' ? undefined : next.slice(0, 200) });
          }}
        />
      </PropertyRow>
      <p className={HINT}>Shown on the placeholder. Without an embed address below, the map searches for it.</p>
      <PropertyRow label="Embed">
        <TextInput
          value={draftUrl}
          mono
          placeholder="https://www.google.com/maps/embed?pb=..."
          aria-invalid={parsed && !parsed.ok ? true : undefined}
          onChange={(e) => {
            const next = e.target.value;
            setDraftUrl(next);
            if (next.trim() === '') {
              component.setProps({ mapUrl: undefined });
              return;
            }
            const result = parseMapEmbed(next);
            if (result.ok) component.setProps({ mapUrl: result.map.src });
          }}
        />
      </PropertyRow>
      {parsed && !parsed.ok ? (
        <p role="alert" className={ERROR}>
          {parsed.error}
        </p>
      ) : (
        <p className={HINT}>
          Optional. In Google Maps choose Share, Embed a map, and paste the code or its address. Only Google Maps
          embed addresses are accepted.
        </p>
      )}
      {!view.src && <p className={ERROR}>Add an address or an embed address, or the box shows no map.</p>}
      <PropertyRow label="Title">
        <TextInput
          value={title}
          maxLength={200}
          placeholder={view.copy.title(view.address)}
          onChange={(e) => {
            const next = e.target.value;
            component.setProps({ mapTitle: next.trim() === '' ? undefined : next.slice(0, 200) });
          }}
        />
      </PropertyRow>
      <p className={HINT}>What a screen reader announces for the map.</p>
    </CollapsibleSection>
  );
});

MapEmbedSection.displayName = 'MapEmbedSection';

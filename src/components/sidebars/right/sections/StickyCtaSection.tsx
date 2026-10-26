'use client';
// src/components/sidebars/right/sections/StickyCtaSection.tsx
//
// The properties panel's section for the sticky call to action bar
// (published site essentials, decision 7, src/lib/stickyCta/stickyCta.ts):
// the link's label and target, and the button's colours and corners. The
// bar itself (background, padding, font) is styled with the normal sections.
//
// The link is checked as it is typed: an unsafe or empty target is shown as
// an error and kept out of the published page (readStickyCta drops it), so
// the owner sees why the button would not go anywhere.

import React, { useEffect, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { PanelBottom } from 'lucide-react';
import type { ComponentInstance } from '@/models/ComponentModel';
import { useStore } from '@/hooks/useStore';
import { CollapsibleSection, ColorInput, PropertyRow, PropertySelect, TextInput } from '../primitives';
import { DEFAULT_STICKY_CTA, isSafeCtaStyleValue } from '@/lib/stickyCta/stickyCta';
import { isSafeHref } from '@/lib/links/safeHref';
import { isLinkablePageSlug } from '@/lib/forms/paths';

interface StickyCtaSectionProps {
  component: ComponentInstance;
  breakpointId?: string;
}

const HINT = 'text-[11px] leading-snug text-muted-foreground';

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export const StickyCtaSection = observer(({ component }: StickyCtaSectionProps) => {
  const { editorUI } = useStore();
  const project = editorUI.currentProject;
  const props = component.props as Record<string, unknown>;
  const href = str(props.ctaHref);
  // The link field keeps what is typed; the prop only takes a safe value, so a
  // half-typed URL never reaches the page.
  const [draftHref, setDraftHref] = useState(href);
  useEffect(() => setDraftHref(href), [href]);
  const hrefError =
    draftHref.trim() === ''
      ? 'Add a link: a page of this site, #section, https://, mailto: or tel:'
      : isSafeHref(draftHref)
        ? null
        : 'Use a page path (/contact), #section, https://, mailto: or tel:';
  const pages = project ? Array.from(project.pages.values()).filter((p) => isLinkablePageSlug(p.slug)) : [];
  const label = str(props.ctaLabel);

  return (
    <CollapsibleSection title="Sticky call to action" icon={<PanelBottom size={14} />}>
      <p className={HINT}>
        Pinned to the bottom of the screen on the smallest breakpoint of the published page and the preview,
        hidden on larger ones (its bottom padding there is 12px plus the phone&apos;s safe area). At most one
        per page.
      </p>
      <PropertyRow label="Label">
        <TextInput
          value={label}
          maxLength={80}
          placeholder={DEFAULT_STICKY_CTA.ctaLabel}
          onChange={(e) => component.setProps({ ctaLabel: e.target.value })}
        />
      </PropertyRow>
      {label.trim() === '' && <p className={HINT}>Without a label the button reads &quot;Call to action&quot;.</p>}
      <PropertyRow label="Link">
        <TextInput
          value={draftHref}
          mono
          placeholder="#contact"
          aria-invalid={hrefError ? true : undefined}
          onChange={(e) => {
            const next = e.target.value;
            setDraftHref(next);
            if (isSafeHref(next)) component.setProps({ ctaHref: next.trim() });
            else if (next.trim() === '') component.setProps({ ctaHref: undefined });
          }}
        />
      </PropertyRow>
      {hrefError && (
        <p role="alert" className="text-[11px] leading-snug text-destructive">
          {hrefError}
        </p>
      )}
      {pages.length > 0 && (
        <PropertyRow label="Page">
          <PropertySelect
            label=""
            value=""
            placeholder="Link to a page"
            onChange={(v) => {
              const page = pages.find((p) => p.id === v);
              if (page) component.setProps({ ctaHref: page.slug ? `/${page.slug}` : '/' });
            }}
            options={pages.map((p) => ({ value: p.id, label: `${p.metadata.title || 'Untitled'} (/${p.slug})` }))}
          />
        </PropertyRow>
      )}
      <PropertyRow label="Button">
        <ColorInput
          label=""
          value={str(props.buttonBackground) || DEFAULT_STICKY_CTA.buttonBackground}
          onChange={(v) => {
            if (isSafeCtaStyleValue(v)) component.setProps({ buttonBackground: v });
          }}
        />
      </PropertyRow>
      <PropertyRow label="Text">
        <ColorInput
          label=""
          value={str(props.buttonTextColor) || DEFAULT_STICKY_CTA.buttonTextColor}
          onChange={(v) => {
            if (isSafeCtaStyleValue(v)) component.setProps({ buttonTextColor: v });
          }}
        />
      </PropertyRow>
      <PropertyRow label="Radius">
        <TextInput
          value={str(props.buttonRadius)}
          placeholder={DEFAULT_STICKY_CTA.buttonRadius}
          onChange={(e) => {
            const v = e.target.value.trim();
            if (v === '') component.setProps({ buttonRadius: undefined });
            else if (isSafeCtaStyleValue(v)) component.setProps({ buttonRadius: v });
          }}
        />
      </PropertyRow>
    </CollapsibleSection>
  );
});

StickyCtaSection.displayName = 'StickyCtaSection';

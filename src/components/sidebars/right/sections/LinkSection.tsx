'use client';
// src/components/sidebars/right/sections/LinkSection.tsx
//
// The properties panel's section for a link (an `a` element, the registry's
// Link component, or a link a generated page or the legal footer made): where
// it points. The target is checked as it is typed (src/lib/links/safeHref.ts),
// so an unsafe or half-typed address never reaches the page, and a page of
// the site can be picked from a list. The bind button links it to data
// instead: inside a product list `{{product.href}}` is each product's page.

import React, { useEffect, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { Link as LinkIcon } from 'lucide-react';
import type { ComponentInstance } from '@/models/ComponentModel';
import { useStore } from '@/hooks/useStore';
import { getBindableSlotsFor } from '@/lib/componentRegistry';
import type { BindableSlotMeta } from '@/lib/bindings/types';
import { isSafeHref } from '@/lib/links/safeHref';
import { isLinkablePageSlug } from '@/lib/forms/paths';
import { CollapsibleSection, FIELD_LABEL, PropertyRow, PropertySelect, TextInput } from '../primitives';
import BindingControl from '../BindingControl';

interface LinkSectionProps {
  component: ComponentInstance;
  breakpointId?: string;
}

const HINT = 'text-[11px] leading-snug text-muted-foreground';
const HREF_META: BindableSlotMeta = { label: 'Link', allowedModes: ['read'], scopeHint: 'any' };

/** Why a typed target cannot be used, or null when it can. */
export function linkTargetError(draft: string): string | null {
  if (draft.trim() === '') return 'Add a link: a page of this site, #section, https://, mailto: or tel:';
  return isSafeHref(draft) ? null : 'Use a page path (/contact), #section, https://, mailto: or tel:';
}

export const LinkSection = observer(({ component }: LinkSectionProps) => {
  const { editorUI } = useStore();
  const project = editorUI.currentProject;
  const raw = (component.props as Record<string, unknown>).href;
  const href = typeof raw === 'string' ? raw : '';
  // The field keeps what is typed; the prop only takes a safe value.
  const [draft, setDraft] = useState(href);
  useEffect(() => setDraft(href), [href]);
  const error = linkTargetError(draft);
  const bound = component.getBinding('href')?.mode === 'read';
  const meta = getBindableSlotsFor('link').href ?? HREF_META;
  const pages = project ? project.pagesArray.filter((p) => isLinkablePageSlug(p.slug)) : [];
  const hasProductPage = Boolean(project?.productPagePath);

  return (
    <CollapsibleSection title="Link" icon={<LinkIcon size={14} />}>
      <div className="flex min-w-0 flex-col gap-1.5" data-testid="link-section">
        <span className={FIELD_LABEL}>Goes to</span>
        <BindingControl node={component} slot="href" meta={meta}>
          <TextInput
            value={draft}
            mono
            placeholder="/contact"
            aria-label="Link target"
            aria-invalid={error ? true : undefined}
            onChange={(e) => {
              const next = e.target.value;
              setDraft(next);
              if (isSafeHref(next)) component.setProps({ href: next.trim() });
            }}
          />
        </BindingControl>
        {bound ? (
          <p className={HINT}>
            The link comes from data. {hasProductPage
              ? 'Inside a product list, {{product.href}} opens each product on its product page.'
              : 'For {{product.href}} the site needs a product page (a page with the address products/:handle).'}
          </p>
        ) : (
          error && (
            <p role="alert" className="text-[11px] leading-snug text-destructive">
              {error}
            </p>
          )
        )}
      </div>
      {!bound && pages.length > 0 && (
        <PropertyRow label="Page">
          <PropertySelect
            label=""
            value=""
            placeholder="Link to a page"
            onChange={(v) => {
              const page = pages.find((p) => p.id === v);
              if (page) component.setProps({ href: page.slug ? `/${page.slug}` : '/' });
            }}
            options={pages.map((p) => ({ value: p.id, label: `${p.metadata.title || 'Untitled'} (/${p.slug})` }))}
          />
        </PropertyRow>
      )}
    </CollapsibleSection>
  );
});

LinkSection.displayName = 'LinkSection';

export default LinkSection;

// src/lib/legal/legalPageTree.ts
//
// Turns a legal template (./templates.ts) into ordinary page components, and
// builds the footer's legal links. PURE: plain component snapshots in the
// shape ComponentModel accepts, so ProjectModel creates them in one action and
// the owner edits them like any other layer.

import { v4 as uuidv4 } from 'uuid';
import type { LegalBlock, LegalTemplate } from './templates';

/** The shape of a host component snapshot (ComponentModel's snapshot in). */
export interface HostSnapshot {
  id: string;
  type: string;
  componentType: 'host';
  label?: string;
  parentId?: string;
  props: Record<string, unknown>;
  children?: HostSnapshot[];
}

/** The page look a legal page copies from the home page root (font and colours). */
export interface LegalPageLook {
  fontFamily?: string;
  color?: string;
  backgroundColor?: string;
}

function host(type: string, label: string, props: Record<string, unknown>, children?: HostSnapshot[]): HostSnapshot {
  const id = `${type}-${uuidv4()}`;
  return {
    id,
    type,
    componentType: 'host',
    label,
    props,
    ...(children ? { children: children.map((c) => ({ ...c, parentId: id })) } : {}),
  };
}

function blockNode(block: LegalBlock): HostSnapshot {
  switch (block.kind) {
    case 'h1':
      return host('h1', 'Title', { children: block.text, style: { fontSize: '40px', lineHeight: '1.15', fontWeight: 700, margin: '0 0 8px' } });
    case 'h2':
      return host('h2', 'Heading', { children: block.text, style: { fontSize: '22px', lineHeight: '1.3', fontWeight: 650, margin: '24px 0 0' } });
    case 'p':
      // pre-line keeps the address lines of the business data on their own lines.
      return host('p', 'Text', { children: block.text, style: { fontSize: '16px', lineHeight: '1.65', margin: 0, whiteSpace: 'pre-line' } });
    case 'list':
      return host(
        'ul',
        'List',
        { style: { margin: 0, paddingLeft: '22px', display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '16px', lineHeight: '1.6' } },
        block.items.map((item) => host('li', 'Item', { children: item })),
      );
  }
}

/**
 * The page's root: a readable column (max 760 px) holding the template's
 * blocks, in the home page's font and colours.
 */
export function legalPageRoot(template: LegalTemplate, look: LegalPageLook = {}): HostSnapshot {
  const article = host(
    'article',
    'Legal text',
    {
      style: {
        width: '100%',
        maxWidth: '760px',
        margin: '0 auto',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
      },
    },
    template.blocks.map(blockNode),
  );
  const main = host('main', 'Content', { style: { padding: '72px 24px 96px', display: 'flex', flexDirection: 'column' } }, [article]);
  return host(
    'div',
    'Page',
    {
      lang: template.language,
      style: {
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        minHeight: '100%',
        fontFamily: look.fontFamily || 'system-ui, sans-serif',
        color: look.color || '#111827',
        ...(look.backgroundColor ? { backgroundColor: look.backgroundColor } : {}),
      },
    },
    [main],
  );
}

export interface FooterLink {
  href: string;
  label: string;
}

/** Marks the footer nav the legal links live in, so a second run adds to it. */
export const LEGAL_LINKS_MARKER = 'data-legal-links';

export function footerLinkNode(link: FooterLink): HostSnapshot {
  return host('a', link.label, {
    href: link.href,
    children: link.label,
    style: { color: 'inherit', fontSize: '14px', textDecoration: 'underline', textUnderlineOffset: '3px' },
  });
}

/** The footer nav holding the legal links. */
export function footerLinksNav(links: FooterLink[], ariaLabel: string): HostSnapshot {
  return host(
    'nav',
    'Legal links',
    {
      [LEGAL_LINKS_MARKER]: '',
      'aria-label': ariaLabel,
      style: { display: 'flex', flexWrap: 'wrap', gap: '8px 20px', alignItems: 'center' },
    },
    links.map(footerLinkNode),
  );
}

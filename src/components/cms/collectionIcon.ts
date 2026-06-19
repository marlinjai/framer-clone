// src/components/cms/collectionIcon.ts
//
// A stable, deterministic icon for a collection, derived from its id. Shared by
// the sidebar collection list and the grid overlay so a collection looks the
// same everywhere. Until per-collection icons are user-editable (collection
// settings), this gives the list visual variety without any stored data.

import {
  Database,
  CalendarDays,
  Users,
  Package,
  FileText,
  Newspaper,
  Quote,
  Image as ImageIcon,
  Tag,
  Layers,
  MessageSquare,
  type LucideIcon,
} from 'lucide-react';

export const COLLECTION_ICONS: readonly LucideIcon[] = [
  Database,
  CalendarDays,
  Users,
  Package,
  FileText,
  Newspaper,
  Quote,
  ImageIcon,
  Tag,
  Layers,
  MessageSquare,
];

/** Pick a stable icon for a collection id (FNV-ish hash into the curated set). */
export function collectionIcon(id: string): LucideIcon {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return COLLECTION_ICONS[h % COLLECTION_ICONS.length];
}

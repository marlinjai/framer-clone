// src/components/cms/collectionIcon.ts
//
// Icons for collections. A collection can store a chosen icon (by key) in its
// table's `icon` field (collection settings); when none is set it falls back to
// a stable, deterministic icon derived from its id. Shared by the sidebar list,
// the grid overlay breadcrumb, and the icon picker.

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
  ShoppingBag,
  Star,
  MapPin,
  Briefcase,
  type LucideIcon,
} from 'lucide-react';

/** The pickable icon set, keyed by the string stored in the collection. */
export const COLLECTION_ICON_MAP = {
  database: Database,
  calendar: CalendarDays,
  users: Users,
  package: Package,
  file: FileText,
  news: Newspaper,
  quote: Quote,
  image: ImageIcon,
  tag: Tag,
  layers: Layers,
  message: MessageSquare,
  shop: ShoppingBag,
  star: Star,
  location: MapPin,
  work: Briefcase,
} as const;

export type CollectionIconName = keyof typeof COLLECTION_ICON_MAP;

export const COLLECTION_ICON_KEYS = Object.keys(COLLECTION_ICON_MAP) as CollectionIconName[];

/** Pick a stable icon for a collection id (FNV-ish hash into the set). */
export function collectionIcon(id: string): LucideIcon {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return COLLECTION_ICON_MAP[COLLECTION_ICON_KEYS[h % COLLECTION_ICON_KEYS.length]];
}

/** Resolve a collection's icon: its chosen key if valid, else the deterministic one. */
export function resolveCollectionIcon(iconKey: string | undefined, fallbackId: string): LucideIcon {
  if (iconKey && iconKey in COLLECTION_ICON_MAP) {
    return COLLECTION_ICON_MAP[iconKey as CollectionIconName];
  }
  return collectionIcon(fallbackId);
}

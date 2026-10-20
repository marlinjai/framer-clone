'use client';

// src/contexts/SiteAddressContext.tsx
//
// Where the open project's published site lives, for editor UI that shows a
// page's public URL (the page settings panel). Seeded by the editor route from
// the server (SiteRepository.getSiteAddress via the project loader) and
// updated by PublishButton after a publish, so the first publish shows the new
// address without a reload. Outside a provider (the standalone dev mount at
// `/`) it reads as "never published, no address".

import React from 'react';

export interface SiteAddress {
  /** The host visitors use (custom domain or `<label>.<base host>`), or null. */
  host: string | null;
  /** True once the site has been published at least once. */
  everPublished: boolean;
}

interface SiteAddressValue {
  address: SiteAddress;
  setAddress: (next: SiteAddress) => void;
}

const UNPUBLISHED: SiteAddress = { host: null, everPublished: false };

const SiteAddressContext = React.createContext<SiteAddressValue>({
  address: UNPUBLISHED,
  setAddress: () => {},
});

export function SiteAddressProvider({
  initial,
  children,
}: {
  initial?: SiteAddress;
  children: React.ReactNode;
}) {
  const [address, setAddress] = React.useState<SiteAddress>(initial ?? UNPUBLISHED);
  const value = React.useMemo(() => ({ address, setAddress }), [address]);
  return <SiteAddressContext.Provider value={value}>{children}</SiteAddressContext.Provider>;
}

export function useSiteAddress(): SiteAddressValue {
  return React.useContext(SiteAddressContext);
}

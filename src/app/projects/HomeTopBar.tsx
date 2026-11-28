// src/app/projects/HomeTopBar.tsx: the top bar of the projects home (Direction A,
// docs/plans/2026-11-23-sites-home-and-light-mode.md): the star and product name,
// the active company (a way to switch when there is more than one), the demo and
// the Lumitra account. A server component; plain anchors where the target is a
// full document load (the demo editor, the account portal on another origin).
import React from 'react';
import Link from 'next/link';
import LumitraStar from '@/components/brand/LumitraStar';
import { DEMO_PATH } from '@/lib/projects/demoAddress';
import AppearanceMenu from '@/components/appearance/AppearanceMenu';

const PILL =
  'inline-flex h-8 items-center gap-1.5 rounded-lg border border-input bg-card px-3 text-sm font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:shadow-selection';

interface HomeTopBarProps {
  companyName: string;
  canSwitchCompany: boolean;
  accountHref: string;
}

export default function HomeTopBar({ companyName, canSwitchCompany, accountHref }: HomeTopBarProps) {
  return (
    <header className="relative flex h-14 items-center gap-2 border-b border-border px-4 sm:gap-3 sm:px-6">
      <Link href="/projects" className="flex shrink-0 items-center gap-2 rounded-md font-semibold tracking-tight focus-visible:outline-none focus-visible:shadow-selection">
        <LumitraStar className="h-[18px] w-[18px] text-brand-mark" />
        <span className="max-sm:hidden">Lumitra Sites</span>
        <span className="sm:hidden">Sites</span>
      </Link>
      {canSwitchCompany ? (
        <Link href="/projects?switch=1" className={`${PILL} min-w-0`} title="Switch company">
          <span className="truncate">{companyName}</span>
          <span aria-hidden="true" className="text-muted-foreground">▾</span>
          <span className="sr-only">, switch company</span>
        </Link>
      ) : (
        <span className="min-w-0 truncate rounded-lg px-1 text-sm text-muted-foreground">{companyName}</span>
      )}
      <div className="flex-1" />
      <AppearanceMenu />
      <a href={DEMO_PATH} className={`${PILL} max-sm:hidden`}>
        Try the demo
      </a>
      <a href={accountHref} className={PILL}>
        Account
      </a>
    </header>
  );
}
// ci-replay touch

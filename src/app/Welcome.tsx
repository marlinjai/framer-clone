// src/app/Welcome.tsx: what a signed-out visitor sees at app.lumitra.co.
//
// Decided by Marlin on 2026-11-23 (docs/plans/2026-11-23-sites-home-and-light-mode.md, D4):
// a short welcome where "Try the editor" opens the demo with no account and "Sign in"
// goes to the shared Lumitra login and back to the projects. Plain anchors for the
// demo and the login: both are full document loads (the demo editor is a
// client-only bundle, the login another origin).
import React from 'react';
import Link from 'next/link';
import LumitraStar from '@/components/brand/LumitraStar';
import { DEMO_PATH } from '@/lib/projects/demoAddress';

interface WelcomeProps {
  signInHref: string;
  /** auth-brain did not answer: sign-in may fail for now, the demo works. */
  authUnavailable?: boolean;
}

export default function Welcome({ signInHref, authUnavailable = false }: WelcomeProps) {
  return (
    <div className="relative min-h-screen overflow-hidden bg-background text-foreground">
      <div aria-hidden="true" className="home-glow pointer-events-none absolute inset-0" />
      <header className="relative flex h-14 items-center gap-3 border-b border-border px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2 rounded-md font-semibold tracking-tight focus-visible:outline-none focus-visible:shadow-selection">
          <LumitraStar className="h-[18px] w-[18px] text-brand-mark" />
          Lumitra Sites
        </Link>
        <div className="flex-1" />
        <a
          href={signInHref}
          className="inline-flex h-8 items-center rounded-lg border border-input bg-card px-3 text-sm font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:shadow-selection"
        >
          Sign in
        </a>
      </header>

      <main className="relative mx-auto grid max-w-5xl items-center gap-10 px-6 py-14 sm:px-10 md:grid-cols-[1.1fr_1fr] md:py-20">
        <div>
          <h1 className="text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
            Build and run your website in one place.
          </h1>
          <p className="mt-3 max-w-md text-[15px] text-muted-foreground">
            Design pages visually, publish to your own domain, sell with the built-in shop. Try the editor right now, no
            account needed.
          </p>
          <div className="mt-6 flex flex-wrap gap-2.5">
            <a
              href={DEMO_PATH}
              className="inline-flex h-10 items-center rounded-lg border border-brand-edge bg-brand px-[18px] text-sm font-semibold text-brand-foreground transition-[filter] hover:brightness-95 focus-visible:outline-none focus-visible:shadow-selection"
            >
              Try the editor
            </a>
            <a
              href={signInHref}
              className="inline-flex h-10 items-center rounded-lg border border-input bg-card px-[18px] text-sm font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:shadow-selection"
            >
              Sign in
            </a>
          </div>
          <p className="mt-3.5 text-xs text-muted-foreground">
            The demo lives in this browser. Keep it as a project any time by signing in.
          </p>
          {authUnavailable ? (
            <p role="status" className="mt-3 max-w-md text-sm text-muted-foreground">
              Sign-in is not answering right now, so you may need to try it again in a moment. The editor works without it.
            </p>
          ) : null}
        </div>

        {/* A drawing of the editor (panels, canvas, page), not a screenshot. */}
        <div
          aria-hidden="true"
          className="grid aspect-[16/10] grid-cols-[22%_1fr_24%] overflow-hidden rounded-xl border border-border bg-card shadow-home"
        >
          <div className="border-r border-border bg-popover" />
          <div className="grid place-items-center bg-[var(--canvas-ground)]">
            <div className="h-[70%] w-[70%] rounded-md bg-white shadow-[0_4px_16px_rgb(0_0_0/0.15)]" />
          </div>
          <div className="border-l border-border bg-popover" />
        </div>
      </main>
    </div>
  );
}

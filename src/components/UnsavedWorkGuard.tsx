// src/components/UnsavedWorkGuard.tsx
//
// Keeps unsaved work of ANY project in this tab from being lost silently (plan
// docs/plans/2026-11-04-editor-autosave.md). Mounted once per editor route
// (the /projects layout, the preview layout and the demo editor at `/`):
//   - one beforeunload warning while any project's controller has a save in
//     flight or a working copy the server does not hold (anyUnsavedWork),
//     also a project the person left for the overview, Preview or another
//     project, whose save still retries, failed or waits for a choice;
//   - text still being typed in the canvas or the panel (openDrafts.ts)
//     counts too;
//   - when the page is hidden or left (pagehide, a hidden tab), the typed text
//     is committed and what is not saved goes out at once, as a request the
//     browser finishes after the page is gone when it fits the 64 KB limit
//     (larger projects rely on the normal request and the warning);
//   - back online, a waiting retry goes at once;
//   - a notice for such a project that is not on screen: its name, why it is
//     not saved (the retry countdown ticks), and a link back to it. The project
//     on screen has its own status in the top bar, so it is never named here.
'use client';

import React from 'react';
import Link from 'next/link';
import {
  allAutosaves,
  anyUnsavedWork,
  autosaveRegistryVersion,
  subscribeAutosaveRegistry,
  type AutosaveController,
} from '@/lib/projects/autosave';
import { saveFailureReason, useNow } from '@/hooks/useAutosave';
import { commitOpenDrafts, hasOpenDrafts } from '@/lib/projects/openDrafts';

/** A project left with work that is not on the server, and why. */
export interface LeftBehind {
  projectId: string;
  title: string;
  reason: string;
}

/** Commit typed text and send what is not saved, before the page goes. */
export function saveBeforeLeaving(): void {
  commitOpenDrafts();
  for (const controller of allAutosaves()) void controller.saveOnLeave();
}

function leftBehind(controller: AutosaveController, now: number): LeftBehind | undefined {
  if (controller.isAttached()) return undefined;
  const state = controller.getState();
  const reason =
    state.phase === 'conflict'
      ? 'It was changed somewhere else, so this tab stopped saving it until you choose what to keep.'
      : saveFailureReason(state, now);
  if (!reason || !controller.hasUnsavedWork()) return undefined;
  return { projectId: controller.projectId, title: controller.projectTitle() || 'A project', reason };
}

export default function UnsavedWorkGuard() {
  React.useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!anyUnsavedWork() && !hasOpenDrafts()) return;
      // Both, for every browser: the wording is the browser's own.
      event.preventDefault();
      event.returnValue = '';
    };
    const onPageHide = () => saveBeforeLeaving();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') saveBeforeLeaving();
    };
    const onOnline = () => {
      for (const controller of allAutosaves()) void controller.retryIfWaiting();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
    };
  }, []);

  // Re-renders on every change of any controller; only a project not on screen
  // with a failure or a pause is checked against the server copy.
  React.useSyncExternalStore(subscribeAutosaveRegistry, autosaveRegistryVersion, () => 0);
  const ticking = allAutosaves().some((c) => !c.isAttached() && c.getState().phase === 'retrying');
  const now = useNow(ticking);
  const left = allAutosaves()
    .map((c) => leftBehind(c, now))
    .filter((x): x is LeftBehind => !!x);
  if (left.length === 0) return <div role="status" aria-live="polite" className="sr-only" />;

  return (
    <div
      role="status"
      aria-live="polite"
      data-editor-ui="true"
      data-testid="unsaved-work-notice"
      className="fixed inset-x-4 bottom-4 z-[1200] mx-auto flex max-w-[560px] flex-col gap-1.5 rounded-md border border-destructive/40 bg-background px-3 py-2 text-xs text-foreground shadow-lg"
    >
      {left.map((item) => (
        <p key={item.projectId} className="flex flex-wrap items-baseline gap-x-2">
          <span>
            <strong className="font-medium">{item.title}</strong> is not saved. {item.reason}
          </span>
          <Link
            href={`/projects/${encodeURIComponent(item.projectId)}`}
            className="font-medium text-brand underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            Go back to it
          </Link>
        </p>
      ))}
    </div>
  );
}

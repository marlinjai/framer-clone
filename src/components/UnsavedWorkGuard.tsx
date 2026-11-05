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
import { KEEPALIVE_BODY_MAX_BYTES } from '@/lib/projects/projectWrite';
import { resolveAction } from '@/lib/keyBindings';

/** A project left with work that is not on the server, and why. */
export interface LeftBehind {
  projectId: string;
  title: string;
  reason: string;
  /** What kind of trouble, for the announcement: it is made only when this changes. */
  kind: string;
}

/**
 * Commit typed text (without ending an edit in progress) and send what is not
 * saved, before the page goes. The browser caps all keepalive bodies of a page
 * at 64 KB together: the project on screen goes first, the others take what is
 * left, and a body that does not fit goes as a normal request.
 */
export function saveBeforeLeaving(): void {
  commitOpenDrafts('keep');
  const budget = { remaining: KEEPALIVE_BODY_MAX_BYTES };
  const controllers = allAutosaves().sort((a, b) => Number(b.isAttached()) - Number(a.isAttached()));
  for (const controller of controllers) void controller.saveOnLeave(budget);
}

function leftBehind(controller: AutosaveController, now: number): LeftBehind | undefined {
  if (controller.isAttached()) return undefined;
  const state = controller.getState();
  const reason =
    state.phase === 'conflict'
      ? 'Changed elsewhere: go back to it to choose what to keep. Saving waits until then.'
      : saveFailureReason(state, now);
  if (!reason || !controller.hasUnsavedWork()) return undefined;
  const kind = state.phase === 'conflict' ? 'conflict' : `failed:${state.phase === 'failed' || state.phase === 'retrying' ? (state.status ?? 'network') : ''}`;
  return { projectId: controller.projectId, title: controller.projectTitle() || 'A project', reason, kind };
}

/**
 * `saveShortcut` (the /projects routes): Cmd/Ctrl+S never opens the browser's
 * "save page" dialog, and saves the projects left behind at once. On an editor
 * page the editor's own shortcut saves the project on screen.
 */
export default function UnsavedWorkGuard({ saveShortcut = false }: { saveShortcut?: boolean }) {
  React.useEffect(() => {
    if (!saveShortcut) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (resolveAction(event)?.action !== 'save') return;
      event.preventDefault();
      // A project changed elsewhere waits for a choice made in its editor: its
      // dialog is never opened here, with no status on screen to go with it.
      for (const controller of allAutosaves()) {
        if (!controller.isAttached() && controller.getState().phase !== 'conflict') void controller.flush();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [saveShortcut]);

  React.useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!anyUnsavedWork() && !hasOpenDrafts()) return;
      // Both, for every browser: the wording is the browser's own.
      event.preventDefault();
      event.returnValue = '';
    };
    const onPageHide = () => saveBeforeLeaving();
    const recover = () => {
      for (const controller of allAutosaves()) void controller.recover();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') saveBeforeLeaving();
      else recover();
    };
    const onOnline = recover;
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
  // A screen reader hears an item when it first appears or changes kind, never
  // the countdown ticking in the visible notice (which is not a live region).
  const signature = left.map((item) => `${item.projectId}:${item.kind}`).join('|');
  const [announced, setAnnounced] = React.useState({ signature: '', text: '' });
  if (signature !== announced.signature) {
    const before = new Set(announced.signature.split('|'));
    const fresh = left.filter((item) => !before.has(`${item.projectId}:${item.kind}`));
    setAnnounced({
      signature,
      text: fresh.length > 0 ? fresh.map((item) => `${item.title} is not saved. ${item.reason}`).join(' ') : announced.text,
    });
  }
  const region = (
    <div role="status" aria-live="polite" data-testid="unsaved-work-announcement" className="sr-only">
      {announced.text}
    </div>
  );
  if (left.length === 0) return region;

  return (
    <>
    {region}
    <div
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
    </>
  );
}

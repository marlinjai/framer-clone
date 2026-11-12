'use client';

// src/components/branches/review/ReviewScreen.tsx
//
// The review of a site branch (docs/plans/2026-11-10-site-branches.md, section 3 "A reviewer", slice S5): what the
// branch changes, grouped by page, main next to the branch with the changed elements outlined, the questions an
// update from main asks, and the review's own steps: "Looks good", send back with a note, and the merge.
//
// The review data (the change list, the questions, the token) is read from the server here; the two pictures come
// with the page. When the data names newer versions than the pictures, the page reloads them, so new questions are
// never shown beside old pictures. Answers are stored as they are given, one request at a time, and a reload or
// another tab finds them (section 6, "Resume").

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Check, GitMerge, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import ProjectModel, { type ProjectModelType, type ProjectSnapshotOut } from '@/models/ProjectModel';
import SharePreview from '@/components/branches/SharePreview';
import { BranchApiError, branchClient, type BranchReviewJson, type MergeSideJson, type ShownConflictJson } from '@/lib/sites/branchClient';
import type { UnitReview } from '@/lib/siteMerge/elementChanges';
import { ReviewPane } from './ReviewPane';
import { choiceText, conflictText, escapeId, fieldText, KIND_COLOR, KIND_TEXT, mergeBlocker, outlineSheet, totalsText, valueText } from './reviewText';

/** How often an open review reads the server again (also on returning to the tab). */
export const REVIEW_REFRESH_MS = 30_000;
const NOTE_MAX = 2_000;

export interface ReviewScreenProps {
  branchId: string;
  branchName: string;
  mainSiteId: string;
  mainName: string;
  branch: { snapshot: ProjectSnapshotOut; version: number };
  main: { snapshot: ProjectSnapshotOut; version: number };
  /** Null: the permission service did not answer; every control stays on and the server decides. */
  can: { edit: boolean; review: boolean; merge: boolean } | null;
}

function messageOf(err: unknown): string {
  if (err instanceof BranchApiError) return err.message;
  return 'Something went wrong. Nothing was changed; try again.';
}

/** A read-only copy for drawing: never registered with the editor, never saved, never synced. */
function drawingCopy(snapshot: ProjectSnapshotOut): ProjectModelType {
  return ProjectModel.create(snapshot);
}

/** The page a pane draws for a unit: the page itself, or a component's own page. */
function drawnPage(model: ProjectModelType, unit: UnitReview | undefined) {
  if (!unit) return undefined;
  if (unit.unit === 'page') return model.getPage(unit.id);
  return model.components.get(unit.id)?.page as ReturnType<ProjectModelType['getPage']>;
}

type Loaded = { kind: 'loading' } | { kind: 'failed'; message: string } | { kind: 'ok'; review: BranchReviewJson };

export function ReviewScreen({ branchId, branchName, mainSiteId, mainName, branch, main, can }: ReviewScreenProps) {
  const router = useRouter();
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [busy, setBusy] = useState<null | 'answer' | 'update' | 'approve' | 'send-back' | 'merge'>(null);
  const [notice, setNotice] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);
  const [merged, setMerged] = useState(false);
  const [note, setNote] = useState('');
  const [sendingBack, setSendingBack] = useState(false);
  const [unitId, setUnitId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const reloadedFor = useRef<string | null>(null);
  const lastToken = useRef<string | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const reasonId = React.useId();

  const branchModel = useMemo(() => drawingCopy(branch.snapshot), [branch.snapshot]);
  const mainModel = useMemo(() => drawingCopy(main.snapshot), [main.snapshot]);

  const show = useCallback(
    (review: BranchReviewJson) => {
      setLoaded({ kind: 'ok', review });
      // The pictures are of older reads than the data: reload them, once per state. A version moves with every
      // write and every erase of personal data; the token also moves with a rename, which writes no version.
      const v = review.versions;
      const older = v !== undefined && (v.main !== main.version || v.branch !== branch.version);
      const moved = lastToken.current !== null && lastToken.current !== review.token;
      lastToken.current = review.token;
      if ((older || moved) && reloadedFor.current !== review.token) {
        reloadedFor.current = review.token;
        router.refresh();
      }
    },
    [router, main.version, branch.version],
  );

  const failed = useCallback(
    (err: unknown) => {
      // A branch merged or discarded meanwhile: the page says so and links to its site.
      if (err instanceof BranchApiError && (err.code === 'branch_closed' || err.status === 404)) {
        router.refresh();
        return;
      }
      setLoaded((now) => (now.kind === 'ok' ? now : { kind: 'failed', message: messageOf(err) }));
      setNotice({ tone: 'error', text: messageOf(err) });
    },
    [router],
  );

  const read = useCallback(() => branchClient.changes(branchId).then(show, failed), [branchId, show, failed]);

  useEffect(() => {
    if (merged) return;
    void read();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void read();
    }, REVIEW_REFRESH_MS);
    const onVisible = () => document.visibilityState === 'visible' && void read();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [read, merged]);

  const review = loaded.kind === 'ok' ? loaded.review : null;
  const units = review?.review?.units ?? [];
  const unit: UnitReview | undefined = units.find((u) => u.id === unitId) ?? units[0];

  /** A refusal because the state moved: read again and say so. */
  const stale = (err: unknown) => {
    if (err instanceof BranchApiError && (err.code === 'branch_review_stale' || err.code === 'branch_updated_from_main')) {
      setNotice({
        tone: 'info',
        text:
          err.code === 'branch_updated_from_main'
            ? `${mainName}’s changes were brought into the branch first. Look at the review again, then merge.`
            : 'The site changed while you were reviewing. The review now shows it as it is.',
      });
      void read();
      return true;
    }
    return false;
  };

  /** Answers go one at a time, in the order given; each one's review is the newest. */
  function answer(resolutions: Record<string, { fingerprint: string; pick: MergeSideJson }>) {
    if (!review) return;
    setBusy('answer');
    setNotice(null);
    const token = review.token;
    queue.current = queue.current
      .then(() => branchClient.answers(branchId, token, resolutions))
      .then(show, (err) => (stale(err) ? undefined : failed(err)))
      .finally(() => setBusy(null));
  }

  function answerAll(pick: MergeSideJson) {
    if (!review) return;
    const all = [...review.conflicts, ...review.settled.map((s) => s.conflict).filter((c): c is ShownConflictJson => Boolean(c))];
    answer(Object.fromEntries(all.filter((c) => c.options.includes(pick)).map((c) => [c.id, { fingerprint: c.fingerprint, pick }])));
  }

  async function act(kind: 'update' | 'approve' | 'send-back' | 'merge') {
    if (!review) return;
    setBusy(kind);
    setNotice(null);
    try {
      if (kind === 'update') {
        await branchClient.update(branchId, review.token);
        setNotice({ tone: 'info', text: `${mainName}’s changes are in the branch now.` });
        router.refresh();
        await read();
      } else if (kind === 'approve') {
        await branchClient.approve(branchId, review.token);
        setNotice({ tone: 'info', text: 'Marked as looking good. An edit to the branch withdraws it.' });
        await read();
      } else if (kind === 'send-back') {
        await branchClient.sendBack(branchId, review.token, note.trim());
        setSendingBack(false);
        setNote('');
        setNotice({ tone: 'info', text: 'Sent back with your note. Whoever works on the branch sees it there.' });
        await read();
      } else {
        await branchClient.merge(branchId, review.token);
        setMerged(true);
      }
    } catch (err) {
      if (!stale(err)) {
        if (err instanceof BranchApiError && err.code === 'branch_conflicts') {
          setNotice({ tone: 'error', text: 'Some questions still need an answer, so nothing was changed.' });
          await read();
        } else failed(err);
      }
    } finally {
      setBusy(null);
    }
  }

  if (merged) {
    return (
      <main className="mx-auto flex max-w-xl flex-col gap-3 p-8">
        {/* The screen is new, so a live region would say nothing: the heading takes the focus and is read. */}
        <h1 className="text-lg font-semibold outline-none" tabIndex={-1} ref={(el) => el?.focus()}>
          Merged into {mainName}
        </h1>
        <p className="text-sm text-muted-foreground">
          The branch “{branchName}” is closed and its changes are in {mainName}. Nothing was published: publish from {mainName} when it is ready.
        </p>
        <p className="text-sm text-muted-foreground">
          Changed your mind? For 30 days, and as long as no other branch is merged into {mainName}, this merge can be undone from the branch’s
          page.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button asChild>
            <a href={`/projects/${encodeURIComponent(mainSiteId)}`}>Open {mainName}</a>
          </Button>
          <Button asChild variant="outline">
            <a href={`/projects/${encodeURIComponent(branchId)}`}>Undo this merge…</a>
          </Button>
        </div>
      </main>
    );
  }

  const blocker = review ? mergeBlocker(review, can?.merge) : 'Reading the review…';
  const editOff = can?.edit === false ? 'Only someone who may edit this site can answer.' : undefined;
  const reviewOff = can?.review === false ? 'You may not review branches of this site.' : undefined;
  // In one fixed order (by id), answered or not: a question a person has just answered stays where it is, and
  // with it the keyboard's focus. Sorted open-first, an answered one would jump to the end on every answer.
  const allConflicts = review
    ? [...review.conflicts.map((c) => ({ c, pick: null as MergeSideJson | null })), ...review.settled.filter((s) => s.conflict).map((s) => ({ c: s.conflict!, pick: s.pick }))].sort((a, b) =>
        a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : 0,
      )
    : [];
  /** Why an answer cannot be given now (text for a described reason), or null. While one is being stored: no reason, just not yet. */
  const answerOff = (c: ShownConflictJson, side: MergeSideJson): string | null =>
    editOff ?? (!c.options.includes(side) ? 'This answer is not possible here.' : busy !== null ? 'wait' : null);
  const openCount = review?.conflicts.length ?? 0;
  const behind = Boolean(review && !review.upToDate);
  // What a pane says when it draws nothing, by why: still reading, could not read, nothing changed, nothing picked.
  const idleText =
    loaded.kind === 'loading' ? 'Reading the changes…' : loaded.kind === 'failed' ? 'The changes could not be read.' : units.length === 0 ? 'This branch changes no page yet.' : 'Pick a page on the left.';
  const mainPage = drawnPage(mainModel, unit);
  const branchPage = drawnPage(branchModel, unit);
  const status = review?.branch;

  return (
    <main className="flex h-dvh flex-col bg-background text-foreground" data-review-screen="">
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2">
        <Button asChild variant="ghost" size="sm">
          <a href={`/projects/${encodeURIComponent(branchId)}`}>
            <ArrowLeft aria-hidden /> Back to the branch
          </a>
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">
            Review “{branchName}” for {mainName}
          </h1>
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {review?.review ? totalsText(review.review) : loaded.kind === 'failed' ? 'The changes could not be read.' : 'Reading the changes…'}
            {status?.approved ? ' · Looks good' : status?.status === 'ready' ? ' · Ready for review' : ''}
          </p>
        </div>
        <SharePreview
          mainSiteId={mainSiteId}
          branchId={branchId}
          branchName={branchName}
          disabledReason={can?.edit === false ? 'Only someone who may edit this site can share a preview.' : undefined}
        />
        <Button size="sm" variant="outline" disabled={!review || busy !== null || Boolean(reviewOff) || status?.approved} aria-pressed={Boolean(status?.approved)} title={reviewOff} onClick={() => act('approve')}>
          <Check aria-hidden /> Looks good
        </Button>
        <Button size="sm" variant="outline" disabled={!review || busy !== null || Boolean(reviewOff)} title={reviewOff} aria-expanded={sendingBack} onClick={() => setSendingBack((v) => !v)}>
          <Undo2 aria-hidden /> Send back
        </Button>
        {/* Behind main, the press brings main's changes into the branch and stops for another look: say that. */}
        <Button
          size="sm"
          variant="brand"
          disabled={!review || busy !== null || blocker !== null}
          title={blocker ?? (behind ? `Brings the changes made to ${mainName} into the branch first. Then look again and merge.` : `Merge into ${mainName}. Nothing is published.`)}
          onClick={() => act('merge')}
        >
          <GitMerge aria-hidden /> {busy === 'merge' ? (behind ? 'Updating…' : 'Merging…') : behind ? `Update from ${mainName} first` : `Merge into ${mainName}`}
        </Button>
      </header>

      {sendingBack ? (
        <form
          className="flex flex-wrap items-end gap-2 border-b border-border px-4 py-2"
          onSubmit={(e) => {
            e.preventDefault();
            void act('send-back');
          }}
        >
          <label className="flex min-w-[16rem] flex-1 flex-col gap-1 text-xs">
            What should change before it is merged?
            <textarea
              className="min-h-[3rem] rounded-md border border-input bg-background p-2 text-sm"
              value={note}
              maxLength={NOTE_MAX}
              onChange={(e) => setNote(e.target.value)}
              autoFocus
            />
          </label>
          <Button type="submit" size="sm" disabled={busy !== null || note.trim() === ''}>
            Send back
          </Button>
        </form>
      ) : null}

      {notice || blocker || status?.reviewNote || reviewOff || editOff ? (
        <div className="flex flex-col gap-1 border-b border-border px-4 py-2 text-sm" aria-live="polite">
          {notice ? (
            <p role={notice.tone === 'error' ? 'alert' : 'status'} className={notice.tone === 'error' ? 'text-destructive' : ''}>
              {notice.text}
            </p>
          ) : null}
          {loaded.kind === 'failed' ? (
            <div>
              <Button size="sm" variant="outline" onClick={() => void read()}>
                Try again
              </Button>
            </div>
          ) : null}
          {status?.reviewNote && status.status === 'open' ? <p className="text-muted-foreground">Sent back with the note: “{status.reviewNote}”</p> : null}
          {review && blocker ? <p className="text-muted-foreground">Merge is not possible yet: {blocker}</p> : null}
          {/* Why a button is off, in words everyone can reach: a disabled button's tooltip is not. */}
          {reviewOff ? <p className="text-muted-foreground">“Looks good” and “Send back” are off: {reviewOff}</p> : null}
          {editOff ? <p className="text-muted-foreground">The answers are off: {editOff}</p> : null}
        </div>
      ) : null}

      {/* On a narrow window the list sits above the panes, and the two panes above each other. */}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* Not a navigation landmark: it holds the questions and their answers as well as the list of changes. */}
        <div role="region" className="max-h-[45dvh] w-full shrink-0 overflow-auto border-b border-border p-3 text-sm lg:max-h-none lg:w-80 lg:border-b-0 lg:border-r" aria-label="Questions and changes">
          {review && !review.upToDate ? (
            <section className="mb-4 rounded-md border border-border p-2" aria-label={`${mainName} changed`}>
              <p className="mb-2">
                {mainName} has changed since this branch began. {openCount > 0 ? 'Answer each question, then update the branch.' : 'Update the branch to bring those changes in.'}
              </p>
              {allConflicts.length > 0 ? (
                <>
                  <div className="mb-2 flex gap-2">
                    <Button size="sm" variant="outline" disabled={busy !== null || Boolean(editOff)} title={editOff} onClick={() => answerAll('main')}>
                      All from {mainName}
                    </Button>
                    <Button size="sm" variant="outline" disabled={busy !== null || Boolean(editOff)} title={editOff} onClick={() => answerAll('branch')}>
                      All from the branch
                    </Button>
                  </div>
                  <span id={`${reasonId}-edit`} className="sr-only">{editOff ?? ''}</span>
                  <span id={`${reasonId}-option`} className="sr-only">This answer is not possible here.</span>
                  <ol className="flex flex-col gap-2">
                    {allConflicts.map(({ c, pick }) => (
                      <li key={c.id} className="rounded border border-border p-2" data-conflict={c.id}>
                        <p className="font-medium">{conflictText(c, review.review)}</p>
                        <div className="mt-1 grid gap-1">
                          {(['main', 'branch'] as const).map((side) => (
                            <Button
                              key={side}
                              size="sm"
                              variant={pick === side ? 'default' : 'outline'}
                              aria-pressed={pick === side}
                              // Never `disabled`: the button a person just pressed keeps the keyboard's focus while
                              // the answer is stored, and one that cannot be used says why to everyone.
                              aria-disabled={answerOff(c, side) ? true : undefined}
                              aria-describedby={answerOff(c, side) && !busy ? `${reasonId}-${answerOff(c, side) === editOff ? 'edit' : 'option'}` : undefined}
                              className={`h-auto justify-start whitespace-normal break-words text-left ${answerOff(c, side) ? 'cursor-not-allowed opacity-60' : ''}`}
                              onClick={() => {
                                if (!answerOff(c, side)) answer({ [c.id]: { fingerprint: c.fingerprint, pick: side } });
                              }}
                            >
                              {choiceText(c, side, mainName)}
                            </Button>
                          ))}
                        </div>
                      </li>
                    ))}
                  </ol>
                </>
              ) : null}
              <Button
                className="mt-2"
                size="sm"
                disabled={busy !== null || openCount > 0 || Boolean(editOff)}
                title={editOff ?? (openCount > 0 ? 'Every question needs an answer first.' : undefined)}
                onClick={() => act('update')}
              >
                {busy === 'update' ? 'Updating…' : 'Update the branch'}
              </Button>
            </section>
          ) : null}

          {review?.problems.length ? (
            <ul className="mb-4 flex flex-col gap-1" aria-label="Problems">
              {review.problems.map((p) => (
                <li key={p.code + p.message} role="alert" className="text-destructive">
                  {p.message}
                </li>
              ))}
            </ul>
          ) : null}

          {review?.review && (review.review.site.length > 0 || review.review.settings.length > 0) ? (
            <section className="mb-3" aria-label="Site settings">
              <h2 className="mb-1 font-medium">Site settings</h2>
              <ul className="flex flex-col gap-1">
                {[...review.review.site, ...review.review.settings].map((f) => (
                  <li key={f.field} className="text-xs">
                    <span className="font-medium">{fieldText(f.field)}:</span> {valueText(f.before)} → {valueText(f.after)}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <ul className="flex flex-col gap-2">
            {units.map((u) => (
              <li key={`${u.unit}:${u.id}`}>
                <button
                  type="button"
                  className={`w-full rounded px-2 py-1 text-left font-medium hover:bg-muted ${u === unit ? 'bg-muted' : ''}`}
                  aria-current={u === unit ? 'true' : undefined}
                  onClick={() => {
                    setUnitId(u.id);
                    setFocusId(null);
                  }}
                >
                  {u.unit === 'component' ? 'Component ' : ''}
                  {u.title}
                  <span className="ml-1 text-xs font-normal text-muted-foreground">
                    {u.change === 'added' ? 'new' : u.change === 'removed' ? 'removed' : `${u.elements.length + u.fields.length} changed`}
                  </span>
                </button>
                {u === unit ? (
                  <ul className="mt-1 flex flex-col gap-1 pl-2">
                    {u.slug && u.slug.before !== u.slug.after && u.slug.before !== null && u.slug.after !== null ? (
                      <li className="text-xs">
                        Address: /{u.slug.before} → /{u.slug.after}
                      </li>
                    ) : null}
                    {u.fields
                      .filter((f) => f.field !== 'slug')
                      .map((f) => (
                        <li key={f.field} className="text-xs">
                          <span className="font-medium">{fieldText(f.field)}</span> changed
                        </li>
                      ))}
                    {u.elements.map((e) => (
                      <li key={e.id}>
                        <button
                          type="button"
                          className={`min-h-6 w-full rounded px-1 py-1 text-left text-xs hover:bg-muted ${focusId === e.id ? 'bg-muted' : ''}`}
                          aria-current={focusId === e.id ? 'true' : undefined}
                          data-element={e.id}
                          onClick={() => setFocusId(e.id)}
                        >
                          <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: KIND_COLOR[e.kind] }} aria-hidden />
                          <span className="font-medium">{KIND_TEXT[e.kind]}</span> {e.label}
                          {e.fields.map((f) => (
                            <span key={f.field} className="block pl-3 text-muted-foreground">
                              {fieldText(f.field)}: {valueText(f.before)} → {valueText(f.after)}
                            </span>
                          ))}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
          {review?.review && units.length === 0 && review.review.site.length + review.review.settings.length === 0 ? (
            <p className="text-muted-foreground">
              {review.unchanged === false
                ? 'This branch changes no page: it only arranges the frames on the editor’s canvas differently. Merging brings that arrangement to the site.'
                : 'This branch changes nothing yet.'}
            </p>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-2 overflow-hidden p-3">
          {unit?.unit === 'component' ? (
            <p className="text-xs text-muted-foreground">The component “{unit.title}” on its own; every page that places it shows the same change.</p>
          ) : null}
          {review && !review.upToDate ? (
            <p className="text-xs text-muted-foreground">
              The outlines mark what the branch changed since it began. {mainName} has changed since then, so some may not be on its side.
            </p>
          ) : null}
          <div className="flex min-h-0 flex-1 flex-col gap-3 sm:flex-row">
            <ReviewPane
              side="main"
              title={`${mainName} (main)`}
              page={mainPage}
              site={mainModel.site}
              emptyText={unit?.change === 'added' ? `This ${unit.unit} is new on the branch.` : idleText}
              outlines={outlineSheet(unit, 'main', focusId, escapeId)}
              focusId={focusId}
            />
            <ReviewPane
              side="branch"
              title={`${branchName} (branch)`}
              page={branchPage}
              site={branchModel.site}
              emptyText={unit?.change === 'removed' ? `The branch removes this ${unit.unit}.` : idleText}
              outlines={outlineSheet(unit, 'branch', focusId, escapeId)}
              focusId={focusId}
            />
          </div>
        </div>
      </div>
    </main>
  );
}

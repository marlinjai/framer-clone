'use client';

// src/components/branches/SharePreview.tsx
//
// "Share preview": the public preview link of a branch (site branches, slice
// S8, docs/plans/2026-11-10-site-branches.md, section 7). The dialog says what
// the link is before it makes one: an address anyone can open without an
// account, showing this branch read only, until it expires or is revoked.
//
// The server keeps only a hash of the address, so it can be shown exactly
// once, when the link is made. Every other state says so and offers what is
// still possible:
//   - no link yet: choose how long it works, make it;
//   - just made: the address, with Copy;
//   - a link from before (this dialog reopened, another person's link): until
//     when it works, replace it or revoke it, never its address;
//   - an expired link: the same, said as expired.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link2 } from 'lucide-react';
import { BarTooltip, ICON_ONLY } from '@/components/topbar/BarTooltip';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { BranchApiError, branchClient, type PreviewLinkJson } from '@/lib/sites/branchClient';

const DAY = new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeZone: 'UTC' });
const MOMENT = new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' });
/** The moment a link ends, to the minute: a link made late in the day ends at that time of its last day, not at midnight. */
const until = (iso: string) => `${MOMENT.format(new Date(iso))} UTC`;
const isClosed = (err: unknown) => err instanceof BranchApiError && (err.status === 410 || err.code === 'branch_closed');
const DAYS = [1, 7, 30] as const;

/** What a refusal means for the person. */
export function sharePreviewErrorText(err: unknown): string {
  if (err instanceof BranchApiError) {
    if (err.status === 403) return 'You may not edit this site, so you cannot share or revoke its preview. Ask someone who can.';
    if (isClosed(err)) return 'This branch is closed, so it has no preview any more.';
    return err.message;
  }
  return 'That did not work. Nothing was changed; try again.';
}

type Loaded =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  /** The branch was merged or discarded meanwhile: it has no preview, and nothing here can change that. */
  | { kind: 'closed' }
  | { kind: 'ready'; link: PreviewLinkJson | null; url: string | null };

export default function SharePreview({
  mainSiteId,
  branchId,
  branchName,
  disabledReason,
  compact = false,
  iconOnly = false,
  copy = (text: string) => navigator.clipboard.writeText(text),
}: {
  /** In the editor's top bar: under 1024px the label folds into the icon (the name stays for a screen reader). */
  compact?: boolean;
  /** The wide top bar folded its words into the icon (docs/plans/2026-11-12-top-bar-fold.md). */
  iconOnly?: boolean;
  mainSiteId: string;
  branchId: string;
  branchName: string;
  /** Why the person cannot share (no right to edit); the button then says so and stays off. */
  disabledReason?: string;
  /** Writes to the clipboard (tests replace it). */
  copy?: (text: string) => Promise<void>;
}) {
  const [shown, setShown] = useState(false);
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [days, setDays] = useState<number>(7);
  const [busy, setBusy] = useState<'make' | 'revoke' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const address = useRef<HTMLInputElement>(null);

  // Every read and every change takes a number; an answer is used only while its number is still the latest.
  // Otherwise a slow read from before could arrive after a link was made and wipe the address off the dialog.
  const latest = useRef(0);
  const reasonId = React.useId();

  const load = useCallback(async () => {
    const mine = ++latest.current;
    setLoaded({ kind: 'loading' });
    try {
      const { link } = await branchClient.previewLink(mainSiteId, branchId);
      if (mine === latest.current) setLoaded({ kind: 'ready', link, url: null });
    } catch (err) {
      if (mine === latest.current) setLoaded(isClosed(err) ? { kind: 'closed' } : { kind: 'failed', message: sharePreviewErrorText(err) });
    }
  }, [mainSiteId, branchId]);

  useEffect(() => {
    if (shown) void load();
  }, [shown, load]);

  async function make() {
    setBusy('make');
    setError(null);
    setCopied(null);
    const mine = ++latest.current;
    try {
      const { link } = await branchClient.makePreviewLink(mainSiteId, branchId, days);
      if (mine === latest.current) setLoaded({ kind: 'ready', link, url: link.url });
    } catch (err) {
      if (isClosed(err)) setLoaded({ kind: 'closed' });
      else setError(sharePreviewErrorText(err));
    }
    setBusy(null);
  }

  async function revoke() {
    setBusy('revoke');
    setError(null);
    const mine = ++latest.current;
    try {
      await branchClient.revokePreviewLink(mainSiteId, branchId);
      setCopied(null);
      if (mine === latest.current) setLoaded({ kind: 'ready', link: null, url: null });
    } catch (err) {
      if (isClosed(err)) setLoaded({ kind: 'closed' });
      else setError(sharePreviewErrorText(err));
    }
    setBusy(null);
  }

  async function copyAddress(url: string) {
    try {
      await copy(url);
      setCopied('yes');
    } catch {
      // Clipboard access refused: the address is selected so it can be copied by hand.
      address.current?.select();
      setCopied('failed');
    }
  }

  const link = loaded.kind === 'ready' ? loaded.link : null;
  const url = loaded.kind === 'ready' ? loaded.url : null;

  const shareButton = (
    <Button
      ref={trigger}
      type="button"
      size="sm"
      variant="outline"
      // Not `disabled`: the button stays reachable by keyboard so the reason can be read, and does nothing.
      aria-disabled={disabledReason ? true : undefined}
      // Only with a reason: an `aria-describedby` of undefined would replace the tooltip's own description.
      {...(disabledReason ? { 'aria-describedby': reasonId } : {})}
      title={compact ? undefined : disabledReason}
      className={`${disabledReason ? 'cursor-not-allowed opacity-50' : ''} ${iconOnly ? ICON_ONLY : ''}`}
      onClick={() => {
        if (!disabledReason) setShown(true);
      }}
    >
      <Link2 aria-hidden />
      <span data-fold-label="" className={iconOnly ? 'sr-only' : compact ? 'max-lg:sr-only' : undefined}>
        Share preview
      </span>
    </Button>
  );
  // In the top bar the label can fold away: a tooltip that hover and focus open says what it does.

  return (
    <>
      {compact ? <BarTooltip text={disabledReason ?? 'Share a preview link of this branch'}>{shareButton}</BarTooltip> : shareButton}
      {disabledReason ? (
        <span id={reasonId} className="sr-only">
          {disabledReason}
        </span>
      ) : null}
      <Dialog
        open={shown}
        onOpenChange={(next) => {
          if (busy) return;
          setShown(next);
          if (!next) {
            // The address is not kept once the dialog closes: it cannot be shown again. An answer still on its
            // way belongs to the dialog that was closed.
            latest.current++;
            setError(null);
            setCopied(null);
            setLoaded({ kind: 'loading' });
          }
        }}
      >
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            trigger.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Share a preview of “{branchName}”</DialogTitle>
            <DialogDescription>
              A preview link shows this branch, as it is at the moment it is opened, to anyone who has the address. No account is
              needed. It is read only: forms and checkout are switched off, and search engines are told to stay away. The branch
              is not published.
            </DialogDescription>
          </DialogHeader>

          {loaded.kind === 'loading' ? <p className="text-sm text-muted-foreground">Reading the link…</p> : null}
          {loaded.kind === 'closed' ? (
            <p role="alert" className="text-sm">
              This branch was merged or discarded, so it has no preview any more. A link it had shows nothing.
            </p>
          ) : null}
          {loaded.kind === 'failed' ? (
            <div className="flex flex-col gap-2">
              <p role="alert" className="text-sm text-destructive">
                {loaded.message}
              </p>
              <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => void load()}>
                Try again
              </Button>
            </div>
          ) : null}

          {loaded.kind === 'ready' && url ? (
            <div className="flex flex-col gap-2">
              <label className="flex flex-col gap-1 text-sm">
                The address
                <input
                  ref={address}
                  readOnly
                  value={url}
                  onFocus={(event) => event.currentTarget.select()}
                  className="rounded-md border border-input bg-background p-2 font-mono text-xs"
                />
              </label>
              <div className="flex items-center gap-3">
                <Button type="button" size="sm" onClick={() => void copyAddress(url)}>
                  Copy the address
                </Button>
                <span role="status" className="text-xs text-muted-foreground">
                  {copied === 'yes' ? 'Copied.' : copied === 'failed' ? 'Copying was not allowed: the address is selected, copy it by hand.' : ''}
                </span>
              </div>
              <p className="text-sm text-muted-foreground">
                It works until {until(link!.expiresAt)}. Copy it now: it is not stored and cannot be shown again
                after this dialog closes. Whoever has it can pass it on.
              </p>
            </div>
          ) : null}

          {loaded.kind === 'ready' && !url && link ? (
            <p className="text-sm">
              {link.expired
                ? `This branch had a preview link. It expired on ${until(link.expiresAt)} and shows nothing any more.`
                : `This branch has a preview link, made on ${DAY.format(new Date(link.createdAt))}. It works until ${until(link.expiresAt)}.`}{' '}
              Its address is not stored, so it cannot be shown again. A new link replaces it: the old address stops working at once.
            </p>
          ) : null}

          {loaded.kind === 'ready' && !url ? (
            <fieldset className="flex flex-col gap-2 text-sm" disabled={busy !== null}>
              <legend className="mb-1 font-medium">{link ? 'A new link works for' : 'The link works for'}</legend>
              <div className="flex gap-4">
                {DAYS.map((d) => (
                  <label key={d} className="flex items-center gap-2">
                    <input type="radio" name="preview-days" value={d} checked={days === d} onChange={() => setDays(d)} />
                    {d === 1 ? '1 day' : `${d} days`}
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            {loaded.kind === 'ready' && link ? (
              <Button type="button" variant="outline" onClick={() => void revoke()} disabled={busy !== null}>
                {busy === 'revoke' ? 'Revoking…' : link.expired ? 'Remove the expired link' : 'Revoke the link'}
              </Button>
            ) : null}
            {loaded.kind === 'ready' && !url ? (
              <Button type="button" onClick={() => void make()} disabled={busy !== null}>
                {busy === 'make' ? 'Making the link…' : link ? 'Make a new link' : 'Make the link'}
              </Button>
            ) : null}
            <Button type="button" variant={url ? 'default' : 'ghost'} onClick={() => setShown(false)} disabled={busy !== null}>
              {url ? 'Done' : 'Close'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

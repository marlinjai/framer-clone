// src/app/projects/ClosedBranch.tsx
//
// The old address of a merged or discarded site branch (docs/plans/2026-11-10-site-branches.md, section 3,
// "Afterwards"): what happened to it, when, and the way to its site. A closed branch is never reopened
// (decision 15). A merge can be undone for 30 days while it is the site's latest (slice S7): the merged work
// then moves to a new branch, and this page says so and links to it.

import React from 'react';
import type { ClosedBranchNotice } from '@/lib/sites/branches';
import UndoMerge from '@/components/branches/UndoMerge';

const DATE = new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeZone: 'UTC' });

export function closedBranchText(notice: ClosedBranchNotice): { title: string; body: string } {
  const when = notice.closedAt ? ` on ${DATE.format(new Date(notice.closedAt))}` : '';
  if (notice.status === 'merged' && notice.undoneInto) {
    const into = notice.undoneInto;
    return {
      title: `The merge of “${notice.name}” was undone`,
      body: `Its changes were merged into ${notice.mainName}${when}, and that merge was undone later: ${notice.mainName} went back to what it was before. ${
        into.open
          ? `The merged changes are on the branch${into.name ? ` “${into.name}”` : ''} now.`
          : `The merged changes went to a new branch${into.name ? `, “${into.name}”,` : ''} which has been merged or discarded since.`
      }`,
    };
  }
  return notice.status === 'merged'
    ? {
        title: `The branch “${notice.name}” was merged`,
        body: `Its changes were merged into ${notice.mainName}${when}. Edit the site itself from now on, or start a new branch there.`,
      }
    : {
        title: `The branch “${notice.name}” was discarded`,
        body: `It was discarded${when} and its changes are gone. ${notice.mainName} was not changed by it.`,
      };
}

export default function ClosedBranch({ notice }: { notice: ClosedBranchNotice }) {
  const text = closedBranchText(notice);
  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-12">
      <section aria-labelledby="closed-branch-title" className="rounded-lg border p-10 text-center">
        <h1 id="closed-branch-title" className="text-xl font-semibold tracking-tight">
          {text.title}
        </h1>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">{text.body}</p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          {notice.undoneInto?.open ? (
            <a
              href={`/projects/${encodeURIComponent(notice.undoneInto.branchId)}`}
              className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium hover:bg-accent"
            >
              Open the branch{notice.undoneInto.name ? ` “${notice.undoneInto.name}”` : ''}
            </a>
          ) : null}
          <a
            href={`/projects/${encodeURIComponent(notice.mainSiteId)}`}
            className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium hover:bg-accent"
          >
            Open {notice.mainName}
          </a>
        </div>
        {notice.status === 'merged' && notice.undoUntil ? (
          <UndoMerge
            mainSiteId={notice.mainSiteId}
            branchId={notice.branchId}
            branchName={notice.name}
            mainName={notice.mainName}
            undoUntil={notice.undoUntil}
          />
        ) : null}
      </section>
    </main>
  );
}

// src/app/projects/[projectId]/review/page.tsx
//
// The review of a site branch (docs/plans/2026-11-10-site-branches.md, section 3 "A reviewer", slice S5). The same
// guards as the editor: no session goes to the login, no company to the chooser, a foreign or missing id is a 404,
// and a merged or discarded branch says what happened. A main site has no review (404), and neither has a branch
// while site branches are off for the company. Anyone who may view the site may open it; the controls follow what
// the person may do.

import React from 'react';
import { notFound, redirect } from 'next/navigation';
import AuthUnavailable from '../../AuthUnavailable';
import ClosedBranch from '../../ClosedBranch';
import { loadProjectSnapshot } from '../loader';
import ReviewMount from './ReviewMount';

export const dynamic = 'force-dynamic';

interface ReviewPageProps {
  params: Promise<{ projectId: string }>;
}

export default async function ReviewPage({ params }: ReviewPageProps) {
  const { projectId } = await params;
  const result = await loadProjectSnapshot(projectId, '/review', { withMain: true });

  if (result.status === 'unauthenticated') redirect(result.loginUrl);
  if (result.status === 'auth_unavailable') {
    return <AuthUnavailable retryHref={`/projects/${encodeURIComponent(projectId)}/review`} />;
  }
  if (result.status === 'choose_company') redirect(result.chooserUrl);
  if (result.status === 'not_found') notFound();
  if (result.status === 'branch_closed') return <ClosedBranch notice={result.notice} />;
  if (result.branch?.kind !== 'branch' || !result.main) notFound();

  return (
    <ReviewMount
      branchId={projectId}
      branchName={result.branch.branch.name}
      mainSiteId={result.branch.mainSiteId}
      mainName={result.branch.mainName}
      branch={{ snapshot: result.snapshot, version: result.version }}
      main={result.main}
      can={result.can ?? null}
    />
  );
}

// src/components/PublishButton.tsx
//
// The editor top-bar Publish action. Serializes the live ProjectModel to a
// snapshot and POSTs it to the admin-guarded /api/projects/publish endpoint,
// which persists it and flips the site to `published`.
//
// Outcomes surface LOUDLY and never silently no-op:
//   - in-flight: the button shows "Publishing..." and is disabled,
//   - success: a brief confirmation (how many pages went live),
//   - failure: the structured server error message (or a network-error
//     message), shown until the next attempt.
//
// Before publishing it checks the legal pages (src/lib/legal/publishCheck.ts):
// a site with business data but no Impressum, or a legal page that still
// holds [placeholders], gets an in-page notice first (never a browser
// dialog) with a one-click "Create Impressum" (or "Open <page>") and
// "Publish anyway". A warning, not a gate.
'use client';

import React from 'react';
import { observer } from 'mobx-react-lite';
import { getSnapshot } from 'mobx-state-tree';
import { UploadCloud } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useStore } from '@/hooks/useStore';
import { markServerVersion } from '@/stores/openProject';
import { useSiteAddress } from '@/contexts/SiteAddressContext';
import { TopBarStatus } from './TopBarStatus';
import { checkBeforePublish, hasPublishIssues, type PublishCheck } from '@/lib/legal/publishCheck';

type PublishState =
  | { kind: 'idle' }
  | { kind: 'publishing' }
  | {
      kind: 'success';
      message: string;
      // The live URL (absolute) when the server could compose one, else null
      // (local dev with no PUBLIC_SITE_BASE_HOST). `liveLabel` is the
      // human-readable destination shown regardless (the bare subdomain when
      // there is no absolute URL).
      liveUrl: string | null;
      liveLabel: string | null;
    }
  | { kind: 'error'; message: string }
  | { kind: 'confirm'; check: PublishCheck };

const PublishButton = observer(() => {
  const rootStore = useStore();
  const project = rootStore.editorUI.currentProject;
  const { address, setAddress } = useSiteAddress();
  const isUnsavedDemo = rootStore.editorUI.isUnsavedDemo === true;
  const [state, setState] = React.useState<PublishState>({ kind: 'idle' });

  const publish = React.useCallback(async (skipChecks = false) => {
    if (!project) {
      setState({ kind: 'error', message: 'No project to publish.' });
      return;
    }
    // The demo editor at `/` builds its project in the browser; no company
    // holds it, so there is nothing on the server to publish to.
    if (isUnsavedDemo) {
      setState({
        kind: 'error',
        message: 'This demo project exists only in this browser. Save it as a project first (Save), then publish it from there.',
      });
      return;
    }
    if (!skipChecks) {
      const check = checkBeforePublish(
        project.site.business,
        project.pagesArray.map((p) => ({
          id: p.id,
          slug: p.slug,
          metadata: { title: p.metadata.title, legalTemplate: p.metadata.legalTemplate },
          tree: getSnapshot(p.appComponentTree) as Parameters<typeof checkBeforePublish>[1][number]['tree'],
        })),
      );
      if (hasPublishIssues(check)) {
        setState({ kind: 'confirm', check });
        return;
      }
    }
    setState({ kind: 'publishing' });
    try {
      const snapshot = getSnapshot(project);
      const res = await fetch('/api/projects/publish', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project: snapshot }),
      });
      const payload: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const message =
          (payload as { error?: { message?: string } } | null)?.error?.message ??
          `Publish failed (${res.status}).`;
        setState({ kind: 'error', message });
        return;
      }
      // The server now holds exactly these pages (see openProject).
      markServerVersion(project.id, (snapshot as { pages?: unknown }).pages);
      const ok = payload as
        | { publishedPages?: unknown; liveUrl?: unknown; subdomain?: unknown }
        | null;
      const published = ok?.publishedPages;
      const count = Array.isArray(published) ? published.length : 0;
      // Prefer the absolute liveUrl; in local dev (no base host) the server
      // returns liveUrl:null but STILL carries the allocated subdomain — show
      // that as the destination label so publish never reads as "done, nowhere".
      const liveUrl = typeof ok?.liveUrl === 'string' ? ok.liveUrl : null;
      const subdomain = typeof ok?.subdomain === 'string' ? ok.subdomain : null;
      const liveLabel =
        liveUrl?.replace(/^https?:\/\//, '') ?? subdomain ?? null;
      // The site now lives somewhere: tell the page settings panel, keeping a
      // custom domain the loader already reported over the platform address.
      let liveHost: string | null = null;
      try {
        liveHost = liveUrl ? new URL(liveUrl).host : null;
      } catch {
        liveHost = null;
      }
      setAddress({ host: address.host ?? liveHost, everPublished: true });
      setState({
        kind: 'success',
        message: `Published ${count} ${count === 1 ? 'page' : 'pages'}.`,
        liveUrl,
        liveLabel,
      });
    } catch (err) {
      setState({
        kind: 'error',
        message:
          err instanceof Error ? err.message : 'Network error while publishing.',
      });
    }
  }, [project, address.host, setAddress, isUnsavedDemo]);

  const publishing = state.kind === 'publishing';

  const createImpressum = () => {
    if (!project) return;
    const { page } = project.createLegalPage('impressum');
    rootStore.editorUI.setCurrentPage(page);
    setState({ kind: 'idle' });
  };
  const openPage = (pageId: string) => {
    const page = project?.getPage(pageId);
    if (page) rootStore.editorUI.setCurrentPage(page);
    setState({ kind: 'idle' });
  };

  return (
    <div className="flex items-center gap-2 mr-1 lg:mr-2">
      {state.kind === 'success' && (
        <TopBarStatus
          kind="success"
          title={state.message}
          onDismiss={() => setState({ kind: 'idle' })}
          inlineMaxWidth="lg:max-w-[280px]"
          toneClassName="text-brand"
          persist={!!state.liveUrl}
        >
          <span className="lg:truncate">{state.message}</span>
          {state.liveLabel && (
            <>
              <span className="text-muted-foreground">·</span>
              {state.liveUrl ? (
                <a
                  href={state.liveUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="underline lg:truncate hover:text-brand/80"
                  title={`live at ${state.liveLabel}`}
                >
                  live at {state.liveLabel}
                </a>
              ) : (
                <span className="lg:truncate" title={`live at ${state.liveLabel}`}>
                  live at {state.liveLabel}
                </span>
              )}
            </>
          )}
        </TopBarStatus>
      )}
      {state.kind === 'error' && (
        <TopBarStatus kind="error" title={state.message} onDismiss={() => setState({ kind: 'idle' })}>
          <span className="lg:truncate">{state.message}</span>
        </TopBarStatus>
      )}
      {state.kind === 'confirm' && (
        <PublishLegalNotice
          check={state.check}
          onCreateImpressum={createImpressum}
          onOpenPage={openPage}
          onPublishAnyway={() => void publish(true)}
          onCancel={() => setState({ kind: 'idle' })}
        />
      )}
      <Button
        type="button"
        variant="brand"
        size="sm"
        onClick={() => void publish()}
        disabled={publishing}
        title="Publish this site"
      >
        <UploadCloud size={16} />
        {publishing ? 'Publishing...' : 'Publish'}
      </Button>
    </div>
  );
});

PublishButton.displayName = 'PublishButton';

interface PublishLegalNoticeProps {
  check: PublishCheck;
  onCreateImpressum: () => void;
  onOpenPage: (pageId: string) => void;
  onPublishAnyway: () => void;
  onCancel: () => void;
}

/**
 * The in-page notice before publishing: what is missing, the one-click fix,
 * and "Publish anyway". Takes focus when it appears (the owner just clicked
 * Publish and must read it) and closes on Escape.
 */
function PublishLegalNotice({ check, onCreateImpressum, onOpenPage, onPublishAnyway, onCancel }: PublishLegalNoticeProps) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    ref.current?.focus();
  }, []);
  const first = check.placeholders[0];
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="false"
      aria-labelledby="publish-legal-title"
      aria-describedby="publish-legal-text"
      tabIndex={-1}
      data-editor-ui="true"
      data-testid="publish-legal-notice"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onCancel();
        }
      }}
      className="fixed right-4 top-16 phone:top-12 z-100 mt-2 flex w-[360px] max-w-[calc(100vw-32px)] flex-col gap-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950 shadow-lg outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
    >
      <p id="publish-legal-title" className="text-[13px] font-semibold">
        {check.missingImpressum ? 'Your site has no Impressum yet' : 'Your legal pages still have placeholders'}
      </p>
      <div id="publish-legal-text" className="flex flex-col gap-1.5">
        {check.missingImpressum && (
          <p>
            German law requires an Impressum on a business website. Create one from your business details in one click,
            then review it.
          </p>
        )}
        {check.placeholders.length > 0 && (
          <ul className="list-disc pl-4">
            {check.placeholders.map((p) => (
              <li key={p.pageId}>
                {p.title}: {p.count} {p.count === 1 ? 'part' : 'parts'} in [square brackets] to fill in or delete
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onPublishAnyway}>
          Publish anyway
        </Button>
        {check.missingImpressum ? (
          <Button type="button" variant="brand" size="sm" onClick={onCreateImpressum}>
            Create Impressum
          </Button>
        ) : first ? (
          <Button type="button" variant="brand" size="sm" onClick={() => onOpenPage(first.pageId)}>
            Open {first.title}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
export default PublishButton;

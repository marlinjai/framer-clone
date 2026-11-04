// src/components/PublishButton.tsx
//
// The editor top-bar Publish action. Serializes the live ProjectModel to a
// snapshot and POSTs it to the admin-guarded /api/projects/publish endpoint,
// which persists it and flips the site to `published`.
//
// Outcomes surface LOUDLY and never silently no-op:
//   - in-flight: the button shows "Publishing…" and is disabled,
//   - success: a brief confirmation (how many pages went live),
//   - conflict: the project was saved somewhere else since this tab loaded it
//     (409 `site_changed`, the version lock): SiteChangedDialog asks whether to
//     load the newer version, publish this one over it, or keep both (autosave
//     stops for the project too, until a write of this tab succeeds),
//   - failure: the structured server error message (or a network-error
//     message), shown until the next attempt.
//
// Before publishing it checks the legal pages (src/lib/legal/publishCheck.ts):
// a site with business data but no Impressum, or a legal page that still
// holds [placeholders], or a Google Maps embed the privacy policy does not
// name, gets an in-page notice first (never a browser dialog) with a one-click
// "Create Impressum" (or "Open <page>", "Create privacy policy"), the suggested
// Google Maps wording, and "Publish anyway". A warning, not a gate.
'use client';

import React from 'react';
import { observer } from 'mobx-react-lite';
import { getSnapshot } from 'mobx-state-tree';
import { UploadCloud } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useStore } from '@/hooks/useStore';
import { knownServerVersion, markServerVersion, type ProjectContent } from '@/stores/openProject';
import { postProjectWrite } from '@/lib/projects/projectWrite';
import { abandonWorkingCopy, existingAutosave, reloadDiscarding } from '@/lib/projects/autosave';
import SiteChangedDialog from './SiteChangedDialog';
import SaveAsNewProjectDialog from './SaveAsNewProjectDialog';
import { useSiteAddress } from '@/contexts/SiteAddressContext';
import { TopBarStatus } from './TopBarStatus';
import { checkBeforePublish, hasPublishIssues, type PublishCheck } from '@/lib/legal/publishCheck';
import type { LegalKind } from '@/lib/legal/legalPages';
import { GoogleMapsPrivacyHint } from '@/components/site/GoogleMapsPrivacyHint';

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
  | { kind: 'confirm'; check: PublishCheck }
  // Refused by the version lock: the server is at `currentVersion`.
  | { kind: 'conflict'; currentVersion: number; retrying: boolean };

const PublishButton = observer(() => {
  const rootStore = useStore();
  const project = rootStore.editorUI.currentProject;
  const { address, setAddress } = useSiteAddress();
  const isUnsavedDemo = rootStore.editorUI.isUnsavedDemo === true;
  const [state, setState] = React.useState<PublishState>({ kind: 'idle' });
  const [saveAsOpen, setSaveAsOpen] = React.useState(false);

  // `overVersion`: publish over the server's copy on purpose ("Publish mine
  // anyway"), naming the version the refusal reported. The legal checks already
  // ran for this attempt then.
  const publish = React.useCallback(async (skipChecks = false, overVersion?: number) => {
    if (!project) {
      setState({ kind: 'error', message: 'No project to publish.' });
      return;
    }
    // The demo editor at `/` builds its project in the browser; no company
    // holds it, so there is nothing on the server to publish to.
    if (isUnsavedDemo) {
      setState({
        kind: 'error',
        message: 'This demo project exists only in this browser. Keep it as a project first (Keep as project), then publish it from there.',
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
          snapshot: getSnapshot(p),
        })),
        { definitions: project.definitions, refused: project.refusedComponents },
      );
      if (hasPublishIssues(check)) {
        setState({ kind: 'confirm', check });
        return;
      }
    }
    setState((prev) =>
      overVersion !== undefined && prev.kind === 'conflict' ? { ...prev, retrying: true } : { kind: 'publishing' },
    );
    // Autosave (src/lib/projects/autosave.ts) is held while this runs: a save in
    // flight finishes first and none starts meanwhile, so the version lock sees
    // one writer from this tab. The snapshot is taken after that wait.
    const autosave = existingAutosave(project.id);
    const write = async () => {
      const snapshot = getSnapshot(project);
      // The edits refused up to this snapshot are the ones this publish leaves out.
      const acknowledged = [...project.refusedComponents];
      const expectedVersion = overVersion ?? knownServerVersion(project.id);
      // A save of this tab whose answer was lost (and whose settling retry failed
      // too) may be the latest write: name it, so Publish builds on it instead of
      // meeting it as someone else's change (the server checks the key is bound
      // to the current version).
      const lost = autosave?.lostAttemptKeys(expectedVersion) ?? [];
      const result = await postProjectWrite('/api/projects/publish', snapshot, expectedVersion, 'Publish failed', {
        ...(lost.length > 0 ? { previousRequestKeys: lost } : {}),
      });
      if (result.kind === 'conflict') autosave?.noteConflict(result.currentVersion);
      else if (result.kind === 'error' && result.writtenVersion !== undefined) {
        markServerVersion(project.id, snapshot as ProjectContent, result.writtenVersion);
      } else if (result.kind === 'ok') {
        // The server now holds exactly this project, at this version (see openProject).
        markServerVersion(project.id, snapshot as ProjectContent, result.version);
      }
      return { result, acknowledged };
    };
    try {
      const { result, acknowledged } = autosave ? await autosave.exclusive(write) : await write();
      if (result.kind === 'conflict') {
        setState({ kind: 'conflict', currentVersion: result.currentVersion, retrying: false });
        return;
      }
      if (result.kind === 'error') {
        // Published, but a later step failed: this snapshot is what the server
        // holds (marked inside `write`), so the next save (autosave) must not meet it as
        // someone else's change.
        setState({ kind: 'error', message: result.message });
        return;
      }
      project.clearRefusedEdits(acknowledged);
      const ok = result.payload as { publishedPages?: unknown; liveUrl?: unknown; subdomain?: unknown };
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

  const publishing = state.kind === 'publishing' || (state.kind === 'conflict' && state.retrying);

  const createLegal = (kind: LegalKind) => {
    if (!project) return;
    const { page } = project.createLegalPage(kind);
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
          language={project?.site.language ?? 'en'}
          onCreateLegal={createLegal}
          onOpenPage={openPage}
          onPublishAnyway={() => void publish(true)}
          onCancel={() => setState({ kind: 'idle' })}
        />
      )}
      <SiteChangedDialog
        open={state.kind === 'conflict'}
        action="publish"
        busy={state.kind === 'conflict' && state.retrying}
        onKeepEditing={() => setState({ kind: 'idle' })}
        onLoadNewer={() => reloadDiscarding(project?.id)}
        onKeepMine={() => {
          if (state.kind === 'conflict') void publish(true, state.currentVersion);
        }}
        onSaveAsNew={() => {
          setState({ kind: 'idle' });
          setSaveAsOpen(true);
        }}
      />
      {/* Mounted only while asked for: it is the conflict's "keep both" choice. */}
      {project && !isUnsavedDemo && saveAsOpen ? (
        <SaveAsNewProjectDialog
          open={saveAsOpen}
          onOpenChange={setSaveAsOpen}
          defaultName={`${project.metadata.title || 'Untitled Project'} (copy)`}
          getSnapshot={() => getSnapshot(project) as unknown as { pages: Record<string, unknown>; components: Record<string, unknown> }}
          currentPageId={rootStore.editorUI.currentPage?.id}
          description="Keeps both versions: this tab's pages and components become a new project in your company, and it opens in the editor. Nothing is published; the project changed elsewhere stays as it is."
          // The original's working copy now lives on as the new project: give it up here.
          onSaved={() => abandonWorkingCopy(project.id)}
        />
      ) : null}
      <Button
        type="button"
        variant="brand"
        size="sm"
        onClick={() => void publish()}
        disabled={publishing}
        title="Publish this site"
      >
        <UploadCloud size={16} />
        {publishing ? 'Publishing…' : 'Publish'}
      </Button>
    </div>
  );
});

PublishButton.displayName = 'PublishButton';

interface PublishLegalNoticeProps {
  check: PublishCheck;
  /** The site language, for the suggested Google Maps wording. */
  language: string;
  onCreateLegal: (kind: LegalKind) => void;
  onOpenPage: (pageId: string) => void;
  onPublishAnyway: () => void;
  onCancel: () => void;
}

/**
 * The in-page notice before publishing: what is missing, the one-click fix,
 * and "Publish anyway". Takes focus when it appears (the owner just clicked
 * Publish and must read it) and closes on Escape.
 */
function PublishLegalNotice({ check, language, onCreateLegal, onOpenPage, onPublishAnyway, onCancel }: PublishLegalNoticeProps) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    ref.current?.focus();
  }, []);
  const first = check.placeholders[0] ?? check.components.find((issue) => issue.pageId !== undefined);
  const maps = check.maps && check.maps.status !== 'named' ? check.maps : null;
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
        {check.missingImpressum
          ? 'Your site has no Impressum yet'
          : maps
            ? 'Your privacy policy must name Google Maps'
            : check.placeholders.length > 0
            ? 'Your legal pages still have placeholders'
            : 'Some components will not show'}
      </p>
      <div id="publish-legal-text" className="flex flex-col gap-1.5">
        {check.missingImpressum && (
          <p>
            German law requires an Impressum on a business website. Create one from your business details in one click,
            then review it.
          </p>
        )}
        {maps && (
          <GoogleMapsPrivacyHint
            language={language}
            check={maps}
            onCreatePrivacy={() => onCreateLegal('privacy')}
            onOpenPrivacy={maps.privacyPageId ? () => onOpenPage(maps.privacyPageId as string) : undefined}
          />
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
        {check.components.length > 0 && (
          <ul className="list-disc pl-4">
            {check.components.map((issue) => (
              <li key={`${issue.pageId ?? issue.title}:${issue.message}`}>
                {issue.title}: {issue.message}
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
          <Button type="button" variant="brand" size="sm" onClick={() => onCreateLegal('impressum')}>
            Create Impressum
          </Button>
        ) : first?.pageId ? (
          <Button type="button" variant="brand" size="sm" onClick={() => onOpenPage(first.pageId as string)}>
            Open {first.title}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
export default PublishButton;

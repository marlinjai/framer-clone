'use client';

// /preview: the preview of the standalone demo editor's project (`/`), and the
// legacy entry point for previews.
//
// The demo project exists only in this browser tab's store (it is held by no
// company), so it cannot use the id-aware /projects/<id>/preview route, which
// loads from the server: that answered 404. Here it previews straight from the
// store, on the page given by `?page=`. Any other project the store holds is
// sent to its own preview route, parameters kept. With nothing to preview (a
// full reload drops the in-browser demo), the page says so and offers the way
// on, instead of a blank screen or a 404.

import dynamic from 'next/dynamic';
import Link from 'next/link';
import React, { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useStore } from '@/hooks/useStore';
import { pageIdFromLocation, pickPage } from '@/stores/openProject';

const PreviewShell = dynamic(() => import('@/components/preview/PreviewShell'), { ssr: false });

type Mode =
  | { kind: 'pending' }
  | { kind: 'demo'; missingPageId?: string }
  | { kind: 'empty' };

function DemoPreview() {
  const router = useRouter();
  const rootStore = useStore();
  const [mode, setMode] = useState<Mode>({ kind: 'pending' });
  const decided = useRef(false);

  useEffect(() => {
    if (decided.current) return;
    decided.current = true;
    const { editorUI, projectStore } = rootStore;
    const demo = editorUI.demoProjectId ? projectStore.getProject(editorUI.demoProjectId) : undefined;
    const requestedPageId = pageIdFromLocation();
    // A dashboard project open in this tab wins (an old link to /preview);
    // the demo only when it is what is open, or nothing else is.
    const current = editorUI.currentProject;
    if (current && current.id !== demo?.id) {
      router.replace(`/projects/${encodeURIComponent(current.id)}/preview${window.location.search}`);
      return;
    }
    if (demo) {
      editorUI.setCurrentProject(demo);
      const { page, missingPageId } = pickPage(demo, requestedPageId);
      editorUI.setCurrentPage(page);
      setMode({ kind: 'demo', missingPageId });
      return;
    }
    setMode({ kind: 'empty' });
  }, [rootStore, router]);

  if (mode.kind === 'demo') return <PreviewShell missingPageId={mode.missingPageId} />;
  if (mode.kind === 'empty') {
    return (
      <main className="flex h-screen w-screen flex-col items-center justify-center gap-3 bg-gray-900 px-6 text-center text-gray-300">
        <h1 className="text-base font-medium text-gray-100">Nothing to preview</h1>
        <p className="max-w-md text-sm">
          The demo project lives only in the browser tab it was made in, and is gone after a full
          reload. To keep your work, use Save in the editor: it saves the demo as a new project.
        </p>
        <div className="flex gap-4 text-sm">
          <Link href="/projects" className="text-brand hover:underline">
            Your projects
          </Link>
          <Link href="/" className="text-brand hover:underline">
            Open the demo editor
          </Link>
        </div>
      </main>
    );
  }
  return null;
}

export default function PreviewPage() {
  return (
    <Suspense fallback={null}>
      <DemoPreview />
    </Suspense>
  );
}

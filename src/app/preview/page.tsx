'use client';

// Legacy `/preview` is now a thin client redirect to the id-aware preview
// route (MT-11): `/projects/<currentProjectId>/preview`. The in-memory editor
// sets `editorUI.currentProject` before the TopBar Preview button navigates
// here, so we read that id client-side and replace into the scoped route. This
// keeps the existing Preview button working until MT-12 repoints the chrome at
// the id-aware URL directly; this file owns NO preview UI of its own anymore.
//
// If no project is loaded (someone hit `/preview` cold), there is nothing to
// preview — bounce to the projects dashboard rather than dead-end.

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useStore } from '@/hooks/useStore';

export default function PreviewRedirectPage() {
  const router = useRouter();
  const rootStore = useStore();

  useEffect(() => {
    const projectId = rootStore.editorUI.currentProject?.id;
    router.replace(projectId ? `/projects/${projectId}/preview` : '/projects');
  }, [router, rootStore]);

  return null;
}

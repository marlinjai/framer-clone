// The browser side of the editor's Unpublish proof: the real PublishedVersionsButton and its dialog, on the
// real store with a stored project open. (The editor bundle opens the demo project, for which the button
// is deliberately absent.) The project and its version are set on `window` before the bundle runs.

import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import PublishedVersionsButton from '@/components/PublishedVersionsButton';
import { useStore } from '@/hooks/useStore';
import { openProject } from '@/stores/openProject';

const w = window as unknown as { __PROJECT__: Parameters<typeof openProject>[1] };
function Probe() {
  const store = useStore();
  useState(() => openProject(store, w.__PROJECT__, null, 1));
  return <PublishedVersionsButton />;
}

const root = document.getElementById('root');
if (!root) throw new Error('the probe page has no #root');
createRoot(root).render(<Probe />);

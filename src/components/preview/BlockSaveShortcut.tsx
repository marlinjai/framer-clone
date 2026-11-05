// src/components/preview/BlockSaveShortcut.tsx
//
// The standalone preview (/preview) has nothing to save: Cmd/Ctrl+S there only
// keeps the browser's "save page" dialog away, in the capture phase like the
// editor's own shortcut (src/lib/projects/saveShortcut.ts). Edits are saved by
// the editor, which the preview leads back to.
'use client';

import React from 'react';
import { resolveAction } from '@/lib/keyBindings';

export default function BlockSaveShortcut() {
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (resolveAction(event)?.action === 'save') event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);
  return null;
}

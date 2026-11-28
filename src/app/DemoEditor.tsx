'use client';
// src/app/DemoEditor.tsx
//
// The browser-only demo editor (`/?demo=1`, src/lib/projects/demoAddress.ts),
// loaded on the client only: the editor UI has no server render.
import React from 'react';
import dynamic from 'next/dynamic';

const EditorApp = dynamic(() => import('../components/EditorApp'), { ssr: false });
// The demo itself never autosaves; projects of this tab opened before still warn.
const UnsavedWorkGuard = dynamic(() => import('../components/UnsavedWorkGuard'), { ssr: false });

export default function DemoEditor() {
  return (
    <>
      <EditorApp />
      <UnsavedWorkGuard />
    </>
  );
}
// ci-replay touch

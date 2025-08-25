'use client'
// Server component: loads editor purely on client (no SSR for editor UI)
import dynamic from 'next/dynamic';

const EditorApp = dynamic(() => import('../components/EditorApp'), { ssr: false });

export default function Page() {
  return <EditorApp />;
}
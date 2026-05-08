'use client';
// Client-only preview route. Mirrors src/app/page.tsx by dynamically loading
// the shell with ssr:false so MST + browser-only renderer code stays out of
// the SSR pass.
import dynamic from 'next/dynamic';

const PreviewShell = dynamic(
  () => import('@/components/preview/PreviewShell'),
  { ssr: false },
);

export default function PreviewPage() {
  return <PreviewShell />;
}

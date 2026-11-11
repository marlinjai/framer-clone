'use client';

// src/app/projects/[projectId]/review/ReviewMount.tsx
//
// The review screen, in the browser only: its panes draw into shadow roots (ReviewPane.tsx).

import dynamic from 'next/dynamic';
import type { ReviewScreenProps } from '@/components/branches/review/ReviewScreen';

const ReviewScreen = dynamic(() => import('@/components/branches/review/ReviewScreen').then((m) => m.ReviewScreen), {
  ssr: false,
  loading: () => <p className="p-8 text-sm text-muted-foreground">Opening the review…</p>,
});

export default function ReviewMount(props: ReviewScreenProps) {
  return <ReviewScreen {...props} />;
}

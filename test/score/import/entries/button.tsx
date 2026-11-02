// Original side of the button import fixture: the real component, mounted as an app would use it.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Button } from '@/components/ui/button';

createRoot(document.getElementById('root') as HTMLElement).render(
  <Button>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M5 12h14" />
    </svg>
    Continue
  </Button>,
);

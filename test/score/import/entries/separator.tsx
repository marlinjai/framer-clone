// Original side of the separator import fixture: the real component, mounted as an app would use it.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Separator } from '@/components/ui/separator';

createRoot(document.getElementById('root') as HTMLElement).render(
  <Separator />,
);

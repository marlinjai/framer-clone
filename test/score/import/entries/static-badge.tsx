// Original side of the static-badge import fixture: the real component, mounted as an app would use it.
import React from 'react';
import { createRoot } from 'react-dom/client';
import Badge from '../fixtures/static-badge';

createRoot(document.getElementById('root') as HTMLElement).render(
  <Badge />,
);

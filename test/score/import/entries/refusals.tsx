// Original side of the refusals import fixture: the real component, mounted as an app would use it.
import React from 'react';
import { createRoot } from 'react-dom/client';
import Refusals from '../fixtures/refusals';

createRoot(document.getElementById('root') as HTMLElement).render(
  <Refusals tone="secondary" />,
);

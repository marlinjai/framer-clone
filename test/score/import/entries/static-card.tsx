// Original side of the static-card import fixture: the real component, mounted as an app would use it.
import React from 'react';
import { createRoot } from 'react-dom/client';
import Card from '../fixtures/static-card';

createRoot(document.getElementById('root') as HTMLElement).render(
  <Card />,
);

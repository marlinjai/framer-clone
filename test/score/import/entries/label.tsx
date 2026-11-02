// Original side of the label import fixture: the real component, mounted as an app would use it.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Label } from '@/components/ui/label';

createRoot(document.getElementById('root') as HTMLElement).render(
  <Label htmlFor="email">Email</Label>,
);

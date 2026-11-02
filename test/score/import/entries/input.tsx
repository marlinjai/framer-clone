// Original side of the input import fixture: the real component, mounted as an app would use it.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Input } from '@/components/ui/input';

createRoot(document.getElementById('root') as HTMLElement).render(
  <Input placeholder="Email" />,
);
